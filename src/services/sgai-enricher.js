'use strict';

/**
 * ScrapeGraphAI Enricher
 *
 * Uses the ScrapeGraphAI cloud API to extract rich podcast metadata
 * (host name, contact info, social links, topics, description) from a
 * podcast's website URL. Results are cached in the FAPIO database so
 * multiple customers benefit from the same enrichment.
 *
 * Free plan: 500 credits. Each extraction costs ~12-20 credits,
 * yielding ~25-40 enrichments before a paid upgrade is needed.
 */

const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const axios    = require('axios');

const SGAI_API_KEY = process.env.SGAI_API_KEY || 'sgai-e0b005e5-e217-4f97-9188-308fc738d57b';
const SGAI_ENDPOINT = 'https://v2-api.scrapegraphai.com/api/extract';

const ENRICH_TIMEOUT_MS = 45_000; // SGAI cloud API can take 10-30s

// ── Prompt used for every extraction —───────────────────────────────────────
const EXTRACT_PROMPT = `Extract structured data about this podcast. Return ONLY a valid JSON object (no markdown, no code fences) with these fields:

{
  "host_name": "Full name of the podcast host(s)",
  "contact_email": "Contact or booking email address if visible on the page",
  "description": "2-3 sentence summary of what this podcast is about",
  "topics": ["topic1", "topic2", "topic3"],
  "instagram_url": "Full URL to the podcast's Instagram profile if present",
  "twitter_url": "Full URL to the podcast's Twitter/X profile if present",
  "linkedin_url": "Full URL to the host or show's LinkedIn profile if present",
  "facebook_url": "Full URL to the podcast's Facebook page if present",
  "youtube_url": "Full URL to the podcast's YouTube channel if present",
  "tiktok_url": "Full URL to the podcast's TikTok profile if present",
  "soundcloud_url": "Full URL to the podcast's SoundCloud profile if present",
  "booking_page_url": "Full URL to a guest booking / appear-on page if one exists",
  "guest_application_url": "Full URL to a guest application form if one exists"
}

★★★★★ CRITICAL RULES — VIOLATING THESE WASTES MONEY ★★★★★
1. NEVER fabricate or guess social media URLs. Only return a URL if you SEE it literally on the page (an <a href="..."> linking to instagram.com, twitter.com, etc.).
2. NEVER return a URL that doesn't match the platform. E.g., if you find a YouTube link, put it in youtube_url, NOT in instagram_url.
3. If a social media page or link is NOT visibly present on the page, return null for that field. Do not guess.
4. For host_name: return the actual person name (e.g. "Steve Siebold"), NOT the podcast title or a description. If no person's name is found, return null.
5. For topics: only include topics that are explicitly mentioned or clearly the theme of the show. A general phrase like "helping people" is not a topic.
6. For contact_email: only return an email address you actually SEE written out on the page. Do not guess or construct one.`;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Enrich a single podcast by ID using ScrapeGraphAI.
 *
 * @param {string} podcastId - UUID of the podcast to enrich
 * @returns {Promise<{ok: boolean, enriched: object|null, error?: string}>}
 */
