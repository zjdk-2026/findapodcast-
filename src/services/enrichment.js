'use strict';

const cheerio = require('cheerio');
const logger = require('../lib/logger');
const dns = require('dns').promises;

async function hasMxRecord(email) {
  try {
    const domain = email.split('@')[1];
    if (!domain) return false;
    const records = await dns.resolveMx(domain);
    return records && records.length > 0;
  } catch {
    return false; // domain has no MX record = email likely invalid
  }
}

// Operator-owned emails and social handles — never assign these to discovered podcasts
// (they appear in show notes when Zac has been a guest, causing false data)
const OPERATOR_EMAILS    = ['hi@zacdeane.com', 'zac@zacdeane.com', 'hi@findapodcast.io'];
const OPERATOR_DOMAINS   = ['zacdeane.com', 'findapodcast.io'];
const OPERATOR_SOCIALS   = ['instagram.com/zacdeane', 'linkedin.com/in/zacdeane', 'instagram.com/zac_deane'];

function isOperatorOwned(value) {
  if (!value) return false;
  const v = value.toLowerCase();
  if (OPERATOR_EMAILS.some(e => v === e)) return true;
  if (OPERATOR_DOMAINS.some(d => v.includes(`@${d}`))) return true;
  if (OPERATOR_SOCIALS.some(s => v.includes(s))) return true;
  return false;
}

// Generic email prefixes to skip — keep podcast-specific ones like guest@, booking@, contact@
// because those ARE the right contacts for pitch outreach
const GENERIC_EMAIL_PREFIXES = [
  'info', 'hello', 'support', 'admin', 'noreply', 'no-reply',
  'mail', 'help', 'sales', 'marketing',
  'press', 'media', 'feedback', 'office', 'careers', 'jobs',
  'hey', 'hi',
  'general', 'partnerships', 'partner', 'advertise',
  'advertising', 'sponsor', 'sponsors', 'pr', 'publicist',
];

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

const GUEST_PATH_KEYWORDS = ['guest', 'apply', 'pitch', 'appear', 'be-a-guest', 'be_a_guest', 'submit', 'speaker'];
const BOOKING_PATH_KEYWORDS = ['book', 'schedule', 'calendly', 'typeform', 'acuity', 'cal.com', 'doodle'];

const FETCH_TIMEOUT_MS = 12000;

// ── Social URL validation ─────────────────────────────────────────────
// Rejects share dialogs, intent URLs, post links, hashtag pages, ads pages,
// and any URL that is not an actual profile / page handle.
// Returns a clean canonical URL (no query params, no fragments) or null.

// Known non-profile subdomains
const SOCIAL_BAD_SUBDOMAINS = ['business.', 'ads.', 'about.', 'help.', 'developer.', 'developers.', 'newsroom.', 'careers.', 'investor.'];

// Blocked path segments — matched at segment boundaries only (never as username prefixes).
// e.g. '/intent' blocks 'twitter.com/intent/tweet' but NOT 'twitter.com/intentional_host'
const SOCIAL_BLOCKED_SEGMENTS = new Set([
  'intent', 'sharer', 'dialog', 'ads', 'login', 'signup', 'register',
  'redirect', 'out', 'settings', 'notifications', 'direct',
  'reel', 'reels', 'stories', 'explore', 'tags', 'p', 'tv',
  'events', 'groups', 'jobs', 'learning', 'school',
  'status', 'i', 'share', 'shareArticle', 'oauth', 'api',
]);

// Query-string patterns that indicate non-profile URLs (checked against raw URL)
const SOCIAL_BLOCKED_QS = ['share?', 'shareArticle?', 'sharedby', 'intent/tweet', '?u=', '?url=', 'dialog/share'];

function validateAndNormalizeSocialUrl(rawUrl, platform) {
  if (!rawUrl) return null;
  let url;
  try { url = new URL(rawUrl); } catch { return null; }

  const full  = rawUrl.toLowerCase();
  const path  = url.pathname.toLowerCase();
  const host  = url.hostname.toLowerCase();

  // Reject bad subdomains
  if (SOCIAL_BAD_SUBDOMAINS.some(s => host.startsWith(s))) return null;

  // Reject known query-string patterns
  if (SOCIAL_BLOCKED_QS.some(q => full.includes(q))) return null;

  // Reject if any path segment matches a blocked word (segment-boundary-aware)
  const segments = path.split('/').filter(Boolean);
  if (segments.some(seg => SOCIAL_BLOCKED_SEGMENTS.has(seg))) return null;

  // Platform-specific profile pattern validation
  switch (platform) {
    case 'instagram': {
      // Must match instagram.com/{username} — username is alphanumeric + _ + .
      if (!host.includes('instagram.com')) return null;
      const match = path.match(/^\/([a-z0-9_.]{1,30})\/?$/);
      if (!match) return null;
      const username = match[1];
      // Reject reserved Instagram paths
      const reserved = ['accounts', 'explore', 'direct', 'reels', 'tv', 'ar', 'about', 'legal', 'privacy', 'safety', 'developer', 'blog', 'press', 'api', 'oauth'];
      if (reserved.includes(username)) return null;
      return `https://www.instagram.com/${username}/`;
    }
    case 'twitter': {
      if (!host.includes('twitter.com') && !host.includes('x.com')) return null;
      const match = path.match(/^\/([a-z0-9_]{1,15})\/?$/);
      if (!match) return null;
      const handle = match[1];
      const reserved = ['home', 'explore', 'notifications', 'messages', 'settings', 'help', 'about', 'login', 'signup', 'tos', 'privacy', 'search', 'i', 'intent', 'share'];
      if (reserved.includes(handle)) return null;
      return `https://twitter.com/${handle}`;
    }
    case 'facebook': {
      if (!host.includes('facebook.com')) return null;
      // Accept /pagename, /pages/pagename/id, /profile.php?id=...
      const validPage = /^\/(pages\/[^/]+\/[^/]+|profile\.php|[a-z0-9.]{3,})\/?$/i.test(path);
      if (!validPage) return null;
      const reserved = ['groups', 'events', 'watch', 'marketplace', 'gaming', 'live', 'ads', 'business', 'help', 'login', 'signup', 'notes', 'photos', 'videos'];
      if (reserved.some(r => path.startsWith(`/${r}`))) return null;
      // Reconstruct without tracking params — keep profile.php?id= if present
      const clean = url.pathname.startsWith('/profile.php') && url.searchParams.get('id')
        ? `https://www.facebook.com/profile.php?id=${url.searchParams.get('id')}`
        : `https://www.facebook.com${url.pathname.replace(/\/$/, '')}`;
      return clean;
    }
    case 'linkedin': {
      if (!host.includes('linkedin.com')) return null;
      // Only accept /company/{slug} or /in/{slug}
      const match = path.match(/^\/(company|in)\/([a-z0-9\-_%.]{2,})\/?$/i);
      if (!match) return null;
      return `https://www.linkedin.com/${match[1]}/${match[2]}/`;
    }
    default:
      return null;
  }
}

