'use strict';

const supabase  = require('./supabase');
const logger    = require('./logger');
const Anthropic = require('@anthropic-ai/sdk');

const REACHABLE_SCORE_MAX = 65;
const BATCH_LIMIT         = 25;
const FETCH_TIMEOUT       = 6000;

const EMAIL_REGEX   = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const HUNTER_API_KEY = process.env.HUNTER_API_KEY;

// ─── Public entry point ───────────────────────────────────────────────────────

async function deepEnrichNewPodcasts(podcastIds) {
  if (!podcastIds || podcastIds.length === 0) return;

  try {
    const { data: podcasts, error } = await supabase
      .from('podcasts')
      .select('id, title, host_name, website, listen_score, contact_email, instagram_url, twitter_url, linkedin_url, facebook_url, deep_enriched_at')
      .in('id', podcastIds)
      .is('deep_enriched_at', null)
      .or('contact_email.is.null,instagram_url.is.null')
      .limit(BATCH_LIMIT);

    if (error) {
      logger.warn('Deep enrichment query failed', { error: error.message });
      return;
    }

    if (!podcasts || podcasts.length === 0) return;

    // Filter to reachable/small-mid shows
    const reachable = podcasts.filter(
      (p) => p.listen_score == null || p.listen_score <= REACHABLE_SCORE_MAX
    );

    logger.info('Deep enrichment starting', { total: reachable.length });

    for (const podcast of reachable) {
      await deepEnrichOne(podcast);
      // Gentle delay between requests
      await new Promise((r) => setTimeout(r, 500));
    }

    logger.info('Deep enrichment complete', { processed: reachable.length });
  } catch (err) {
    logger.warn('deepEnrichNewPodcasts error', { error: err.message });
  }
}

// ─── Per-podcast enrichment ───────────────────────────────────────────────────

async function deepEnrichOne(podcast) {
  try {
    const updates = {};
    let homepageHtml = null;

    // ── a. Hunter.io domain search ────────────────────────────────────────────
    if (!podcast.contact_email && podcast.website && HUNTER_API_KEY) {
      try {
        const domain = extractDomain(podcast.website);
        if (domain) {
          const email = await hunterDomainSearch(domain, podcast.host_name);
          if (email) updates.contact_email = email;
        }
      } catch { /* silent */ }
    }

    // ── b. Re-scrape contact/about pages ─────────────────────────────────────
    const missingEmail    = !podcast.contact_email && !updates.contact_email;
    const missingSocials  = !podcast.instagram_url || !podcast.twitter_url || !podcast.linkedin_url || !podcast.facebook_url;

    if (podcast.website && (missingEmail || missingSocials)) {
      try {
        homepageHtml = await fetchWithTimeout(podcast.website);

        if (homepageHtml) {
          if (missingEmail) {
            const email = extractEmailFromHtml(homepageHtml);
            if (email) updates.contact_email = email;
          }
          if (missingSocials) {
            const socials = extractSocialsFromHtml(homepageHtml);
            Object.assign(updates, filterSocialUpdates(podcast, socials));
          }
        }

        // Scrape sub-pages if still missing email
        if (!podcast.contact_email && !updates.contact_email) {
          const paths = ['/contact', '/about', '/pitch', '/be-a-guest'];
          for (const path of paths) {
            try {
              const url  = new URL(path, podcast.website).href;
              const html = await fetchWithTimeout(url);
              if (html) {
                const email = extractEmailFromHtml(html);
                if (email) { updates.contact_email = email; break; }
              }
            } catch { /* silent */ }
          }
        }
      } catch { /* silent */ }
    }

    // ── c. Haiku fallback ─────────────────────────────────────────────────────
    if (!podcast.contact_email && !updates.contact_email && homepageHtml) {
      try {
        const extracted = await haikuExtract(podcast, homepageHtml);
        if (extracted.email)    updates.contact_email  = extracted.email;
        if (extracted.instagram && !podcast.instagram_url) updates.instagram_url = extracted.instagram;
        if (extracted.linkedin  && !podcast.linkedin_url)  updates.linkedin_url  = extracted.linkedin;
        if (extracted.twitter   && !podcast.twitter_url)   updates.twitter_url   = extracted.twitter;
        if (extracted.facebook  && !podcast.facebook_url)  updates.facebook_url  = extracted.facebook;
      } catch { /* silent */ }
    }

    // ── Save results ──────────────────────────────────────────────────────────
    updates.deep_enriched_at = new Date().toISOString();

    const { error: updateError } = await supabase
      .from('podcasts')
      .update(updates)
      .eq('id', podcast.id);

    if (updateError) {
      logger.warn('Deep enrichment save failed', { podcastId: podcast.id, error: updateError.message });
    } else {
      const found = Object.keys(updates).filter((k) => k !== 'deep_enriched_at');
      if (found.length > 0) {
        logger.info('Deep enrichment saved data', { podcastId: podcast.id, fields: found });
      }
    }
  } catch (err) {
    logger.warn('deepEnrichOne failed', { podcastId: podcast.id, error: err.message });
  }
}

