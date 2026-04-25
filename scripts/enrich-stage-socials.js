'use strict';
/**
 * For each stage with a verified URL, scrape the event website and ONLY add
 * social links that are literally present on the page. Zero hallucination.
 *
 * Also tries to find a Facebook EVENT page (facebook.com/events/...) via
 * (a) the event's own website and (b) a Google CSE search restricted to
 * facebook.com/events with the event name + city.
 *
 * Plus uses Claude haiku-4.5 to extract structured "what to expect / who attends /
 * speaker format" sections — only stored if Claude returns valid:true and the
 * page actually mentions speakers/audience info.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const FETCH_TIMEOUT = 8000;
const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_SEARCH_CX = process.env.GOOGLE_SEARCH_CX;

// Same blocklist patterns as enrichment.js — never store these
const BLOCKED_HANDLES = [
  // Generic platform corporate accounts
  'instagram.com/instagram', 'instagram.com/eventbrite', 'instagram.com/meetup', 'instagram.com/sessionize',
  'instagram.com/luma', 'instagram.com/papercall',
  'twitter.com/eventbrite', 'twitter.com/meetup', 'twitter.com/sessionize', 'twitter.com/papercall',
  'twitter.com/instagram', 'twitter.com/youtube', 'twitter.com/facebook', 'twitter.com/tiktok',
  'twitter.com/podcasts', 'x.com/podcasts',
  'facebook.com/eventbrite', 'facebook.com/meetup',
  // Single-letter / placeholder
  'instagram.com/p/', 'instagram.com/explore/', 'instagram.com/reel/',
  'twitter.com/share', 'twitter.com/intent',
  'facebook.com/sharer', 'facebook.com/dialog',
];

function isBlocked(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return BLOCKED_HANDLES.some(b => lower.includes(b));
}

// Extract validated social URLs from HTML using anchor parsing
function extractSocials(html, baseUrl) {
  const out = { instagram_url: null, twitter_url: null, facebook_url: null, facebook_event_url: null, linkedin_url: null, youtube_url: null, tiktok_url: null };
  if (!html) return out;
  let $;
  try { $ = cheerio.load(html); } catch { return out; }

  const hrefs = [];
  $('a[href]').each((_, el) => {
    const h = ($(el).attr('href') || '').trim();
    if (h && (h.startsWith('http') || h.startsWith('//'))) hrefs.push(h.startsWith('//') ? 'https:' + h : h);
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
        if (['p','explore','reel','reels','tv','stories','direct'].includes(m[1])) return null;
        return `https://www.instagram.com/${m[1]}/`;
      }
      if (platform === 'twitter') {
        if (!host.includes('twitter.com') && !host.includes('x.com')) return null;
        const m = path.match(/^\/([a-z0-9_]{1,15})\/?$/);
        if (!m) return null;
        if (['share','intent','search','home'].includes(m[1])) return null;
        return `https://twitter.com/${m[1]}`;
      }
      if (platform === 'facebook_page') {
        if (!host.includes('facebook.com')) return null;
        if (path.startsWith('/events/')) return null; // event pages handled separately
        if (path.startsWith('/sharer') || path.startsWith('/dialog')) return null;
        const m = path.match(/^\/([a-z0-9.\-]{3,})\/?$/i);
        if (!m) return null;
        return `https://www.facebook.com/${m[1]}`;
      }
      if (platform === 'facebook_event') {
        if (!host.includes('facebook.com')) return null;
        if (!path.startsWith('/events/')) return null;
        const m = path.match(/^\/events\/(\d+|[a-z0-9-]+)/);
        if (!m) return null;
        return `https://www.facebook.com/events/${m[1]}`;
      }
      if (platform === 'linkedin') {
        if (!host.includes('linkedin.com')) return null;
        const m = path.match(/^\/(?:company|in|school|showcase)\/[a-z0-9.\-_]+\/?$/i);
        if (!m) return null;
        return url.split('?')[0];
      }
      if (platform === 'youtube') {
        if (!host.includes('youtube.com')) return null;
        if (path.includes('/watch') || path.includes('/embed') || path.includes('/playlist')) return null;
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
    if (!out.instagram_url) {
      const v = validate(h, 'instagram'); if (v) out.instagram_url = v;
    }
    if (!out.twitter_url) {
      const v = validate(h, 'twitter'); if (v) out.twitter_url = v;
    }
    if (!out.facebook_event_url) {
      const v = validate(h, 'facebook_event'); if (v) out.facebook_event_url = v;
    }
    if (!out.facebook_url) {
      const v = validate(h, 'facebook_page'); if (v) out.facebook_url = v;
    }
    if (!out.linkedin_url) {
      const v = validate(h, 'linkedin'); if (v) out.linkedin_url = v;
    }
    if (!out.youtube_url) {
      const v = validate(h, 'youtube'); if (v) out.youtube_url = v;
    }
    if (!out.tiktok_url) {
      const v = validate(h, 'tiktok'); if (v) out.tiktok_url = v;
    }
  }
  return out;
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FindAPodcastBot/1.0)' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

async function findFacebookEventViaGoogle(eventName, city) {
  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_CX) return null;
  const q = encodeURIComponent(`site:facebook.com/events "${eventName}"${city ? ` "${city}"` : ''}`);
  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_SEARCH_API_KEY}&cx=${GOOGLE_SEARCH_CX}&q=${q}&num=3`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) return null;
    const j = await res.json();
    for (const item of j.items || []) {
      const link = item.link || '';
      if (/^https?:\/\/(?:www\.)?facebook\.com\/events\/(\d+|[a-z0-9-]+)/i.test(link)) {
        return link.split('?')[0];
      }
    }
  } catch {}
  return null;
}

async function claudeExtractDetails(html, stage) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const client = new Anthropic();
    const text = (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 6000);
    const prompt = `Extract networking-event details from this webpage text. Reply with ONLY JSON.

Event: "${stage.name}"
Page text:
${text}

Return:
{
  "valid": true | false,
  "what_to_expect": "1-2 sentences on the format (e.g. '2-hour evening with 4 speaker slots, panel Q&A, networking drinks')",
  "who_attends": "1-2 sentences on the typical attendee profile",
  "speaker_format": "1 sentence on speaker slots if any (keynote, panel, lightning, fireside, Q&A only, etc.)"
}

Rules:
- valid=false if the page does NOT actually describe this event clearly.
- If a field can't be confidently determined from the text, set it to null. Never guess.
- Keep each field under 200 characters.`;

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    const t = msg.content?.[0]?.text || '';
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!parsed.valid) return null;
    return parsed;
  } catch { return null; }
}

(async () => {
  const { data: stages, error } = await s.from('stages').select('*').not('contact_unlocked_at', 'is', null);
  if (error) { console.error(error); process.exit(1); }
  console.log(`Enriching socials + descriptions for ${stages.length} verified stages…\n`);

  let updated = 0, withSocial = 0, withFbEvent = 0, withDetails = 0;

  for (const stg of stages) {
    const html = await fetchPage(stg.url);
    if (!html) {
      console.log('SKIP (no page):', stg.name.slice(0, 50));
      continue;
    }

    const socials = extractSocials(html, stg.url);

    // If no Facebook event found on page, try Google CSE
    if (!socials.facebook_event_url) {
      const fbEvent = await findFacebookEventViaGoogle(stg.name, stg.location_city);
      if (fbEvent) socials.facebook_event_url = fbEvent;
    }

    // Claude pass for what-to-expect / who-attends / speaker format
    const details = await claudeExtractDetails(html, stg);

    const updates = {};
    let socialCount = 0;
    for (const [k, v] of Object.entries(socials)) {
      if (v) { updates[k] = v; socialCount++; }
    }
    if (details) {
      if (details.what_to_expect) updates.what_to_expect = details.what_to_expect;
      if (details.who_attends) updates.who_attends = details.who_attends;
      if (details.speaker_format) updates.speaker_format = details.speaker_format;
    }

    if (Object.keys(updates).length > 0) {
      const { error: upErr } = await s.from('stages').update(updates).eq('id', stg.id);
      if (upErr) {
        console.log('UPDATE FAIL:', stg.name.slice(0, 40), upErr.message);
      } else {
        updated++;
        if (socialCount > 0) withSocial++;
        if (socials.facebook_event_url) withFbEvent++;
        if (details) withDetails++;
        const tags = [];
        if (socials.instagram_url) tags.push('IG');
        if (socials.twitter_url) tags.push('X');
        if (socials.facebook_url) tags.push('FB');
        if (socials.facebook_event_url) tags.push('FB-EVENT');
        if (socials.linkedin_url) tags.push('LI');
        if (socials.youtube_url) tags.push('YT');
        if (socials.tiktok_url) tags.push('TT');
        if (details) tags.push('+details');
        console.log('OK', stg.name.slice(0, 40).padEnd(40), '|', tags.join(' ') || '(no socials found)');
      }
    } else {
      console.log('—— ', stg.name.slice(0, 40).padEnd(40), '| no socials or details found on page');
    }
  }

  console.log('');
  console.log('SUMMARY');
  console.log('  Stages enriched:', updated, '/', stages.length);
  console.log('  With social link(s):', withSocial);
  console.log('  With Facebook EVENT page:', withFbEvent);
  console.log('  With Claude-extracted details:', withDetails);
})();