// Helper: extract first valid social profile URL from a list of candidate hrefs
function pickBestSocialUrl(hrefs, platform) {
  for (const href of hrefs) {
    const validated = validateAndNormalizeSocialUrl(href, platform);
    if (validated) return validated;
  }
  return null;
}

// Extract handle slug from a validated social URL
function extractHandleFromUrl(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    if (!segments.length) return null;
    // For LinkedIn: /company/slug or /in/slug — take the slug part
    if (segments[0] === 'company' || segments[0] === 'in') return segments[1] || null;
    // For YouTube: /@handle → strip the @
    if (segments[0] && segments[0].startsWith('@')) return segments[0].slice(1);
    // For YouTube: /channel/UCxxx or /c/slug
    if ((segments[0] === 'channel' || segments[0] === 'c') && segments[1]) return segments[1];
    return segments[0];
  } catch { return null; }
}

// Tokenise a string into lowercase alpha-only words of 3+ chars
function tokenise(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
}

/**
 * Like pickBestSocialUrl but requires strong token matching between handle and
 * podcast title/host. Used for homepage scraping where any social link on the
 * page might belong to a third party (guest, sponsor, etc.)
 *
 * Rules (Fix 1):
 * - Short tokens under 4 chars never count alone
 * - Need 2+ matching tokens OR one matching token of 5+ chars
 * - If multiple candidates share the same top score → ambiguous → return null
 * - Single-candidate fallback only if the handle actually contains a token
 */
function pickMatchingSocialUrl(hrefs, platform, podcastTitle, hostName) {
  const titleTokens = tokenise(podcastTitle);
  const hostTokens  = tokenise(hostName);
  const contextTokens = [...new Set([...titleTokens, ...hostTokens])];

  const validated = hrefs.map(h => validateAndNormalizeSocialUrl(h, platform)).filter(Boolean);
  if (!validated.length) return null;

  // Score each candidate
  const scored = validated.map(url => {
    const handle = (extractHandleFromUrl(url) || '').toLowerCase();
    const matchingTokens = contextTokens.filter(t => handle.includes(t));
    // Weight: 5+ char tokens count as 2 points, shorter as 1
    const weightedScore = matchingTokens.reduce((sum, t) => sum + (t.length >= 5 ? 2 : 1), 0);
    return { url, matchingTokens, weightedScore };
  });

  const bestScore = Math.max(...scored.map(s => s.weightedScore));

  // Must have at least 2 tokens matched, OR one 5+ char token (weighted >= 2)
  if (bestScore < 2) {
    // Single-candidate fallback: only if it has at least one token match (any length)
    if (validated.length === 1 && scored[0].matchingTokens.length > 0) {
      return validated[0];
    }
    logger.warn('pickMatchingSocialUrl: no candidate meets minimum token threshold', {
      platform, podcastTitle, candidates: validated.length,
    });
    return null;
  }

  const topCandidates = scored.filter(s => s.weightedScore === bestScore);

  // Ambiguous: multiple candidates with same top score → don't guess
  if (topCandidates.length > 1) {
    logger.warn('pickMatchingSocialUrl: ambiguous candidates, refusing to guess', {
      platform, podcastTitle, topScore: bestScore, count: topCandidates.length,
    });
    return null;
  }

  return topCandidates[0].url;
}

/**
 * HEAD-request verification of a social URL (Fix 2).
 * Returns the url if it resolves (200/301/302), null otherwise.
 */
