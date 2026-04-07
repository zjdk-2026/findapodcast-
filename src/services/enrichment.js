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
        'User-Agent': 'Mozilla/5.0 (compatible; PodcastPipelineBot/1.0; +https://podcastpipeline.com)',
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
    if (!isGenericEmail(email) && isValidEmailDomain(email)) return email;
  }

  // 2. Regex scan full HTML
  const matches = html.match(EMAIL_REGEX) || [];
  for (const email of matches) {
    const lower = email.toLowerCase();
    if (!isGenericEmail(lower) && isValidEmailDomain(lower) && !lower.includes('example.com') && !lower.includes('yourdomain')) {
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

    // Social links from atom:link href attributes and text content
    const socialPatterns = [
      { key: 'instagram_url', pattern: 'instagram.com' },
      { key: 'twitter_url',   pattern: 'twitter.com' },
      { key: 'twitter_url',   pattern: 'x.com' },
      { key: 'facebook_url',  pattern: 'facebook.com' },
      { key: 'linkedin_page_url', pattern: 'linkedin.com' },
    ];

    $('atom\\:link').each((_, el) => {
      const href = ($(el).attr('href') || '').toLowerCase();
      for (const { key, pattern } of socialPatterns) {
        if (!result[key] && href.includes(pattern)) {
          result[key] = $(el).attr('href');
        }
      }
    });

    // Also scan full XML text for social URLs
    for (const { key, pattern } of socialPatterns) {
      if (!result[key]) {
        const regex = new RegExp(`https?://(?:www\\.)?${pattern.replace('.', '\\.')}[^\\s"'<>]+`, 'i');
        const match = xml.match(regex);
        if (match) result[key] = match[0];
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
      $lt('a[href]').each((_, el) => {
        const raw  = $lt(el).attr('href') || '';
        const href = raw.toLowerCase();
        if (!enriched.instagram_url && href.includes('instagram.com'))                        enriched.instagram_url    = raw;
        if (!enriched.facebook_url  && href.includes('facebook.com'))                         enriched.facebook_url     = raw;
        if (!enriched.twitter_url   && (href.includes('twitter.com') || href.includes('x.com'))) enriched.twitter_url  = raw;
        if (!enriched.spotify_url   && href.includes('spotify.com/show'))                     enriched.spotify_url      = raw;
        if (!enriched.apple_url     && href.includes('podcasts.apple.com'))                   enriched.apple_url        = raw;
        if (!enriched.youtube_url   && href.includes('youtube.com'))                          enriched.youtube_url      = raw;
        // First non-social, non-linktree HTTP link = real website
        const SOCIAL_DOMAINS = ['instagram', 'facebook', 'twitter', 'x.com', 'youtube', 'tiktok', 'spotify', 'apple', 'linktr', 'linktree'];
        if (!enriched.website && raw.startsWith('http') && !SOCIAL_DOMAINS.some(s => href.includes(s))) {
          enriched.website = raw;
        }
      });
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

      // Extract social links from anchor hrefs
      const $home = cheerio.load(homepageHtml);
      $home('a[href]').each((_, el) => {
        const href = ($home(el).attr('href') || '').toLowerCase();
        if (!enriched.facebook_url  && href.includes('facebook.com'))  enriched.facebook_url  = $home(el).attr('href');
        if (!enriched.twitter_url   && (href.includes('twitter.com') || href.includes('x.com'))) enriched.twitter_url = $home(el).attr('href');
        if (!enriched.instagram_url && href.includes('instagram.com')) enriched.instagram_url = $home(el).attr('href');
        if (!enriched.tiktok_url    && href.includes('tiktok.com'))    enriched.tiktok_url    = $home(el).attr('href');
        if (!enriched.linkedin_page_url && href.includes('linkedin.com')) enriched.linkedin_page_url = $home(el).attr('href');
      });

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
