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

    // Website from <link> (skip atom:link)
    $('channel > link').each((_, el) => {
      if (!result.website) {
        const text = $(el).text().trim();
        if (text && text.startsWith('http')) result.website = text;
      }
    });

    // Description from <description>
    const desc = $('channel > description').first().text().trim();
    if (desc) result.description = desc;

    // Social links — collect all candidate URLs from atom:link and full XML scan,
    // then validate each one. Only store confirmed profile URLs.
    const socialScanPatterns = [
      { key: 'instagram_url',    platform: 'instagram', domain: 'instagram.com' },
      { key: 'twitter_url',      platform: 'twitter',   domain: 'twitter.com' },
      { key: 'twitter_url',      platform: 'twitter',   domain: 'x.com' },
      { key: 'facebook_url',     platform: 'facebook',  domain: 'facebook.com' },
      { key: 'linkedin_page_url',platform: 'linkedin',  domain: 'linkedin.com' },
    ];

    // Collect all atom:link hrefs
    const atomHrefs = [];
    $('atom\\:link').each((_, el) => { const h = $(el).attr('href'); if (h) atomHrefs.push(h); });

    for (const { key, platform, domain } of socialScanPatterns) {
      if (result[key]) continue;
      // From atom:link
      const fromAtom = pickBestSocialUrl(atomHrefs.filter(h => h.toLowerCase().includes(domain)), platform);
      if (fromAtom) { result[key] = fromAtom; continue; }
      // From full XML regex scan — collect ALL matches first, then pick best
      const regex = new RegExp(`https?://(?:[a-z0-9-]+\\.)?${domain.replace('.', '\\.')}[^\\s"'<>\\]]+`, 'gi');
      const xmlMatches = [...(xml.matchAll(regex) || [])].map(m => m[0]);
      const fromXml = pickBestSocialUrl(xmlMatches, platform);
      if (fromXml) result[key] = fromXml;
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
      for (const [key, val] of Object.entries(rssData)) {
        if (val && !enriched[key]) enriched[key] = val;
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
        for (const [k, v] of Object.entries(rssData)) {
          if (!enriched[k] && v) enriched[k] = v;
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

      if (!enriched.instagram_url) enriched.instagram_url = pickBestSocialUrl(ltHrefs.filter(h => h.toLowerCase().includes('instagram.com')), 'instagram');
      if (!enriched.facebook_url)  enriched.facebook_url  = pickBestSocialUrl(ltHrefs.filter(h => h.toLowerCase().includes('facebook.com')), 'facebook');
      if (!enriched.twitter_url)   enriched.twitter_url   = pickBestSocialUrl(ltHrefs.filter(h => h.toLowerCase().includes('twitter.com') || h.toLowerCase().includes('x.com')), 'twitter');
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

      if (!enriched.instagram_url)    enriched.instagram_url    = pickBestSocialUrl(homeHrefs.filter(h => h.toLowerCase().includes('instagram.com')), 'instagram');
      if (!enriched.twitter_url)      enriched.twitter_url      = pickBestSocialUrl(homeHrefs.filter(h => h.toLowerCase().includes('twitter.com') || h.toLowerCase().includes('x.com')), 'twitter');
      if (!enriched.facebook_url)     enriched.facebook_url     = pickBestSocialUrl(homeHrefs.filter(h => h.toLowerCase().includes('facebook.com')), 'facebook');
      if (!enriched.linkedin_page_url) enriched.linkedin_page_url = pickBestSocialUrl(homeHrefs.filter(h => h.toLowerCase().includes('linkedin.com')), 'linkedin');
      if (!enriched.tiktok_url)       enriched.tiktok_url       = homeHrefs.find(h => h.toLowerCase().includes('tiktok.com/')) || null;

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