async function enrichPodcastWithSGAI(podcastId) {
  if (!podcastId) {
    return { ok: false, error: 'podcastId_required' };
  }

  // 1. Fetch podcast from DB
  const { data: podcast, error: dbError } = await supabase
    .from('podcasts')
    .select('id, title, website, url, apple_url, spotify_url, enriched_at, host_name, contact_email')
    .eq('id', podcastId)
    .single();

  if (dbError || !podcast) {
    logger.warn('SGAI enricher: podcast not found', { podcastId, error: dbError?.message });
    return { ok: false, error: 'podcast_not_found' };
  }

  // 2. Determine which URL to scrape (prefer website, then url/rss, then apple/spotify)
  const targetUrl = podcast.website || podcast.url || podcast.apple_url || podcast.spotify_url || null;

  if (!targetUrl) {
    logger.warn('SGAI enricher: no URL to scrape', { podcastId, title: podcast.title });
    return { ok: false, error: 'no_url_available' };
  }

  // 3. Call ScrapeGraphAI
  let extractResult;
  try {
    extractResult = await callSGAI(targetUrl);
  } catch (err) {
    logger.error('SGAI enricher: API call failed', { podcastId, error: err.message });
    return { ok: false, error: `sgai_api_error: ${err.message}` };
  }

  if (!extractResult || Object.keys(extractResult).length === 0) {
    logger.warn('SGAI enricher: empty result', { podcastId, url: targetUrl });
    return { ok: false, error: 'empty_result' };
  }

  // 4. Build patch — only fill fields that are currently null/missing
  const patch = {};
  const fields = [
    { key: 'host_name',             src: extractResult.host_name },
    { key: 'contact_email',         src: extractResult.contact_email },
    { key: 'description',           src: extractResult.description },
    { key: 'instagram_url',         src: extractResult.instagram_url },
    { key: 'twitter_url',           src: extractResult.twitter_url },
    { key: 'linkedin_page_url',     src: extractResult.linkedin_url },
    { key: 'facebook_url',          src: extractResult.facebook_url },
    { key: 'youtube_url',           src: extractResult.youtube_url },
    { key: 'tiktok_url',            src: extractResult.tiktok_url },
    { key: 'soundcloud_url',        src: extractResult.soundcloud_url },
    { key: 'booking_page_url',      src: extractResult.booking_page_url },
    { key: 'guest_application_url', src: extractResult.guest_application_url },
  ];

  // Map topics/niche_tags specially
  const topics = Array.isArray(extractResult.topics) ? extractResult.topics : [];
  const nicheTags = topics.map(t => t.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim()).filter(Boolean);

  for (const f of fields) {
    if (f.src && typeof f.src === 'string' && f.src.trim() && !podcast[f.key]) {
      patch[f.key] = f.src.trim();
    }
  }

  // Handle niche_tags — merge new SGAI topics with any existing tags
  if (nicheTags.length > 0) {
    const existingTags = Array.isArray(podcast.niche_tags) ? podcast.niche_tags : [];
    const merged = [...new Set([...existingTags, ...nicheTags])];
    patch.niche_tags = merged;
  }

  // ── Host name verification ────────────────────────────────────────────
  // If SGAI returned a host_name that looks like a brand/company name,
  // run a second-pass SGAI call focused specifically on finding the PERSON
  // who hosts the show. If that fails, fallback to the podcast title.
  if (patch.host_name && looksLikeBrandName(patch.host_name, podcast.title)) {
    logger.info('SGAI host_name looks like a brand — running verification', {
      podcastId,
      host_name: patch.host_name,
      title: podcast.title,
    });

    const verifiedName = await verifyHostName(targetUrl);

    if (verifiedName && !looksLikeBrandName(verifiedName, podcast.title)) {
      logger.info('Host name verification: replaced brand name with person name', {
        podcastId,
        old: patch.host_name,
        new: verifiedName,
      });
      patch.host_name = verifiedName;
    } else {
      // Fallback to podcast title if no person name could be verified
      const fallback = podcast.title || null;
      logger.info('Host name verification: no person found, falling back to title', {
        podcastId,
        original: patch.host_name,
        fallback,
      });
      patch.host_name = fallback;
    }
  }

  // Always update enriched_at to track when SGAI enrichment ran
  patch.enriched_at = new Date().toISOString();

  // Skip DB write if nothing to patch beyond the timestamp
  const hasDataChanges = Object.keys(patch).some(k => k !== 'enriched_at');

  if (hasDataChanges) {
    const { error: updateError } = await supabase
      .from('podcasts')
      .update(patch)
      .eq('id', podcastId);

    if (updateError) {
      logger.error('SGAI enricher: DB update failed', { podcastId, error: updateError.message });
      return { ok: false, error: 'db_update_failed' };
    }
  } else {
    // Still update the timestamp so we know we tried
    await supabase
      .from('podcasts')
      .update({ enriched_at: patch.enriched_at })
      .eq('id', podcastId);
  }

  logger.info('SGAI enrichment complete', {
    podcastId,
    title: podcast.title,
    fieldsFound: Object.keys(patch).filter(k => k !== 'enriched_at'),
  });

  return {
    ok: true,
    enriched: {
      ...patch,
      niche_tags: patch.niche_tags || null,
    },
  };
}

