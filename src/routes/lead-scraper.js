'use strict';

const express    = require('express');
const logger     = require('../lib/logger');

const router = express.Router();

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const HUNTER_API_KEY  = process.env.HUNTER_API_KEY;
const OPERATOR_SECRET = process.env.OPERATOR_SECRET;

const RSS_FEEDS = [
  { name: 'Faith Driven Entrepreneur',   url: 'https://feeds.transistor.fm/faith-driven-entrepreneur' },
  { name: 'Carey Nieuwhof Leadership',   url: 'https://feeds.transistor.fm/carey-nieuwhof-leadership-podcast' },
  { name: 'Kingdom Driven Entrepreneur', url: 'https://feeds.libsyn.com/520878/rss' },
];

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

async function findEmail(fullName) {
  try {
    const nameParts = fullName.trim().split(' ');
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(' ');
    const url = `https://api.hunter.io/v2/email-finder?first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&api_key=${HUNTER_API_KEY}`;
    const res  = await fetchWithTimeout(url);
    const data = await res.json();
    if (data.data && data.data.email && (data.data.score || 0) >= 70) {
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

router.post('/scrape-leads', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (!OPERATOR_SECRET || secret !== OPERATOR_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorised' });
  }

  let found = 0, added = 0, skipped = 0;

  try {
    const allGuests = [];
    for (const feed of RSS_FEEDS) {
      const guests = await scrapeRSS(feed);
      allGuests.push(...guests);
    }

    found = allGuests.length;
    logger.info('lead-scraper: total guests found', { found });

    const seen   = new Set();
    const unique = allGuests.filter(g => {
      if (seen.has(g.name)) return false;
      seen.add(g.name);
      return true;
    });

    for (const guest of unique) {
      const enriched = await findEmail(guest.name);
      if (!enriched) { skipped++; continue; }

      const exists = await contactExistsInGHL(enriched.email);
      if (exists) { skipped++; continue; }

      const ok = await addToGHL(enriched.firstName, enriched.lastName, enriched.email, guest.podcast);
      if (ok) {
        added++;
        logger.info('lead-scraper: contact added', { name: guest.name, email: enriched.email });
      } else {
        skipped++;
      }
    }

    return res.json({ success: true, found, added, skipped });
  } catch (err) {
    logger.error('lead-scraper: unexpected error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
