'use strict';

/**
 * Site Social Grab — scrapes a podcast website's HTML for social links,
 * validates each one against the platform's URL pattern + existing
 * BLOCKED_GENERIC_SOCIALS list, returns only confidence-validated URLs.
 *
 * Zero hallucination: if no website OR no social anchors, returns nothing.
 *
 * Used as a follow-on to the unlock flow + as a standalone endpoint.
 */

const cheerio = require('cheerio');
const logger = require('../lib/logger');

const FETCH_TIMEOUT_MS = 8000;

// Same blocklist used by enrichment.js — never store these
const BLOCKED_PATTERNS = [
  'instagram.com/p/', 'instagram.com/explore/', 'instagram.com/reel/', 'instagram.com/reels/',
  'instagram.com/instagram', 'instagram.com/eventbrite', 'instagram.com/luma', 'instagram.com/sessionize',
  'twitter.com/share', 'twitter.com/intent', 'twitter.com/podcasts', 'twitter.com/instagram',
  'twitter.com/youtube', 'twitter.com/facebook', 'twitter.com/tiktok', 'twitter.com/eventbrite',
  'twitter.com/sessionize', 'twitter.com/papercall',
  'x.com/share', 'x.com/intent', 'x.com/podcasts',
  'facebook.com/sharer', 'facebook.com/dialog', 'facebook.com/eventbrite', 'facebook.com/meetup',
  'tiktok.com/@tiktok', 'tiktok.com/discover',
  'linkedin.com/shareArticle', 'linkedin.com/sharing', 'linkedin.com/feed',
  'youtube.com/watch', 'youtube.com/embed', 'youtube.com/playlist', 'youtube.com/results',
];

function isBlocked(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return BLOCKED_PATTERNS.some(b => lower.includes(b));
}

async function fetchHtml(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FindAPodcastBot/1.0)' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    return null;
  }
}

/**
 * Extract validated social URLs from raw HTML using anchor parsing.
 * Returns { instagram_url, twitter_url, facebook_url, linkedin_url, youtube_url, tiktok_url }
 * Each is null if no valid URL found.
 */
function extractFromHtml(html) {
  const out = {
    instagram_url: null,
    twitter_url:   null,
    facebook_url:  null,
    linkedin_url:  null,
    youtube_url:   null,
    tiktok_url:    null,
  };
  if (!html) return out;

  let $;
  try { $ = cheerio.load(html); } catch { return out; }

  const hrefs = [];
  $('a[href]').each((_, el) => {
    const h = ($(el).attr('href') || '').trim();
    if (!h) return;
    if (h.startsWith('http')) hrefs.push(h);
    else if (h.startsWith('//')) hrefs.push('https:' + h);
  });

  const validate = (url, platform) => {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      const path = u.pathname.toLowerCase();
      if (isBlocked(url)) return null;

      if (platform === 'instagram') {
        if (!host.includes('instagram.com')) return null;
        const m = path.match(/^\/([a-z0-9_.]{2,30})\/?$/);
        if (!m) return null;
        if (['p','explore','reel','reels','tv','stories','direct','about','accounts'].includes(m[1])) return null;
        return `https://www.instagram.com/${m[1]}/`;
      }
      if (platform === 'twitter') {
        if (!host.includes('twitter.com') && !host.includes('x.com')) return null;
        const m = path.match(/^\/([a-z0-9_]{1,15})\/?$/);
        if (!m) return null;
        if (['share','intent','search','home','login','signup','i'].includes(m[1])) return null;
        return `https://twitter.com/${m[1]}`;
      }
      if (platform === 'facebook') {
        if (!host.includes('facebook.com')) return null;
        if (path.startsWith('/sharer') || path.startsWith('/dialog') || path.startsWith('/login')) return null;
        const m = path.match(/^\/([a-z0-9.\-]{3,})\/?$/i);
        if (!m) return null;
        return `https://www.facebook.com/${m[1]}`;
      }
      if (platform === 'linkedin') {
        if (!host.includes('linkedin.com')) return null;
        const m = path.match(/^\/(?:company|in|school|showcase)\/[a-z0-9.\-_]+\/?$/i);
        if (!m) return null;
        return url.split('?')[0].split('#')[0];
      }
      if (platform === 'youtube') {
        if (!host.includes('youtube.com')) return null;
        if (path.startsWith('/watch') || path.startsWith('/embed') || path.startsWith('/playlist')) return null;
        const m = path.match(/^\/(@[a-z0-9_.\-]+|c\/[a-z0-9_.\-]+|channel\/[a-z0-9_-]+|user\/[a-z0-9_.\-]+)\/?$/i);
        if (!m) return null;
        return url.split('?')[0];
      }
      if (platform === 'tiktok') {
        if (!host.includes('tiktok.com')) return null;
        const m = path.match(/^\/(@[a-z0-9_.\-]{1,30})\/?$/i);
        if (!m) return null;
        return `https://www.tiktok.com/${m[1]}`;
      }
    } catch { return null; }
    return null;
  };

  for (const h of hrefs) {
    if (!out.instagram_url) { const v = validate(h, 'instagram'); if (v) out.instagram_url = v; }
    if (!out.twitter_url)   { const v = validate(h, 'twitter');   if (v) out.twitter_url = v; }
    if (!out.facebook_url)  { const v = validate(h, 'facebook');  if (v) out.facebook_url = v; }
    if (!out.linkedin_url)  { const v = validate(h, 'linkedin');  if (v) out.linkedin_url = v; }
    if (!out.youtube_url)   { const v = validate(h, 'youtube');   if (v) out.youtube_url = v; }
    if (!out.tiktok_url)    { const v = validate(h, 'tiktok');    if (v) out.tiktok_url = v; }
  }

  return out;
}

/**
 * Grab social links from a podcast website. Tries the homepage, then
 * /contact, /about, /contact-us as fallbacks. Combines results (first
 * URL found per platform wins). Returns the same shape as extractFromHtml.
 */
async function grabFromWebsite(websiteUrl) {
  if (!websiteUrl) return null;
  let base;
  try { base = new URL(websiteUrl).origin; }
  catch { return null; }

  const tryPaths = ['', '/contact', '/about', '/contact-us', '/about-us'];
  const merged = {
    instagram_url: null, twitter_url: null, facebook_url: null,
    linkedin_url: null, youtube_url: null, tiktok_url: null,
  };

  for (const p of tryPaths) {
    const url = base + p;
    const html = await fetchHtml(url);
    if (!html) continue;
    const found = extractFromHtml(html);
    for (const [k, v] of Object.entries(found)) {
      if (!merged[k] && v) merged[k] = v;
    }
    // Once all 6 platforms found we can stop early
    if (Object.values(merged).every(v => v)) break;
  }

  return merged;
}

module.exports = { grabFromWebsite, extractFromHtml };
