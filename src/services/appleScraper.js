
'use strict';

const cheerio = require('cheerio');
const supabase = require('../lib/supabase');
const logger = require('../lib/logger');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const FETCH_TIMEOUT = 15000;
const MAX_EPISODES = 5;

function extractAppleId(url) {
  if (!url) return null;
  const m = url.match(/\/id(\d{6,})/);
  return m ? m[1] : null;
}

function safeParse(text) {
  try { return JSON.parse(text); }
  catch (_) { return null; }
}

function deepFind(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = deepFind(item, key);
      if (r) return r;
    return r;
    }
    return null;
  }
  if (obj[key]) return obj[key];
  for (const v of Object.values(obj)) {
    const r = deepFind(v, key);
    if (r) return r;
  }
  return null;
}

function extractUrls(text) {
  if (!text) return {};
  const found = text.match(/https?:\/\/[^\s<"']+/g) || [];
  const r = {};
  for (const url of found) {
    const lo = url.toLowerCase();
    if (lo.includes('instagram.com') && !r.instagram_url)     r.instagram_url = url;
    else if (lo.includes('linkedin.com') && !r.linkedin_url)  r.linkedin_url = url;
    else if (lo.includes('facebook.com') && !r.facebook_url)  r.facebook_url = url;
    else if ((lo.includes('youtube.com') || lo.includes('youtu.be')) && !r.youtube_url) r.youtube_url = url;
    else if (lo.includes('tiktok.com') && !r.tiktok_url)     r.tiktok_url = url;
    else if ((lo.includes('twitter.com') || lo.includes('x.com')) && !r.twitter_url) r.twitter_url = url;
    else if (lo.includes('spotify.com') && !r.spotify_url)   r.spotify_url = url;
    else if ((lo.includes('calendly') || lo.includes('booking')) && !r.booking_page_url) r.booking_page_url = url;
    else if ((lo.includes('guest') || lo.includes('appear')) && !r.guest_application_url) r.guest_application_url = url;
    else if (!r.website && !lo.includes('apple.com') && !lo.includes('itunes')) r.website = url;
  }
  return r;
}

function extractEmails(text) {
  if (!text) return [];
  return text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
}

function extractPhones(text) {
  if (!text) return [];
  const found = text.match(/\+\b\d{1,3}[-.\s]?\d{1,4}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g) || [];
  return found.filter(p => {
    const digits = p.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15;
  });
}

// ────── Facebook sub-scraper ──────────────────────────────────────────────

async function scrapeFacebookPage(fbUrl) {
  if (!fbUrl) return {};
  try {
    const clean = fbUrl.replace(/^(https?:\/\/)?(www\.|m\.)?/, '').replace(/\?.*/, '').replace(/^facebook\.com\/?/, '');
    if (!clean) return {};
    const pageUrl = 'https://mbasic.facebook.com/' + clean;
    const res = await fetch(pageUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return {};
    const html = await res.text();
    const $ = cheerio.load(html);
    const info = {};
    const bt = $('body').text();
    const sw = bt.match(/https?:\/\/[^\s]+/);
    if (sw && !sw[0].toLowerCase().includes('facebook')) info.website = sw;
    const [email] = extractEmails(bt);
    if (email) info.email = email;
    const [phone] = extractPhones(bt);
    if (phone) info.phone = phone;
    try {
      const au = 'https://mbasic.facebook.com/' + clean + '/about';
      const ar = await fetch(au, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': USER_AGENT } });
      if (ar.ok) {
        const $a = cheerio.load(await ar.text());
        const at = $a('body').text();
        if (!info.website) { const w = at.match(/https?:\/\/[^\s]+/); if (w && !w[0].toLowerCase().includes('facebook')) info.website = w[0]; }
        if (!info.email) { const [e] = extractEmails(at); if (e) info.email = e; }
        if (!info.phone) { const [p] = extractPhones(at); if (p) info.phone = p; }
      }
    } catch (_) {}
    logger.info('appleScraper: FB scraped', { fbUrl, fields: Object.keys(info) });
    return info;
  } catch (_) { return {}; }
}

// ────── Core Apple page scraper ──────────────────────────────────────────────

async function scrapeApplePage(appleUrl) {
  if (!appleUrl) return { ok: false, data: null, error: 'no_url' };
  const appleId = extractAppleId(appleUrl);
  if (!appleId) return { ok: false, data: null, error: 'invalid_apple_id' };

  try {
    logger.debug('appleScraper: fetch', { appleUrl, appleId });

    const res = await fetch(appleUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!res.ok) return { ok: false, data: null, error: 'http_' + res.status };

    const html = await res.text();
    const $ = cheerio.load(html);
    const data = {};

    // ── JSON-LD ─────────────────────────────────────────────────────

    const ld = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      const p = safeParse($(el).html());
      if (p) ld.push(p);
    });

    const pld = ld.find(b => b['@type'] && String(b['@type']).includes('Podcast')) || ld[0] || null;

    if (pld) {
      if (pld.name)        data.title = pld.name;
      if (pld.description) data.description = pld.description;
      const auth = pld.author || (pld.creator || null);
      if (auth) data.host_name = typeof auth === 'string' ? auth : (auth.name || null);
      const rd = deepFind(pld, 'aggregateRating') || (pld.aggregateRating || null);
      if (rd) {
        if (rd.ratingValue) data.apple_rating = parseFloat(rd.ratingValue);
        if (rd.ratingCount) data.apple_review_count = parseInt(rd.ratingCount, 10);
      }
      const g = pld.genres || (pld.genre || null);
      if (g) {
        if (Array.isArray(g)) { const m = g.find(x => x !== 'Podcasts'); data.category = m || g[0]; }
        else if (typeof g === 'string') { data.category = g; }
      }
      if (pld.inLanguage) data.language = pld.inLanguage;
      if (pld.image) {
        const i = typeof pld.image === 'string' ? pld.image : (pld.image.url || null);
        if (i) data.image = i.replace(/\/\d+x\d+xbb(\.jpg|\.png)/, '/600x600bb$1');
      }
    }

    // ── Meta fallbacks ─────────────────────────────────────────────

    if (!data.description) data.description = $('meta[property="og:description"]').attr('content');
    if (!data.description) data.description = $('meta[name="description"]').attr('content');

    if (!data.category) {
      const cats = [];
      $('[data-testid="breadcrumb"] a').each((_, el) => {
        const t = $(el).text().trim();
        if (t && t !== 'Podcasts' && t !== 'Shows') cats.push(t);
      });
      if (cats.length) data.category = cats.join(' > ');
    }

    if (!data.apple_rating || !data.apple_review_count) {
      const rv = $('meta[itemprop="ratingValue"]').attr('content');
      const rc = $('meta[itemprop="ratingCount"]').attr('content');
      if (rv) data.apple_rating = parseFloat(rv);
      if (rc) data.apple_review_count = parseInt(rc, 10);
    }

    if (!data.host_name) {
      const el = $('[data-testid="host-name"], .host-name, .podcast-header__owner');
      if (el.length) data.host_name = el.first().text().trim();
    }

    const bodyText = $('body').text();

    // Chart rank
    const cm = bodyText.match(/(?:#|No\.?)\s*(\d+)\s+in\s+([A-Z][A-Za-z\s&-]{1,40}?)(?:\s*<|\.|,|$)/);
    if (cm) { data.apple_chart_rank = parseInt(cm[1], 10); data.apple_chart_category = cm[2].trim(); }
    const cs = bodyText.match(/Charted[^.]*(?:#|Top)\s*(\d+)\s+in\s+([A-Z][A-Za-z\s]{1,40}?)/i);
    if (cs) { data.apple_chart_rank = parseInt(cs[1], 10); data.apple_chart_category = cs[2].trim(); }

    // Ad flag
    data.has_ads = /contains\s+ads|sponsored|contains\s+advertisements/i.test(bodyText);

    // Episode notes
    let notes = '';
    for (const sel of ['[data-testid="episode-description"]', '.episode-description__content']) {
      $(sel).each((_, el) => { const t = $(el).text().trim(); if (t.length > 10) notes += t + '\n\n'; });
      if (notes) break;
    }
    if (!notes) {
      const scripts = $('script');
      for (let i = 0; i < Math.min(scripts.length, 5); i++) {
        const txt = $(scripts[i]).html() || '';
        const ds = txt.match(/"description"\s*:\s*"([^"]+)"/g);
        if (ds) {
          for (const d of ds.slice(0, MAX_EPISODES)) {
            const c = d.replace(/"description"\s*:\s*"/, '').replace(/"$/, '').replace(/\\"/g, '').replace(/\\n/g, ' ');
            if (c.length > 10) notes += c + '\n\n';
          }
          break;
        }
      }
    }

    // Extract from notes + description
    const src = notes + '\n' + (data.description || '');
    const urls = extractUrls(src);
    if (urls.instagram_url)          data.instagram_url = urls.instagram_url;
    if (urls.linkedin_url)           data.linkedin_url = urls.linkedin_url;
    if (urls.facebook_url)           data.facebook_url = urls.facebook_url;
    if (urls.youtube_url)            data.youtube_url = urls.youtube_url;
    if (urls.tiktok_url)             data.tiktok_url = urls.tiktok_url;
    if (urls.twitter_url)            data.twitter_url = urls.twitter_url;
    if (urls.spotify_url)            data.spotify_url = urls.spotify_url;
    if (urls.booking_page_url)       data.booking_page_url = urls.booking_page_url;
    if (urls.guest_application_url)  data.guest_application_url = urls.guest_application_url;
    if (urls.website && !urls.website.toLowerCase().includes('apple.com') && !urls.website.toLowerCase().includes('itunes')) data.website = urls.website;

    const [em] = extractEmails(src);
    if (em && !em.includes('noreply') && !em.includes('no-reply')) data.contact_email = em;
    const [ph] = extractPhones(src);
    if (ph) data.host_phone = ph;

    // Episode count
    const ec = bodyText.match(/(\d+)\s+Episodes?/);
    if (ec) { const c = parseInt(ec[1], 10); if (c > 0) data.total_episodes = c; }

    // Frequency
    const fm = bodyText.match(/(Updated|Publishes)\s+(Weekly|Biweekly|Monthly|Daily)/i);
    if (fm) data.publish_frequency = fm[2].charAt(0).toUpperCase() + fm[2].slice(1).toLowerCase();

    // Last date
    const dr = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/g;
    const df = bodyText.match(dr);
    if (df) {
      const parsed = df.map(d => new Date(d)).filter(d => !isNaN(d.getTime()));
      if (parsed.length) { parsed.sort((a, b) => b - a); data.last_episode_date = parsed[0].toISOString().split('T')[0]; }
    }

    // Country
    const cy = appleUrl.match(/podcasts\.apple\.com\/([a-z]{2})\//);
    if (cy) data.country = cy[1].toUpperCase();

    // ── Facebook enrichment ──────────────────────────────────────────

    if (data.facebook_url) {
      const fb = await scrapeFacebookPage(data.facebook_url);
      if (fb.website) data.website = fb.website;
      if (fb.email)   data.contact_email = fb.email;
      if (fb.phone)   data.host_phone = fb.phone;
    }

    data.apple_scraped_at = new Date().toISOString();
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && v !== undefined && v !== '') out[k] = v;
    }

    logger.info('appleScraper: done', { appleId, fields: Object.keys(out) });
    return { ok: true, data: out };

  } catch (err) {
    logger.warn('appleScraper: fail', { appleUrl, error: err.message });
    return { ok: false, data: null, error: err.message };
  }
}

// ────── DB operations ──────────────────────────────────────────────────

async function scrapeAndStoreAppleData(podcastId) {
  if (!podcastId) return { ok: false, data: null, error: 'podcastId_required' };

  const { data: pod, error: dberr } = await supabase
    .from('podcasts')
    .select('id, apple_url, title, apple_scraped_at')
    .eq('id', podcastId)
    .single();

  if (dberr || !pod) return { ok: false, data: null, error: 'not_found' };
  if (!pod.apple_url) return { ok: false, data: null, error: 'no_apple_url' };

  const result = await scrapeApplePage(pod.apple_url);
  if (!result.ok || !result.data) return result;

  const d = result.data;

  const payload = {
    apple_rating:          d.apple_rating || null,
    apple_review_count:    d.apple_review_count || null,
    apple_chart_rank:      d.apple_chart_rank || null,
    apple_chart_category:  d.apple_chart_category || null,
    has_ads:               !!d.has_ads,
    apple_scraped_at:      d.apple_scraped_at,
    ...(d.host_name            ? { host_name: d.host_name } : {}),
    ...(d.description          ? { description: d.description } : {}),
    ...(d.category             ? { category: d.category } : {}),
    ...(d.language             ? { language: d.language } : {}),
    ...(d.image                ? { image: d.image } : {}),
    ...(d.instagram_url        ? { instagram_url: d.instagram_url } : {}),
    ...(d.linkedin_url         ? { linkedin_url: d.linkedin_url } : {}),
    ...(d.facebook_url         ? { facebook_url: d.facebook_url } : {}),
    ...(d.youtube_url          ? { youtube_url: d.youtube_url } : {}),
    ...(d.tiktok_url           ? { tiktok_url: d.tiktok_url } : {}),
    ...(d.twitter_url          ? { twitter_url: d.twitter_url } : {}),
    ...(d.spotify_url          ? { spotify_url: d.spotify_url } : {}),
    ...(d.website              ? { website: d.website } : {}),
    ...(d.contact_email        ? { contact_email: d.contact_email } : {}),
    ...(d.host_phone           ? { host_phone: d.host_phone } : {}),
    ...(d.booking_page_url     ? { booking_page_url: d.booking_page_url } : {}),
    ...(d.guest_application_url ? { guest_application_url: d.guest_application_url } : {}),
    ...(d.total_episodes       ? { total_episodes: d.total_episodes } : {}),
    ...(d.last_episode_date    ? { last_episode_date: d.last_episode_date } : {}),
    ...(d.publish_frequency    ? { publish_frequency: d.publish_frequency } : {}),
    ...(d.country              ? { country: d.country } : {}),
  };

  const { error: uerr } = await supabase
    .from('podcasts')
    .update(payload)
    .eq('id', podcastId);

  if (uerr) {
    logger.error('appleScraper: update fail', { podcastId, error: uerr.message });
    return { ok: false, data: null, error: 'db_update_failed' };
  }

  logger.info('appleScraper: stored', { podcastId, title: pod.title });
  return { ok: true, data: d };
}

async function batchScrapeAppleData(clientId, max = 20) {
  if (!clientId) return { ok: false, results: [], error: 'clientId_required' };

  try {
    const { data: matches } = await supabase
      .from('podcast_matches')
      .select('podcast_id')
      .eq('client_id', clientId);

    if (!matches || matches.length === 0) return { ok: true, results: [] };

    const ids = matches.map(m => m.podcast_id).filter(Boolean);

    const { data: pods } = await supabase
      .from('podcasts')
      .select('id, title, apple_url, apple_scraped_at')
      .in('id', ids)
      .not('apple_url', 'is', null)
      .neq('apple_url', '');

    if (!pods || pods.length === 0) return { ok: true, results: [] };

    const results = [];
    for (const p of pods.slice(0, max)) {
      results.push({ podcastId: p.id, title: p.title, ...(await scrapeAndStoreAppleData(p.id)) });
    }

    return { ok: true, results };
  } catch (err) {
    logger.error('appleScraper: batch fail', { clientId, error: err.message });
    return { ok: false, results: [], error: err.message };
  }
}

module.exports = {
  extractAppleId,
  scrapeApplePage,
  scrapeFacebookPage,
  scrapeAndStoreAppleData,
  batchScrapeAppleData,
};