async function verifySocialUrl(url) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FindAPodcastBot/1.0; +https://findapodcast.io)' },
    });
    if ([200, 301, 302, 303].includes(res.status)) return url;
    logger.warn('verifySocialUrl: HEAD returned non-OK status', { url, status: res.status });
    return null;
  } catch (err) {
    logger.warn('verifySocialUrl: HEAD request failed', { url, error: err.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Profile existence check — lightweight content check (Fix 3).
 * Returns true if the profile looks real, false if it's a 404/generic page.
 */
async function checkProfileExists(url, platform) {
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FindAPodcastBot/1.0; +https://findapodcast.io)',
        'Accept': 'text/html',
      },
    });

    // LinkedIn login redirect means profile doesn't exist / requires auth
    if (platform === 'linkedin') {
      const finalUrl = res.url || '';
      if (finalUrl.includes('linkedin.com/login') || finalUrl.includes('linkedin.com/authwall')) {
        logger.warn('checkProfileExists: LinkedIn redirected to login', { url });
        return false;
      }
      // If we got a response at all and didn't redirect to login, treat as existing
      return res.ok;
    }

    if (!res.ok) return false;

    const html = await res.text();
    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const ogTitle = ogTitleMatch ? ogTitleMatch[1].trim() : '';

    if (platform === 'instagram') {
      if (!ogTitle || ogTitle.toLowerCase() === 'instagram' || ogTitle.toLowerCase().includes('page not found')) {
        logger.warn('checkProfileExists: Instagram generic/404 page', { url, ogTitle });
        return false;
      }
      return true;
    }

    if (platform === 'twitter') {
      if (!ogTitle || ogTitle.toLowerCase() === 'twitter' || ogTitle.toLowerCase() === 'x' || ogTitle.toLowerCase().includes('page not found')) {
        logger.warn('checkProfileExists: Twitter/X generic/404 page', { url, ogTitle });
        return false;
      }
      return true;
    }

    if (platform === 'facebook') {
      if (!ogTitle || ogTitle.toLowerCase().includes('page not found') || ogTitle.toLowerCase() === 'facebook') {
        logger.warn('checkProfileExists: Facebook generic/404 page', { url, ogTitle });
        return false;
      }
      return true;
    }

    return true;
  } catch (err) {
    logger.warn('checkProfileExists: fetch failed', { url, platform, error: err.message });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Confidence scoring for a social URL (Fix 5).
 * Returns 0-100. Only store if >= 100.
 */
function confidenceScore({ url, platform, podcastTitle, hostName, headVerified, profileChecked, fromAtomLink, isSoleCandidate }) {
  let score = 0;

  const titleTokens = tokenise(podcastTitle);
  const hostTokens  = tokenise(hostName);
  const contextTokens = [...new Set([...titleTokens, ...hostTokens])];
  const handle = (extractHandleFromUrl(url) || '').toLowerCase();
  const matchingTokens = contextTokens.filter(t => handle.includes(t));

  // +40 for 2+ tokens matching (5+ char tokens worth more)
  const longMatches  = matchingTokens.filter(t => t.length >= 5).length;
  const shortMatches = matchingTokens.filter(t => t.length < 5).length;
  if (longMatches >= 2) score += 40;
  else if (longMatches >= 1 && shortMatches >= 1) score += 35;
  else if (longMatches >= 1) score += 30;
  else if (shortMatches >= 2) score += 20;
  else if (shortMatches >= 1) score += 10;

  if (headVerified)    score += 30;  // +30 verified via HEAD
  if (profileChecked)  score += 20;  // +20 profile content check passed
  if (fromAtomLink)    score += 10;  // +10 came from RSS atom:link
  if (isSoleCandidate) score += 5;   // +5 only candidate

  return score;
}

/**
 * Verify, content-check, and score a social URL. Returns the URL if confidence >= 100, else null.
 * fromAtomLink and isSoleCandidate are optional scoring hints.
 */
async function validateSocialWithConfidence(url, platform, podcastTitle, hostName, { fromAtomLink = false, isSoleCandidate = false } = {}) {
  if (!url) return null;

  // Fix 2: HEAD verification
  const headOk = !!(await verifySocialUrl(url));

  // Fix 3: Profile existence check (only for the four key platforms)
  let profileOk = false;
  if (headOk && ['instagram', 'twitter', 'facebook', 'linkedin'].includes(platform)) {
    profileOk = await checkProfileExists(url, platform);
    if (!profileOk) {
      logger.warn('validateSocialWithConfidence: profile check failed, discarding', { url, platform });
      return null;
    }
  } else if (headOk) {
    profileOk = true; // other platforms: treat head ok as sufficient
  }

  if (!headOk) {
    logger.warn('validateSocialWithConfidence: HEAD verification failed, discarding', { url, platform });
    return null;
  }

  const score = confidenceScore({ url, platform, podcastTitle, hostName, headVerified: headOk, profileChecked: profileOk, fromAtomLink, isSoleCandidate });

  if (score < 100) {
    logger.warn('validateSocialWithConfidence: confidence below threshold, discarding', { url, platform, score, podcastTitle });
    return null;
  }

  return url;
}

/**
 * Fetch HTML from a URL with timeout. Returns null on failure.
 */
async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FindAPodcastBot/1.0; +https://findapodcast.io)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Determine if an email prefix is generic (should be skipped).
 */
function isGenericEmail(email) {
  const prefix = email.split('@')[0].toLowerCase();
  return GENERIC_EMAIL_PREFIXES.some((g) => prefix === g || prefix.startsWith(g + '.'));
}

/**
 * Validate that an email domain looks real (has a dot, reasonable length, not placeholder).
 */
function isValidEmailDomain(email) {
  const domain = email.split('@')[1] || '';
  return domain.includes('.') && domain.length > 3 && !domain.includes('example') && !domain.includes('test') && !domain.includes('placeholder');
}

/**
 * Extract emails from HTML string.
 * Returns the first non-generic email found, or null.
 */
function extractEmail(html) {
  if (!html) return null;
  const $ = cheerio.load(html);

  // 1. Try mailto: links first
  const mailtoEmails = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const email = href.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (email && email.includes('@')) mailtoEmails.push(email);
  });

  for (const email of mailtoEmails) {
    if (!isGenericEmail(email) && isValidEmailDomain(email) && !isOperatorOwned(email)) return email;
  }

  // 2. Regex scan full HTML
  const matches = html.match(EMAIL_REGEX) || [];
  for (const email of matches) {
    const lower = email.toLowerCase();
    if (!isGenericEmail(lower) && isValidEmailDomain(lower) && !isOperatorOwned(lower) && !lower.includes('example.com') && !lower.includes('yourdomain')) {
      return lower;
    }
  }

  return null;
}