/**
 * Enrich a batch of podcasts belonging to a client.
 * Processes sequentially to avoid rate-limiting the free SGAI plan.
 *
 * @param {string[]} podcastIds - Array of podcast UUIDs
 * @param {number}   [max=5]    - Max to process in one call
 * @returns {Promise<{ok: boolean, results: Array}>}
 */
async function enrichBatch(podcastIds, max = 5) {
  const ids = (podcastIds || []).slice(0, max);
  const results = [];

  for (const id of ids) {
    const result = await enrichPodcastWithSGAI(id);
    results.push({ podcastId: id, ...result });
  }

  return { ok: true, results };
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Call the ScrapeGraphAI v2 extraction API.
 *
 * @param {string} url - Website URL to scrape
 * @returns {Promise<object|null>} Parsed extraction result or null
 */
async function callSGAI(url) {
  if (!url) return null;

  // Validate URL
  try {
    new URL(url);
  } catch {
    logger.warn('SGAI: invalid URL', { url });
    return null;
  }

  try {
    const response = await axios.post(
      SGAI_ENDPOINT,
      {
        url: url,
        prompt: EXTRACT_PROMPT,
      },
      {
        headers: {
          'SGAI-APIKEY': SGAI_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: ENRICH_TIMEOUT_MS,
      }
    );

    // SGAI returns { content: { ... } } or { result: "..." } or similar
    return parseSGAIResponse(response.data, url);
  } catch (err) {
    // Axios wraps network/timeout errors properly
    if (err.response) {
      const status = err.response.status;
      const body = err.response.data;
      logger.error('SGAI API HTTP error', { url, status, body });
      throw new Error(`sgai_http_${status}`);
    }
    if (err.code === 'ECONNABORTED') {
      logger.error('SGAI API timeout', { url });
      throw new Error('sgai_timeout');
    }
    throw err;
  }
}

/**
 * Parse the SGAI API response body into a structured object.
 * Handles multiple response formats (content object, result string, etc.).
 */
function parseSGAIResponse(data, url) {
  if (!data) return null;

  logger.debug('SGAI raw response', { url, type: typeof data });

  // Format 0: { json: { host_name: ..., ... } } — SGAI v2 response format
  if (data.json && typeof data.json === 'object' && !Array.isArray(data.json)) {
    return data.json;
  }

  // Format 1: { content: { host_name: ..., ... } }
  if (data.content && typeof data.content === 'object' && !Array.isArray(data.content)) {
    return data.content;
  }

  // Format 2: { content: "..." } — JSON string inside content
  if (data.content && typeof data.content === 'string') {
    try {
      const parsed = JSON.parse(data.content);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Not JSON — try to extract fields from the text
      logger.debug('SGAI content is non-JSON text, skipping', { url });
    }
  }

  // Format 3: { result: "..." }
  if (data.result && typeof data.result === 'string') {
    try {
      const parsed = JSON.parse(data.result);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Not JSON
    }
  }

  // Format 4: Top-level keys are the data itself
  if (data.host_name || data.description || data.topics) {
    return data;
  }

  // Fallback — return raw data
  return data;
}

// ── Host name verification ──────────────────────────────────────────────────

/**
 * Check if a returned host_name looks like a brand/company rather than a person.
 * Used to decide whether a second-pass verification call is needed.
 */
function looksLikeBrandName(name, podcastTitle) {
  if (!name) return true;

  const normalized = name.toLowerCase().trim();
  const titleLower = (podcastTitle || '').toLowerCase().trim();

  // Identical to podcast title = definitely not a person's name
  if (normalized === titleLower) return true;

  // Title contains the name or vice versa (e.g. "Leadership Without Losing Your Soul" as host)
  if (titleLower.includes(normalized) || normalized.includes(titleLower)) return true;

  // Common brand/company keywords
  const brandKeywords = ['podcast', 'show', 'media', 'network', 'studio', 'inc', 'llc',
    'ltd', 'corp', 'group', 'company', 'digital', 'entertainment', 'productions',
    'publishing', 'agency', 'solutions', 'global', 'partners', 'ventures'];

  const words = normalized.split(/\s+/);
  for (const word of words) {
    const clean = word.replace(/[^a-zA-Z]/g, '');
    if (brandKeywords.includes(clean)) return true;
  }

  // Single-word name (e.g. "Bloomberg") is suspicious — could be a brand
  if (words.length === 1 && words[0].length > 3) return true;

  return false;
}

/**
 * Second-pass SGAI call focused specifically on finding the PERSON name of the host.
 * Prompts SGAI to navigate the site for host bios/about pages and return only the host name.
 *
 * @param {string} url - Website URL to scrape
 * @returns {Promise<string|null>} Person's name or null
 */
async function verifyHostName(url) {
  if (!url) return null;

  const prompt = `Visit this podcast's website and find the host(s) — the actual PERSON or PEOPLE who host the show. Look for "About the Host" sections, team pages, host bios, author bylines, or any page that names the person.

Return ONLY a valid JSON object (no markdown, no code fences):
{
  "host_name": "First and last name of the person who hosts this podcast. If multiple hosts, provide all names separated by commas. If you absolutely cannot find any person's name, return null."
}

Do NOT return the podcast name, brand name, or company name. Only return a real person's name.`;

  try {
    const response = await axios.post(
      SGAI_ENDPOINT,
      { url, prompt },
      {
        headers: {
          'SGAI-APIKEY': SGAI_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: ENRICH_TIMEOUT_MS,
      }
    );
    const result = parseSGAIResponse(response.data, url);
    if (result && result.host_name && typeof result.host_name === 'string' && result.host_name.trim()) {
      const verified = result.host_name.trim();
      logger.info('Host name verification: found person name', { host_name: verified, url });
      return verified;
    }
  } catch (err) {
    logger.debug('Host name verification: SGAI call failed', { url, error: err.message });
  }
  return null;
}

/**
 * Deep Enrich — extract social links + email from a podcast's website using SGAI.
 *
 * 2-credit cost per call. Goes beyond the basic AI Enrich:
 *   1. If no website but has apple_url/spotify_url, discovers the website from the directory page
 *   2. Calls SGAI on the website to extract Instagram, Facebook, LinkedIn, X/Twitter,
 *      YouTube, TikTok, email, and description
 *   3. Only fills null fields (never overwrites existing data)
 *   4. Sets deep_enriched_at
 *
 * @param {string} podcastId
 * @returns {Promise<{ok: boolean, enriched: object|null, error?: string}>}
 */
async function deepEnrichPodcastWithSGAI(podcastId) {
  if (!podcastId) return { ok: false, error: 'podcastId_required' };

  // 1. Fetch podcast from DB
  const { data: podcast, error: dbError } = await supabase
    .from('podcasts')
    .select('id, title, website, apple_url, spotify_url, contact_email, instagram_url, twitter_url, linkedin_page_url, facebook_url, youtube_url, tiktok_url, description, deep_enriched_at')
    .eq('id', podcastId)
    .single();

  if (dbError || !podcast) {
    logger.warn('Deep enrich: podcast not found', { podcastId, error: dbError?.message });
    return { ok: false, error: 'podcast_not_found' };
  }

  // 2. Determine target URL — use website directly, or discover from directory page
  let targetUrl = podcast.website || null;

  // No website but has a directory page — try to discover the website
  if (!targetUrl && (podcast.apple_url || podcast.spotify_url)) {
    const directoryUrl = podcast.apple_url || podcast.spotify_url;
    logger.info('Deep enrich: discovering website from directory page', { podcastId, directoryUrl });
    try {
      targetUrl = await discoverWebsiteFromDirectory(directoryUrl);
    } catch (err) {
      logger.warn('Deep enrich: website discovery failed', { podcastId, error: err.message });
    }
  }

  if (!targetUrl) {
    return { ok: false, error: 'no_url_available' };
  }

  // 3. Build a targeted prompt for social + email extraction only
  const deepPrompt = `Extract contact and social media information from this podcast's website. Return ONLY a valid JSON object (no markdown, no code fences) with these fields:

{
  "contact_email": "Contact or booking email address if visible on the page",
  "description": "2-3 sentence summary of what this podcast is about",
  "instagram_url": "Full URL to the podcast's Instagram profile if present",
  "twitter_url": "Full URL to the podcast's Twitter/X profile if present",
  "linkedin_url": "Full URL to the host or show's LinkedIn profile if present",
  "facebook_url": "Full URL to the podcast's Facebook page if present",
  "youtube_url": "Full URL to the podcast's YouTube channel if present",
  "tiktok_url": "Full URL to the podcast's TikTok profile if present",
  "soundcloud_url": "Full URL to the podcast's SoundCloud profile if present",
  "booking_page_url": "Full URL to a guest booking / appear-on page if one exists",
  "guest_application_url": "Full URL to a guest application form if one exists"
}

★★★★★ CRITICAL RULES — VIOLATING THESE WASTES MONEY ★★★★★
1. NEVER fabricate or guess social media URLs. Only return a URL if you SEE it literally on the page (an <a href="..."> linking to instagram.com, twitter.com, etc.).
2. NEVER return a URL that doesn't match the platform. E.g., if you find a YouTube link, put it in youtube_url, NOT in instagram_url.
3. If a social media page or link is NOT visibly present on the page, return null for that field. Do not guess.
4. For host_name: return the actual person name (e.g. "Steve Siebold"), NOT the podcast title or a description. If no person's name is found, return null.
5. For contact_email: only return an email address you actually SEE written out on the page. Do not guess or construct one.
6. Navigate the site (about page, team page, contact page) to find social links and email — but ONLY return what you find. Do not make up anything.`;

  // 4. Call SGAI
  let extractResult;
  try {
    const response = await axios.post(
      SGAI_ENDPOINT,
      {
        url: targetUrl,
        prompt: deepPrompt,
      },
      {
        headers: {
          'SGAI-APIKEY': SGAI_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: ENRICH_TIMEOUT_MS,
      }
    );
    extractResult = parseSGAIResponse(response.data, targetUrl);
  } catch (err) {
    const msg = err.response ? `sgai_http_${err.response.status}` :
                err.code === 'ECONNABORTED' ? 'sgai_timeout' : err.message;
    logger.error('Deep enrich: SGAI call failed', { podcastId, error: msg });
    return { ok: false, error: `sgai_api_error: ${msg}` };
  }

  if (!extractResult || Object.keys(extractResult).length === 0) {
    return { ok: false, error: 'empty_result' };
  }

  // 5. Build patch — only fill fields that are currently null
  const patch = {};
  const fields = [
    { key: 'contact_email',     src: extractResult.contact_email },
    { key: 'description',       src: extractResult.description },
    { key: 'instagram_url',     src: extractResult.instagram_url },
    { key: 'twitter_url',       src: extractResult.twitter_url },
    { key: 'linkedin_page_url', src: extractResult.linkedin_url },
    { key: 'facebook_url',      src: extractResult.facebook_url },
    { key: 'youtube_url',       src: extractResult.youtube_url },
    { key: 'tiktok_url',        src: extractResult.tiktok_url },
    { key: 'soundcloud_url',     src: extractResult.soundcloud_url },
    { key: 'booking_page_url',      src: extractResult.booking_page_url },
    { key: 'guest_application_url', src: extractResult.guest_application_url },
  ];

  for (const f of fields) {
    if (f.src && typeof f.src === 'string' && f.src.trim() && !podcast[f.key]) {
      patch[f.key] = f.src.trim();
    }
  }

  // 6. Set deep_enriched_at
  patch.deep_enriched_at = new Date().toISOString();

  // 7. Save to DB
  const { error: updateError } = await supabase
    .from('podcasts')
    .update(patch)
    .eq('id', podcastId);

  if (updateError) {
    logger.error('Deep enrich: DB update failed', { podcastId, error: updateError.message });
    return { ok: false, error: 'db_update_failed' };
  }

  const foundFields = Object.keys(patch).filter(k => k !== 'deep_enriched_at');

  logger.info('Deep enrichment complete', {
    podcastId,
    title: podcast.title,
    fieldsFound: foundFields,
  });

  return {
    ok: true,
    enriched: { ...patch, niche_tags: null },
    fields_found: foundFields,
  };
}

/**
 * Discover a podcast's official website from its Apple Podcasts or Spotify directory page.
 * Parses the HTML for the homepage/website link.
 *
 * @param {string} directoryUrl - Apple Podcasts or Spotify URL
 * @returns {Promise<string|null>} The discovered website URL, or null
 */
async function discoverWebsiteFromDirectory(directoryUrl) {
  if (!directoryUrl) return null;

  try {
    const response = await axios.get(directoryUrl, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FindAPodcastBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      maxRedirects: 3,
    });

    const html = response.data;
    if (!html || typeof html !== 'string') return null;

    // Apple Podcasts: website link often in a meta tag or anchor
    // Look for various patterns a podcast website might appear in Apple's page

    // Pattern 1: Link with class containing "website" or "link"
    const linkPatterns = [
      /<a[^>]*class="[^"]*link[^"]*"[^>]*href="(https?:\/\/[^"]+)"[^>]*>/i,
      /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*class="[^"]*link[^"]*"/i,
      /<a[^>]*data-test-id="[^"]*website[^"]*"[^>]*href="(https?:\/\/[^"]+)"/i,
      /<a[^>]*rel="nofollow"[^>]*href="(https?:\/\/[^"]+)"[^>]*class="link"/i,
      // Generic: first external link that looks like a podcast website
      /<a[^>]*href="(https?:\/\/(?:www\.)?(?!podcasts\.apple\.com|itunes\.apple\.com|podcast|spotify)[^"']*)"[^>]*>website/i,
      // Fallback: check meta og:url or twitter:url
      /<meta[^>]*(?:property|name)="(?:og:url|twitter:url)"[^>]*content="(https?:\/\/[^"]+)"/i,
      // Spotify: look for external link in description
      /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*target="_blank"[^>]*rel="noreferrer[^"]*">/i,
    ];

    for (const pattern of linkPatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        const url = match[1].trim();
        // Validate it's a real URL
        try {
          const parsed = new URL(url);
          // Skip Apple/Spotify domains
          const hostname = parsed.hostname.toLowerCase();
          if (!hostname.includes('apple.com') && !hostname.includes('spotify.com') && !hostname.includes('podcasts.')) {
            return url;
          }
        } catch { /* not a valid URL */ }
      }
    }

    // Last resort: find any external URL that looks like a podcast website
    // Apple often puts it in a <p> or a plain <a> in the description
    const externalUrlMatch = html.match(/href="(https?:\/\/(?:www\.)?[a-z0-9][-a-z0-9]*\.[a-z]{2,}(?:\/[^"']*)?)"/gi);
    if (externalUrlMatch) {
      for (const m of externalUrlMatch) {
        const url = m.replace(/href="/i, '').replace(/"$/, '');
        try {
          const parsed = new URL(url);
          const hostname = parsed.hostname.toLowerCase();
          if (!hostname.includes('apple.com') && !hostname.includes('spotify.com') &&
              !hostname.includes('itunes.apple.com') && !hostname.includes('podcasts.')) {
            return url;
          }
        } catch { /* skip */ }
      }
    }

    return null;
  } catch (err) {
    logger.warn('Website discovery HTTP failed', { url: directoryUrl, error: err.message });
    return null;
  }
}

module.exports = {
  enrichPodcastWithSGAI,
  enrichBatch,
  deepEnrichPodcastWithSGAI,
};