// ─── Hunter.io ────────────────────────────────────────────────────────────────

async function hunterDomainSearch(domain, hostName) {
  if (!HUNTER_API_KEY) return null;

  try {
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_API_KEY}&limit=10`;
    const html = await fetchWithTimeout(url);
    if (!html) return null;

    let data;
    try { data = JSON.parse(html); } catch { return null; }

    const emails = data?.data?.emails;
    if (!Array.isArray(emails) || emails.length === 0) return null;

    // Try to match host name
    if (hostName) {
      const parts = hostName.trim().split(/\s+/);
      const first = parts[0]?.toLowerCase();
      const last  = parts[parts.length - 1]?.toLowerCase();

      for (const entry of emails) {
        const addr = (entry.value || '').toLowerCase();
        if ((first && addr.includes(first)) || (last && addr.includes(last))) {
          return entry.value;
        }
      }
    }

    // Fallback: highest-confidence email >= 50
    const candidates = emails
      .filter((e) => (e.confidence ?? 0) >= 50)
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

    return candidates[0]?.value || null;
  } catch {
    return null;
  }
}

// ─── Social extraction ────────────────────────────────────────────────────────

function extractSocialsFromHtml(html) {
  if (!html) return {};

  const result = {};

  const patterns = [
    { key: 'instagram_url', re: /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)/g },
    { key: 'twitter_url',   re: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]+)/g },
    { key: 'linkedin_url',  re: /https?:\/\/(?:www\.)?linkedin\.com\/(?:in|company)\/([A-Za-z0-9_\-%.]+)/g },
    { key: 'facebook_url',  re: /https?:\/\/(?:www\.)?facebook\.com\/([A-Za-z0-9_.]+)/g },
  ];

  for (const { key, re } of patterns) {
    re.lastIndex = 0;
    const match = re.exec(html);
    if (match) {
      // Canonicalise
      result[key] = match[0].split('?')[0].replace(/\/$/, '');
    }
  }

  return result;
}

function filterSocialUpdates(podcast, socials) {
  const updates = {};
  if (socials.instagram_url && !podcast.instagram_url) updates.instagram_url = socials.instagram_url;
  if (socials.twitter_url   && !podcast.twitter_url)   updates.twitter_url   = socials.twitter_url;
  if (socials.linkedin_url  && !podcast.linkedin_url)   updates.linkedin_url  = socials.linkedin_url;
  if (socials.facebook_url  && !podcast.facebook_url)   updates.facebook_url  = socials.facebook_url;
  return updates;
}

// ─── Haiku fallback ───────────────────────────────────────────────────────────

async function haikuExtract(podcast, html) {
  try {
    const client   = new Anthropic();
    const truncated = html.slice(0, 1500);

    const message = await client.messages.create({
      model:      'claude-3-5-haiku-20241022',
      max_tokens: 150,
      messages: [
        {
          role:    'user',
          content: `Extract contact details for podcast "${podcast.title}" host "${podcast.host_name}". From this webpage text find: email address, Instagram URL, LinkedIn URL, Twitter URL, Facebook URL. Reply with JSON only, no explanation: {"email":null,"instagram":null,"linkedin":null,"twitter":null,"facebook":null}\n\n${truncated}`,
        },
      ],
    });

    const text = message.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {};
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function extractEmailFromHtml(html) {
  if (!html) return null;
  const matches = html.match(EMAIL_REGEX) || [];
  for (const email of matches) {
    const lower = email.toLowerCase();
    if (!lower.includes('example.com') && !lower.includes('yourdomain')) {
      return lower;
    }
  }
  return null;
}

async function fetchWithTimeout(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PodcastPipelineBot/1.0)',
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

module.exports = { deepEnrichNewPodcasts };