/**
 * Extract a URL from anchor hrefs matching keyword patterns.
 */
function extractLinkByKeywords(html, baseUrl, keywords) {
  if (!html) return null;
  const $ = cheerio.load(html);
  let found = null;

  $('a[href]').each((_, el) => {
    if (found) return;
    const href = $(el).attr('href') || '';
    const hrefLower = href.toLowerCase();
    const textLower = ($(el).text() || '').toLowerCase();

    if (keywords.some((kw) => hrefLower.includes(kw) || textLower.includes(kw))) {
      try {
        found = href.startsWith('http') ? href : new URL(href, baseUrl).href;
      } catch {
        found = href;
      }
    }
  });

  return found;
}

/**
 * Attempt to extract YouTube subscriber count from channel page HTML.
 */
function extractYoutubeSubscribers(html) {
  if (!html) return null;

  // YouTube embeds subscriber count in meta tags or JSON-LD
  const patterns = [
    /"subscriberCountText":\{"simpleText":"([^"]+)"\}/,
    /"subscriberCount":"(\d+)"/,
    /(\d[\d,.]+)\s*subscriber/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      // Parse human-readable numbers like "1.2M", "450K"
      const raw = match[1].replace(/,/g, '');
      if (/^\d+$/.test(raw)) return parseInt(raw, 10);
      const multiplier = raw.endsWith('M') ? 1_000_000 : raw.endsWith('K') ? 1_000 : 1;
      const base = parseFloat(raw.replace(/[MK]/i, ''));
      if (!isNaN(base)) return Math.round(base * multiplier);
    }
  }

  return null;
}

/**
 * Attempt to find an RSS feed URL for a podcast via iTunes search by title.
 * Returns the feedUrl string or null.
 */
