'use strict';

const crypto  = require('crypto');
const express = require('express');
const logger  = require('../lib/logger');

const router = express.Router();

const GHL_API_KEY       = process.env.GHL_API_KEY;
const GHL_LOCATION_ID   = process.env.GHL_LOCATION_ID;
const HUNTER_API_KEY    = process.env.HUNTER_API_KEY;
const OPERATOR_SECRET   = process.env.OPERATOR_SECRET;
const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const LEADS_SPREADSHEET_ID  = process.env.LEADS_SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL      = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

const RSS_FEEDS = [
  { name: 'Faith Driven Entrepreneur',      url: 'https://feeds.transistor.fm/faith-driven-entrepreneur' },
  { name: 'Carey Nieuwhof Leadership',      url: 'https://feeds.transistor.fm/carey-nieuwhof-leadership-podcast' },
  { name: 'Kingdom Driven Entrepreneur',    url: 'https://feeds.libsyn.com/520878/rss' },
  { name: 'Entrepreneurs on Fire',          url: 'https://feeds.libsyn.com/51722/rss' },
  { name: 'How I Built This',               url: 'https://feeds.npr.org/510313/podcast.xml' },
  { name: 'The Tim Ferriss Show',           url: 'https://feeds.megaphone.fm/FST3928562931' },
  { name: 'Masters of Scale',               url: 'https://feeds.megaphone.fm/MASTERS' },
  { name: 'SmartPassive Income',            url: 'https://feeds.libsyn.com/21612/rss' },
  { name: 'The Goal Digger Podcast',        url: 'https://feeds.libsyn.com/126625/rss' },
  { name: 'Online Marketing Made Easy',     url: 'https://feeds.libsyn.com/38699/rss' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractGuestName(title) {
  const patterns = [
    /with\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/,
    /feat(?:uring)?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i,
    /interview[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i,
    /guest[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i,
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

async function fetchWithTimeout(url, options = {}, ms = 10000) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ── Google Sheets JWT auth ────────────────────────────────────────────────────

function createJWT(serviceAccountEmail, privateKey) {
  const now     = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss:   serviceAccountEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const sign         = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64url');
  return `${signingInput}.${signature}`;
}

async function getAccessToken(serviceAccountEmail, privateKey) {
  const jwt = createJWT(serviceAccountEmail, privateKey);
  const res  = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  return data.access_token;
}

// ── Google Sheets writer ──────────────────────────────────────────────────────

const SHEET_NAME_MAP = {
  'RSS Podcasts':    'RSS Podcasts',
  'YouTube':         'YouTube',
  'Apple Podcasts':  'Apple Podcasts',
};

async function writeToGoogleSheet(leads, source) {
  try {
    if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !LEADS_SPREADSHEET_ID) {
      logger.info('lead-scraper: Google Sheets env vars not set, skipping sheet write', { source });
      return false;
    }
    if (!leads || leads.length === 0) return false;

    const privateKey = (GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!privateKey) {
      logger.warn('lead-scraper: GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY not set, skipping', { source });
      return false;
    }

    const token     = await getAccessToken(GOOGLE_SERVICE_ACCOUNT_EMAIL, privateKey);
    const sheetName = SHEET_NAME_MAP[source] || 'Other';
    const sheetsBase = `https://sheets.googleapis.com/v4/spreadsheets/${LEADS_SPREADSHEET_ID}`;
    const authHeader = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // Get spreadsheet metadata to check if the sheet tab exists
    const metaRes  = await fetchWithTimeout(`${sheetsBase}?fields=sheets.properties.title`, { headers: authHeader });
    const metaData = await metaRes.json();
    const existingSheets = (metaData.sheets || []).map(s => s.properties.title);

    if (!existingSheets.includes(sheetName)) {
      // Create the sheet tab
      const addRes = await fetchWithTimeout(`${sheetsBase}:batchUpdate`, {
        method:  'POST',
        headers: authHeader,
        body:    JSON.stringify({
          requests: [{ addSheet: { properties: { title: sheetName } } }],
        }),
      });
      if (!addRes.ok) {
        const errText = await addRes.text();
        logger.warn('lead-scraper: failed to create sheet tab', { sheetName, status: addRes.status, errText });
        return false;
      }

      // Write header row
      const headerRange = `${sheetName}!A1:F1`;
      await fetchWithTimeout(`${sheetsBase}/values/${encodeURIComponent(headerRange)}?valueInputOption=RAW`, {
        method:  'PUT',
        headers: authHeader,
        body:    JSON.stringify({
          range:          headerRange,
          majorDimension: 'ROWS',
          values:         [['Date Added', 'Full Name', 'Email', 'Source', 'Podcast/Channel', 'Status']],
        }),
      });
    }

    // Build rows
    const today = new Date().toISOString().slice(0, 10);
    const rows  = leads.map(lead => [
      today,
      `${lead.firstName} ${lead.lastName}`.trim(),
      lead.email   || '',
      lead.source  || source,
      lead.podcast || '',
      'New',
    ]);

    // Append rows
    const appendUrl = `${sheetsBase}/values/${encodeURIComponent(sheetName)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const appendRes = await fetchWithTimeout(appendUrl, {
      method:  'POST',
      headers: authHeader,
      body:    JSON.stringify({ majorDimension: 'ROWS', values: rows }),
    });

    if (!appendRes.ok) {
      const errText = await appendRes.text();
      logger.warn('lead-scraper: Sheets append failed', { source, status: appendRes.status, errText });
      return false;
    }

    logger.info('lead-scraper: Sheets rows appended', { source, rows: rows.length });
    return true;
  } catch (err) {
    logger.warn('lead-scraper: writeToGoogleSheet error', { source, error: err.message });
    return false;
  }
}

// ── Scrapers ─────────────────────────────────────────────────────────────────

async function scrapeRSS(feed) {
  try {
    const res  = await fetchWithTimeout(feed.url);
    const text = await res.text();
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const guests = [];

    const items = text.match(/<item>([\s\S]*?)<\/item>/g) || [];
    for (const item of items) {
      const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
      if (pubDateMatch) {
        const pubDate = new Date(pubDateMatch[1]).getTime();
        if (pubDate < thirtyDaysAgo) continue;
      }
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                         item.match(/<title>(.*?)<\/title>/);
      if (titleMatch) {
        const guest = extractGuestName(titleMatch[1]);
        if (guest) guests.push({ name: guest, podcast: feed.name });
      }
    }
    logger.info('lead-scraper: RSS scraped', { feed: feed.name, guests: guests.length });
    return guests;
  } catch (err) {
    logger.warn('lead-scraper: RSS fetch failed', { feed: feed.name, error: err.message });
    return [];
  }
}

async function scrapeYouTube() {
  try {
    if (!GOOGLE_SEARCH_API_KEY) {
      logger.info('lead-scraper: GOOGLE_SEARCH_API_KEY not set, skipping YouTube scrape');
      return [];
    }
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=christian+entrepreneur+interview&type=video&maxResults=25&key=${GOOGLE_SEARCH_API_KEY}`;
    const res  = await fetchWithTimeout(url);
    const data = await res.json();

    if (!data.items) {
      logger.warn('lead-scraper: YouTube API returned no items', { data });
      return [];
    }

    const guests = [];
    for (const item of data.items) {
      const title       = item.snippet && item.snippet.title ? item.snippet.title : '';
      const channelName = item.snippet && item.snippet.channelTitle ? item.snippet.channelTitle : 'YouTube';
      const guest       = extractGuestName(title);
      if (guest) guests.push({ name: guest, podcast: channelName });
    }
    logger.info('lead-scraper: YouTube scraped', { guests: guests.length });
    return guests;
  } catch (err) {
    logger.warn('lead-scraper: YouTube scrape failed', { error: err.message });
    return [];
  }
}

async function scrapeApplePodcasts() {
  try {
    const searchUrl = 'https://itunes.apple.com/search?term=christian+entrepreneur+podcast&media=podcast&limit=10';
    const searchRes  = await fetchWithTimeout(searchUrl);
    const searchData = await searchRes.json();

    if (!searchData.results || searchData.results.length === 0) {
      logger.info('lead-scraper: Apple Podcasts search returned no results');
      return [];
    }

    const guests = [];
    for (const podcast of searchData.results) {
      const podcastId   = podcast.collectionId;
      const podcastName = podcast.collectionName || 'Apple Podcasts';
      try {
        const epUrl  = `https://itunes.apple.com/lookup?id=${podcastId}&media=podcast&entity=podcastEpisode&limit=20`;
        const epRes  = await fetchWithTimeout(epUrl);
        const epData = await epRes.json();

        if (!epData.results) continue;
        // First result is the podcast itself; rest are episodes
        for (const ep of epData.results.slice(1)) {
          const title = ep.trackName || '';
          const guest = extractGuestName(title);
          if (guest) guests.push({ name: guest, podcast: podcastName });
        }
      } catch (epErr) {
        logger.warn('lead-scraper: Apple Podcasts episode fetch failed', { podcastId, error: epErr.message });
      }
    }
    logger.info('lead-scraper: Apple Podcasts scraped', { guests: guests.length });
    return guests;
  } catch (err) {
    logger.warn('lead-scraper: Apple Podcasts scrape failed', { error: err.message });
    return [];
  }
}

// ── GHL helpers ───────────────────────────────────────────────────────────────

async function findEmail(fullName) {
  try {
    const nameParts = fullName.trim().split(' ');
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(' ');
    const url = `https://api.hunter.io/v2/email-finder?first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${HUNTER_API_KEY}`;
    const res  = await fetchWithTimeout(url);
    const data = await res.json();
    if (data.data && data.data.email && (data.data.score || 0) >= 50) {
      return { email: data.data.email, firstName, lastName };
    }
    return null;
  } catch (err) {
    logger.warn('lead-scraper: Hunter lookup failed', { name: fullName, error: err.message });
    return null;
  }
}

async function contactExistsInGHL(email) {
  try {
    const res  = await fetchWithTimeout(
      `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' } }
    );
    const data = await res.json();
    return (data.contacts && data.contacts.length > 0);
  } catch (err) {
    logger.warn('lead-scraper: GHL dedup check failed', { email, error: err.message });
    return false;
  }
}

async function addToGHL(firstName, lastName, email, podcast) {
  try {
    const res = await fetchWithTimeout('https://services.leadconnectorhq.com/contacts/', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        firstName,
        lastName,
        email,
        locationId: GHL_LOCATION_ID,
        tags: ['cold-christian-leads'],
        source: `Podcast Guest Scraper - ${podcast}`,
      }),
    });
    return res.ok;
  } catch (err) {
    logger.warn('lead-scraper: GHL add failed', { email, error: err.message });
    return false;
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get('/scrape-debug', (req, res) => {
  const t = process.env.SCRAPER_TOKEN || '';
  res.json({ scraper_token_len: t.length, scraper_token_first6: t.slice(0,6) });
});

router.post('/scrape-leads', async (req, res) => {
  const secret         = (req.headers['x-cron-secret'] || '').trim();
  const expectedSecret = (process.env.SCRAPER_TOKEN || process.env.OPERATOR_SECRET || 'findapodcast-scrape-2026').trim();
  if (secret !== expectedSecret) {
    return res.status(401).json({ success: false, error: 'Unauthorised' });
  }

  let found = 0, added = 0, skipped = 0;

  try {
    // ── Scrape all sources ──────────────────────────────────────────────
    const rssRaw     = [];
    for (const feed of RSS_FEEDS) {
      const guests = await scrapeRSS(feed);
      rssRaw.push(...guests);
    }

    const youtubeRaw = await scrapeYouTube();
    const appleRaw   = await scrapeApplePodcasts();

    found = rssRaw.length + youtubeRaw.length + appleRaw.length;
    logger.info('lead-scraper: total guests found', { found });

    // ── Deduplicate across all sources combined ─────────────────────────
    const sourcedGuests = [
      ...rssRaw.map(g     => ({ ...g, sourceLabel: 'RSS Podcasts' })),
      ...youtubeRaw.map(g => ({ ...g, sourceLabel: 'YouTube' })),
      ...appleRaw.map(g   => ({ ...g, sourceLabel: 'Apple Podcasts' })),
    ];

    const seen   = new Set();
    const unique = sourcedGuests.filter(g => {
      if (seen.has(g.name)) return false;
      seen.add(g.name);
      return true;
    });

    // ── Enrich + collect per-source leads (GHL disabled — review in Sheets first) ─────
    const rssLeads     = [];
    const youtubeLeads = [];
    const appleLeads   = [];

    for (const guest of unique) {
      const enriched = await findEmail(guest.name);
      if (!enriched) { skipped++; continue; }

      added++;
      logger.info('lead-scraper: lead enriched', { name: guest.name, email: enriched.email, source: guest.sourceLabel });

      const leadRecord = {
        firstName: enriched.firstName,
        lastName:  enriched.lastName,
        email:     enriched.email,
        source:    guest.sourceLabel,
        podcast:   guest.podcast,
      };

      if (guest.sourceLabel === 'YouTube')             youtubeLeads.push(leadRecord);
      else if (guest.sourceLabel === 'Apple Podcasts') appleLeads.push(leadRecord);
      else                                             rssLeads.push(leadRecord);
    }

    // ── Write to Google Sheets ──────────────────────────────────────────
    let sheetUpdated = false;
    const sheetResults = await Promise.all([
      writeToGoogleSheet(rssLeads,     'RSS Podcasts'),
      writeToGoogleSheet(youtubeLeads, 'YouTube'),
      writeToGoogleSheet(appleLeads,   'Apple Podcasts'),
    ]);
    if (sheetResults.some(Boolean)) sheetUpdated = true;

    // ── Response ────────────────────────────────────────────────────────
    return res.json({
      success: true,
      found,
      added,
      skipped,
      bySource: {
        'RSS Podcasts':   rssLeads.length,
        'YouTube':        youtubeLeads.length,
        'Apple Podcasts': appleLeads.length,
      },
      sheetUpdated,
    });
  } catch (err) {
    logger.error('lead-scraper: unexpected error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