async function findRssViaItunes(title) {
  if (!title) return null;
  try {
    const q = encodeURIComponent(title.slice(0, 50));
    const res = await fetch(`https://itunes.apple.com/search?term=${q}&media=podcast&limit=3`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    const match = data.results?.find(r => r.feedUrl && r.collectionName?.toLowerCase().includes(title.toLowerCase().slice(0,10)));
    return match?.feedUrl || data.results?.[0]?.feedUrl || null;
  } catch { return null; }
}

/**
 * Fetch and parse an RSS feed URL, extracting contact/social data.
 * Returns an object with only the non-null found values.
 */
async function fetchRssFeed(rssUrl) {
  if (!rssUrl) return {};
  const xml = await fetchHtml(rssUrl);
  if (!xml) return {};

  try {
    const $ = cheerio.load(xml, { xmlMode: true });
    const result = {};

    // Contact email from itunes:email
    const itunesEmail = $('itunes\\:email').first().text().trim();
    if (itunesEmail && itunesEmail.includes('@')) result.contact_email = itunesEmail.toLowerCase();

    // Host name from itunes:author
    const itunesAuthor = $('itunes\\:author').first().text().trim();
    if (itunesAuthor) result.host_name = itunesAuthor;

    // Website from <link> (skip atom:link) — exclude podcast platform URLs
    const WEBSITE_EXCLUDE_DOMAINS = ['apple.com', 'podcasts.apple', 'itunes.', 'spotify.com', 'anchor.fm', 'youtube.com', 'soundcloud.com', 'stitcher.com', 'podbean.com', 'buzzsprout.com', 'transistor.fm', 'simplecast.com', 'libsyn.com', 'captivate.fm'];
    $('channel > link').each((_, el) => {
      if (!result.website) {
        const text = $(el).text().trim();
        if (text && text.startsWith('http') && !WEBSITE_EXCLUDE_DOMAINS.some(d => text.toLowerCase().includes(d))) {
          result.website = text;
        }
      }
    });

    // Description from <description>
    const desc = $('channel > description').first().text().trim();
    if (desc) result.description = desc;

    // Social links — Fix 4: ONLY trust atom:link tags (the show's own declared links).
    // Full XML regex scan is removed to prevent picking up sponsor/guest/ad links.
    const socialScanPatterns = [
      { key: 'instagram_url',    platform: 'instagram', domain: 'instagram.com' },
      { key: 'twitter_url',      platform: 'twitter',   domain: 'twitter.com' },
      { key: 'twitter_url',      platform: 'twitter',   domain: 'x.com' },
      { key: 'facebook_url',     platform: 'facebook',  domain: 'facebook.com' },
      { key: 'linkedin_page_url',platform: 'linkedin',  domain: 'linkedin.com' },
    ];

    // Collect all atom:link hrefs — these are the show's own declared links
    const atomHrefs = [];
    $('atom\\:link').each((_, el) => { const h = $(el).attr('href'); if (h) atomHrefs.push(h); });

    for (const { key, platform, domain } of socialScanPatterns) {
      if (result[key]) continue;
      // Only from atom:link — no full XML scan (Fix 4)
      const candidates = atomHrefs.filter(h => h.toLowerCase().includes(domain));
      const validated = candidates.map(h => validateAndNormalizeSocialUrl(h, platform)).filter(Boolean);
      if (validated.length > 0) {
        // Mark as fromAtomLink=true for confidence scoring — stored in _rssAtomSocials for later use
        if (!result._rssAtomSocials) result._rssAtomSocials = {};
        result._rssAtomSocials[key] = validated[0];
        result[key] = validated[0];
      }
    }

    // Total episode count from <itunes:episodeCount> or by counting <item> elements
    const episodeCountEl = $('itunes\\:episodeCount').first().text().trim();
    if (episodeCountEl && !isNaN(Number(episodeCountEl))) {
      result.total_episodes = Number(episodeCountEl);
    } else {
      const itemCount = $('item').length;
      if (itemCount > 0 && !result.total_episodes) result.total_episodes = itemCount;
    }

    // Most recent episode date from first <item> <pubDate>
    const firstPubDate = $('item').first().find('pubDate').text().trim();
    if (firstPubDate) {
      const parsed = new Date(firstPubDate);
      if (!isNaN(parsed.getTime())) {
        result.last_episode_date = parsed.toISOString().split('T')[0];
      }
    }

    // Always store the feed URL itself
    result.rss_feed_url = rssUrl;

    return result;
  } catch (err) {
    logger.warn('RSS feed parse failed', { rssUrl, error: err.message });
    return { rss_feed_url: rssUrl };
  }
}

/**
 * enrichPodcast(podcastData)
 * Fetches the podcast website and supplementary pages to extract contact info,
 * guest application URLs, booking links, and YouTube subscriber counts.
 * Never throws. Returns partial data if any step fails.
 */
async function enrichPodcast(podcastData) {
  const enriched = { ...podcastData };
  const website = podcastData.website;

  // ──────────────────────────────────────────────────
  // 0. RSS feed scrape (before homepage)
  // ──────────────────────────────────────────────────
  const rssUrl = podcastData.rss_feed_url || null;
  if (rssUrl) {
    try {
      const rssData = await fetchRssFeed(rssUrl);
      const rssAtomSocials = rssData._rssAtomSocials || {};
      delete rssData._rssAtomSocials;
      for (const [key, val] of Object.entries(rssData)) {
        if (val && !enriched[key]) enriched[key] = val;
      }
      // Confidence-validate atom:link socials before storing (Fix 5)
      const _rTitle = podcastData.title || '';
      const _rHost  = podcastData.host_name || enriched.host_name || '';
      const socialFieldToPlatform = {
        instagram_url: 'instagram', twitter_url: 'twitter',
        facebook_url: 'facebook', linkedin_page_url: 'linkedin',
      };
      for (const [field, platform] of Object.entries(socialFieldToPlatform)) {
        if (rssAtomSocials[field] && !enriched[field]) {
          const verified = await validateSocialWithConfidence(rssAtomSocials[field], platform, _rTitle, _rHost, { fromAtomLink: true, isSoleCandidate: true });
          if (verified) enriched[field] = verified;
          else enriched[field] = null;
        }
      }
      logger.debug('RSS feed enriched', { title: podcastData.title, found: Object.keys(rssData) });
    } catch (err) {
      logger.warn('RSS enrichment failed', { title: podcastData.title, rssUrl, error: err.message });
    }
  }

  // ──────────────────────────────────────────────────
  // 0b. If still no RSS URL, try iTunes lookup by title
  // ──────────────────────────────────────────────────
  if (!enriched.rss_feed_url && !enriched.contact_email) {
    const rssViaItunes = await findRssViaItunes(podcastData.title);
    if (rssViaItunes) {
      enriched.rss_feed_url = rssViaItunes;
      const rssData = await fetchRssFeed(rssViaItunes);
      if (rssData) {
        const rssAtomSocials2 = rssData._rssAtomSocials || {};
        delete rssData._rssAtomSocials;
        for (const [k, v] of Object.entries(rssData)) {
          if (!enriched[k] && v) enriched[k] = v;
        }
        // Confidence-validate atom:link socials
        const _r2Title = podcastData.title || '';
        const _r2Host  = podcastData.host_name || enriched.host_name || '';
        const socialFieldToPlatform2 = {
          instagram_url: 'instagram', twitter_url: 'twitter',
          facebook_url: 'facebook', linkedin_page_url: 'linkedin',
        };
        for (const [field, platform] of Object.entries(socialFieldToPlatform2)) {
          if (rssAtomSocials2[field] && !enriched[field]) {
            const verified = await validateSocialWithConfidence(rssAtomSocials2[field], platform, _r2Title, _r2Host, { fromAtomLink: true, isSoleCandidate: true });
            if (verified) enriched[field] = verified;
            else enriched[field] = null;
          }
        }
      }
    }
  }

  // ──────────────────────────────────────────────────
  // 0c. Handle link-in-bio URLs (Linktree, bio.link, etc.)
  //     Pull social links + try to find the real podcast website
  // ──────────────────────────────────────────────────
  const linkInBioUrl = enriched.linkinbio_url || (website && /linktr\.ee|linktree\.com|bio\.link|beacons\.ai|campsite\.bio/i.test(website) ? website : null);
  if (linkInBioUrl) {
    const ltHtml = await fetchHtml(linkInBioUrl);
    if (ltHtml) {
      const $lt = cheerio.load(ltHtml);
      // Collect all hrefs first, then validate — avoids grabbing the first invalid one
      const ltHrefs = [];
      $lt('a[href]').each((_, el) => { const h = $lt(el).attr('href'); if (h) ltHrefs.push(h); });

      const _ltTitle = podcastData.title || '';
      const _ltHost  = podcastData.host_name || enriched.host_name || '';
      const ltInstaCandidates = ltHrefs.filter(h => h.toLowerCase().includes('instagram.com'));
      const ltFbCandidates    = ltHrefs.filter(h => h.toLowerCase().includes('facebook.com'));
      const ltTwCandidates    = ltHrefs.filter(h => h.toLowerCase().includes('twitter.com') || h.toLowerCase().includes('x.com'));
      if (!enriched.instagram_url) {
        const raw = pickMatchingSocialUrl(ltInstaCandidates, 'instagram', _ltTitle, _ltHost);
        if (raw) enriched.instagram_url = await validateSocialWithConfidence(raw, 'instagram', _ltTitle, _ltHost, { isSoleCandidate: ltInstaCandidates.length === 1 });
      }
      if (!enriched.facebook_url) {
        const raw = pickMatchingSocialUrl(ltFbCandidates, 'facebook', _ltTitle, _ltHost);
        if (raw) enriched.facebook_url = await validateSocialWithConfidence(raw, 'facebook', _ltTitle, _ltHost, { isSoleCandidate: ltFbCandidates.length === 1 });
      }
      if (!enriched.twitter_url) {
        const raw = pickMatchingSocialUrl(ltTwCandidates, 'twitter', _ltTitle, _ltHost);
        if (raw) enriched.twitter_url = await validateSocialWithConfidence(raw, 'twitter', _ltTitle, _ltHost, { isSoleCandidate: ltTwCandidates.length === 1 });
      }
      if (!enriched.spotify_url)   enriched.spotify_url   = ltHrefs.find(h => h.toLowerCase().includes('spotify.com/show')) || null;
      if (!enriched.apple_url)     enriched.apple_url     = ltHrefs.find(h => h.toLowerCase().includes('podcasts.apple.com')) || null;
      if (!enriched.youtube_url)   enriched.youtube_url   = ltHrefs.find(h => h.toLowerCase().includes('youtube.com')) || null;

      // First non-social, non-linktree HTTP link = real website
      const SOCIAL_DOMAINS = ['instagram', 'facebook', 'twitter', 'x.com', 'youtube', 'tiktok', 'spotify', 'apple', 'linktr', 'linktree'];
      if (!enriched.website) {
        const websiteHref = ltHrefs.find(h => h.startsWith('http') && !SOCIAL_DOMAINS.some(s => h.toLowerCase().includes(s)));
        if (websiteHref) enriched.website = websiteHref;
      }
      logger.debug('Link-in-bio enriched', { url: linkInBioUrl, foundWebsite: !!enriched.website });
    }
  }

  // ──────────────────────────────────────────────────
  // 0d. Scrape Apple Podcasts page for "Show Website"
  //     This is the most reliable fallback — every podcast on Apple has one.
  //     We look for JSON-LD structured data first, then fall back to link scanning.
  // ──────────────────────────────────────────────────
  if (!enriched.website && enriched.apple_url) {
    try {
      const appleHtml = await fetchHtml(enriched.apple_url);
      if (appleHtml) {
        const $ap = cheerio.load(appleHtml);

        // 1. Try JSON-LD first (most reliable)
        let foundViaJsonLd = false;
        $ap('script[type="application/ld+json"]').each((_, el) => {
          if (foundViaJsonLd) return;
          try {
            const json = JSON.parse($ap(el).html() || '{}');
            const entries = Array.isArray(json) ? json : [json];
            for (const entry of entries) {
              const url = entry.url || entry.sameAs?.[0] || entry.mainEntityOfPage;
              if (url && typeof url === 'string' && url.startsWith('http') && !url.includes('apple.com') && !url.includes('podcasts.')) {
                enriched.website = url;
                foundViaJsonLd = true;
                break;
              }
            }
          } catch { /* ignore bad JSON */ }
        });

        // 2. Fallback: scan all anchor hrefs for the show website
        //    Apple Podcasts pages have very few external links — the show website
        //    is typically the only non-Apple, non-social external link
        if (!enriched.website) {
          const EXCLUDE = ['apple.com', 'itunes.', 'podcasts.', 'instagram.com', 'facebook.com',
                           'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'spotify.com',
                           'linkedin.com', 'linktr.ee', 'privacy.apple', 'support.apple'];
          $ap('a[href]').each((_, el) => {
            if (enriched.website) return;
            const href = ($ap(el).attr('href') || '').trim();
            if (href.startsWith('http') && !EXCLUDE.some(d => href.includes(d))) {
              enriched.website = href;
            }
          });
        }

        if (enriched.website) {
          logger.info('Show website found via Apple Podcasts page', { title: podcastData.title, website: enriched.website });
        }

        // 3. Additional: Extract social links from Apple Podcasts JSON-LD and page links
        //    Apple is authoritative — podcasters submit these links themselves.
        const _apTitle = podcastData.title || '';
        const _apHost  = podcastData.host_name || enriched.host_name || '';
        const appleHrefs = [];
        $ap('a[href]').each((_, el) => { const h = ($ap(el).attr('href') || '').trim(); if (h) appleHrefs.push(h); });

        // Also collect sameAs arrays from JSON-LD
        $ap('script[type="application/ld+json"]').each((_, el) => {
          try {
            const json = JSON.parse($ap(el).html() || '{}');
            const entries = Array.isArray(json) ? json : [json];
            for (const entry of entries) {
              const sameAs = Array.isArray(entry.sameAs) ? entry.sameAs : (entry.sameAs ? [entry.sameAs] : []);
              for (const u of sameAs) { if (typeof u === 'string') appleHrefs.push(u); }
            }
          } catch { /* ignore */ }
        });

        const socialPlatformsApple = [
          { field: 'instagram_url', platform: 'instagram', domain: 'instagram.com' },
          { field: 'twitter_url',   platform: 'twitter',   domain: 'twitter.com' },
          { field: 'twitter_url',   platform: 'twitter',   domain: 'x.com' },
          { field: 'facebook_url',  platform: 'facebook',  domain: 'facebook.com' },
          { field: 'linkedin_page_url', platform: 'linkedin', domain: 'linkedin.com' },
        ];
        for (const { field, platform, domain } of socialPlatformsApple) {
          if (enriched[field]) continue;
          const candidates = appleHrefs.filter(h => h.toLowerCase().includes(domain));
          if (!candidates.length) continue;
          const raw = pickMatchingSocialUrl(candidates, platform, _apTitle, _apHost);
          if (raw) {
            const verified = await validateSocialWithConfidence(raw, platform, _apTitle, _apHost, { isSoleCandidate: candidates.length === 1 });
            if (verified) {
              enriched[field] = verified;
              logger.info('Social link extracted from Apple Podcasts page', { title: podcastData.title, platform, url: verified });
            }
          }
        }
      }
    } catch (err) {
      logger.warn('Apple Podcasts page scrape failed', { appleUrl: enriched.apple_url, error: err.message });
    }
  }

  if (!website && !enriched.website) {
    logger.debug('No website for podcast, skipping enrichment', { title: podcastData.title });
    return enriched;
  }

  // Use enriched website — prefer what we found via RSS/Apple over the original input
  // (original input may have been a Linktree or wrong URL)
  const siteUrl = enriched.website || website;

  logger.debug('Enriching podcast', { title: podcastData.title, website: siteUrl });

  try {
    // ──────────────────────────────────────────────────
    // 1. Fetch homepage
    // ──────────────────────────────────────────────────
    const homepageHtml = await fetchHtml(siteUrl);

    if (homepageHtml) {
      // Extract contact email
      if (!enriched.contact_email) {
        enriched.contact_email = extractEmail(homepageHtml);
      }

      // Extract social links from anchor hrefs — collect ALL candidates, validate each
      const $home = cheerio.load(homepageHtml);
      const homeHrefs = [];
      $home('a[href]').each((_, el) => {
        const raw = $home(el).attr('href') || '';
        if (!isOperatorOwned(raw)) homeHrefs.push(raw);
      });

      const _title = podcastData.title || '';
      const _host  = podcastData.host_name || enriched.host_name || '';
      const instaCandidates = homeHrefs.filter(h => h.toLowerCase().includes('instagram.com'));
      const twCandidates    = homeHrefs.filter(h => h.toLowerCase().includes('twitter.com') || h.toLowerCase().includes('x.com'));
      const fbCandidates    = homeHrefs.filter(h => h.toLowerCase().includes('facebook.com'));
      const liCandidates    = homeHrefs.filter(h => h.toLowerCase().includes('linkedin.com'));
      if (!enriched.instagram_url) {
        const raw = pickMatchingSocialUrl(instaCandidates, 'instagram', _title, _host);
        if (raw) enriched.instagram_url = await validateSocialWithConfidence(raw, 'instagram', _title, _host, { isSoleCandidate: instaCandidates.length === 1 });
      }
      if (!enriched.twitter_url) {
        const raw = pickMatchingSocialUrl(twCandidates, 'twitter', _title, _host);
        if (raw) enriched.twitter_url = await validateSocialWithConfidence(raw, 'twitter', _title, _host, { isSoleCandidate: twCandidates.length === 1 });
      }
      if (!enriched.facebook_url) {
        const raw = pickMatchingSocialUrl(fbCandidates, 'facebook', _title, _host);
        if (raw) enriched.facebook_url = await validateSocialWithConfidence(raw, 'facebook', _title, _host, { isSoleCandidate: fbCandidates.length === 1 });
      }
      if (!enriched.linkedin_page_url) {
        const raw = pickMatchingSocialUrl(liCandidates, 'linkedin', _title, _host);
        if (raw) enriched.linkedin_page_url = await validateSocialWithConfidence(raw, 'linkedin', _title, _host, { isSoleCandidate: liCandidates.length === 1 });
      }
      if (!enriched.tiktok_url)       enriched.tiktok_url       = homeHrefs.find(h => h.toLowerCase().includes('tiktok.com/')) || null;

      // YouTube channel — only @handle or /channel/ or /c/ style URLs (not individual videos or playlists)
      if (!enriched.youtube_url) {
        const ytCandidates = homeHrefs.filter(h => {
          const lower = h.toLowerCase();
          return lower.includes('youtube.com') && (
            lower.includes('youtube.com/@') ||
            lower.includes('youtube.com/channel/') ||
            lower.includes('youtube.com/c/')
          ) && !lower.includes('/watch') && !lower.includes('/playlist') && !lower.includes('/shorts');
        });
        enriched.youtube_url = pickMatchingSocialUrl(ytCandidates, 'youtube', _title, _host) || (ytCandidates.length === 1 ? ytCandidates[0] : null);
      }

      // Extract guest application URL
      if (!enriched.guest_application_url) {
        enriched.guest_application_url = extractLinkByKeywords(
          homepageHtml, siteUrl, GUEST_PATH_KEYWORDS
        );
      }

      // Extract booking page URL
      if (!enriched.booking_page_url) {
        enriched.booking_page_url = extractLinkByKeywords(
          homepageHtml, siteUrl, BOOKING_PATH_KEYWORDS
        );
      }

      // Detect guest history from homepage content
      const lowerHtml = homepageHtml.toLowerCase();
      if (!enriched.has_guest_history) {
        enriched.has_guest_history =
          lowerHtml.includes('past guest') ||
          lowerHtml.includes('previous guest') ||
          lowerHtml.includes('featured guest') ||
          lowerHtml.includes('our guests') ||
          lowerHtml.includes('notable guest');
      }
    }

    // ──────────────────────────────────────────────────
    // 2. Check supplementary pages in PARALLEL if email not found
    // ──────────────────────────────────────────────────
    if (!enriched.contact_email) {
      const supplementaryPaths = ['/contact', '/about', '/work-with-us', '/guest', '/be-a-guest', '/podcast-guest'];

      const pageResults = await Promise.allSettled(
        supplementaryPaths.map(async (path) => {
          try {
            const pageUrl = new URL(path, siteUrl).href;
            const html = await fetchHtml(pageUrl);
            if (!html) return null;
            return {
              email:   extractEmail(html),
              guest:   extractLinkByKeywords(html, siteUrl, GUEST_PATH_KEYWORDS),
              booking: extractLinkByKeywords(html, siteUrl, BOOKING_PATH_KEYWORDS),
            };
          } catch { return null; }
        })
      );

      for (const result of pageResults) {
        if (result.status !== 'fulfilled' || !result.value) continue;
        const { email, guest, booking } = result.value;
        if (!enriched.contact_email && email)               enriched.contact_email        = email;
        if (!enriched.guest_application_url && guest)       enriched.guest_application_url = guest;
        if (!enriched.booking_page_url && booking)          enriched.booking_page_url      = booking;
      }
    }

    // ──────────────────────────────────────────────────
    // 3. YouTube subscriber count
    // ──────────────────────────────────────────────────
    if (enriched.youtube_url && !enriched.youtube_subscribers) {
      try {
        const ytHtml = await fetchHtml(enriched.youtube_url);
        if (ytHtml) {
          enriched.youtube_subscribers = extractYoutubeSubscribers(ytHtml);
        }
      } catch {
        // YouTube fetch failed, skip
      }
    }

    // Validate contact email has a real MX record
    // Skip MX check if email came from RSS feed — iTunes emails are always real
    const emailFromRss = podcastData.rss_feed_url && enriched.contact_email === podcastData.contact_email;
    if (enriched.contact_email && !emailFromRss) {
      const valid = await hasMxRecord(enriched.contact_email);
      if (!valid) {
        logger.warn('Email failed MX validation, clearing', { email: enriched.contact_email, title: podcastData.title });
        enriched.contact_email = null;
      }
    }

    // ──────────────────────────────────────────────────
    // 3. Rephonic — estimated monthly listeners
    //    Search by podcast title, scrape the first result's listener count.
    //    Only runs if we don't already have this data.
    // ──────────────────────────────────────────────────
    if (!enriched.estimated_monthly_listeners && podcastData.title) {
      try {
        const searchQuery = encodeURIComponent(podcastData.title.trim());
        const rephonicUrl = `https://rephonic.com/podcasts?q=${searchQuery}`;
        const rephonicHtml = await fetchHtml(rephonicUrl);
        if (rephonicHtml) {
          const $r = cheerio.load(rephonicHtml);
          // Rephonic renders listener count in elements like "X,XXX listeners per month" or "X.XK listeners"
          let found = null;
          $r('*').each((_, el) => {
            if (found) return false;
            const text = $r(el).text().trim();
            // Match patterns: "12,400 listeners", "12.4K listeners", "1.2M listeners"
            const m = text.match(/^([\d,]+(?:\.\d+)?[KkMm]?)\s+listeners?\s+per\s+month/i) ||
                      text.match(/^([\d,]+(?:\.\d+)?[KkMm]?)\s+monthly\s+listeners?/i);
            if (m) {
              const raw = m[1].replace(/,/g, '');
              let val = parseFloat(raw);
              if (/[Mm]$/.test(raw)) val *= 1000000;
              else if (/[Kk]$/.test(raw)) val *= 1000;
              if (val > 0) found = Math.round(val);
            }
          });
          if (found) {
            enriched.estimated_monthly_listeners = found;
            logger.info('Rephonic listeners scraped', { title: podcastData.title, listeners: found });
          }
        }
      } catch (rephonicErr) {
        logger.debug('Rephonic scrape failed (non-blocking)', { title: podcastData.title, error: rephonicErr.message });
      }
    }

    enriched.enriched_at = new Date().toISOString();
  } catch (err) {
    logger.error('Enrichment failed for podcast', {
      title: podcastData.title,
      website,
      error: err.message,
    });
  }

  logger.info('Enrichment result', {
    title: podcastData.title,
    hasEmail: !!enriched.contact_email,
    hasWebsite: !!enriched.website,
    hasRss: !!enriched.rss_feed_url,
    hasSocial: !!(enriched.instagram_url || enriched.twitter_url || enriched.linkedin_page_url),
  });

  return enriched;
}

module.exports = { enrichPodcast, fetchRssFeed };
