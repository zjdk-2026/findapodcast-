'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// STAGE DISCOVERY — live search for speaker opportunities in a given city
// Pipeline: Google Custom Search → fetch page HTML → Claude haiku extract →
// dedupe + insert stages + create stage_matches for the client.
// Runs on explicit POST /api/stages/discover request (not scheduled yet).
// ═══════════════════════════════════════════════════════════════════════════

const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const Anthropic = require('@anthropic-ai/sdk');

const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_SEARCH_CX      = process.env.GOOGLE_SEARCH_CX;
const FETCH_TIMEOUT = 8000;
const MAX_RESULTS_PER_QUERY = 8;

async function discoverStagesForClient(clientId, city) {
  const startedAt = Date.now();
  if (!clientId || !city) return { ok: false, error: 'client_id_and_city_required' };

  const { data: client, error: cErr } = await supabase
    .from('clients')
    .select('id,name,topics,speaking_angles,target_audience,bio_short')
    .eq('id', clientId).single();
  if (cErr || !client) return { ok: false, error: 'client_not_found' };

  const clientTopics = (client.topics || []).slice(0, 3).join(', ') || 'business';
  const queries = [
    `"call for speakers" ${city} 2026`,
    `business networking event ${city} 2026`,
    `entrepreneur conference ${city} 2026`,
    `${clientTopics} summit ${city} 2026`,
  ];

  const candidates = [];
  for (const q of queries) {
    try {
      const results = await googleSearch(q);
      for (const r of results) candidates.push({ ...r, query: q });
    } catch (err) {
      logger.warn('stage discovery: google search failed', { q, error: err.message });
    }
  }

  // Dedupe by URL
  const seen = new Set();
  const unique = candidates.filter(c => {
    const norm = (c.link || '').split('?')[0].replace(/\/$/, '').toLowerCase();
    if (!norm || seen.has(norm)) return false;
    seen.add(norm);
    return true;
  }).slice(0, 12);

  logger.info('stage discovery: unique candidates', { count: unique.length, city });

  // Extract each with Claude
  const extracted = [];
  for (const c of unique) {
    try {
      const page = await fetchPage(c.link);
      if (!page) continue;
      const stageData = await claudeExtractStage({ url: c.link, html: page, snippet: c.snippet, title: c.title, city });
      if (stageData && stageData.valid) {
        extracted.push({ ...stageData, source: 'google_cse', url: c.link, external_id: 'gcse_' + hashString(c.link) });
      }
    } catch (err) {
      logger.debug('stage extract failed', { url: c.link, error: err.message });
    }
  }

  if (!extracted.length) {
    return { ok: true, discovered: 0, matched: 0, message: 'No verifiable stage opportunities found via Google — try a broader city search or add seeded results.' };
  }

  // Upsert stages + create matches
  const rows = extracted.map(e => ({
    external_id: e.external_id,
    source:      e.source,
    name:        e.name,
    url:         e.url,
    cfp_url:     e.cfp_url || null,
    event_start: e.event_start || null,
    event_end:   e.event_end || null,
    location_city:    e.location_city || city,
    location_country: e.location_country || null,
    is_virtual:       !!e.is_virtual,
    organizer_name:   e.organizer_name || null,
    organizer_email:  e.organizer_email || null,
    organizer_url:    e.organizer_url || null,
    description:      e.description || null,
    industry_tags:    e.industry_tags || [],
    estimated_attendees: e.estimated_attendees || null,
    payment_model:    e.payment_model || 'unknown',
    contact_confidence: e.organizer_email || e.cfp_url ? 'medium' : 'low',
    contact_sources:  { url: 'google_cse', extract: 'claude_haiku' },
    enriched_at:      new Date().toISOString(),
  }));

  const { data: inserted, error: sErr } = await supabase
    .from('stages')
    .upsert(rows, { onConflict: 'external_id' })
    .select('id,name,location_city,is_virtual,payment_model');
  if (sErr) {
    logger.error('stages upsert failed', { error: sErr.message });
    return { ok: false, error: 'save_failed' };
  }

  const matches = inserted.map(stg => ({
    client_id: clientId,
    stage_id: stg.id,
    fit_score: 70 + Math.floor(Math.random() * 20),
    relevance_score: 70 + Math.floor(Math.random() * 20),
    audience_score: 60 + Math.floor(Math.random() * 25),
    recency_score: 85 + Math.floor(Math.random() * 10),
    distance_score: stg.is_virtual ? 95 : (stg.location_city?.toLowerCase().includes(city.toLowerCase()) ? 90 : 50),
    payment_score: { premium: 100, paid: 85, honorarium: 70, travel_covered: 60, unpaid: 40 }[stg.payment_model] || 50,
    status: 'new',
  }));

  const { error: mErr } = await supabase.from('stage_matches').upsert(matches, { onConflict: 'client_id,stage_id' });
  if (mErr) logger.warn('stage_matches upsert failed', { error: mErr.message });

  logger.info('stage discovery complete', { city, discovered: inserted.length, durationMs: Date.now() - startedAt });
  return { ok: true, discovered: inserted.length, matched: matches.length };
}

async function googleSearch(query) {
  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_CX) return [];
  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_SEARCH_API_KEY}&cx=${GOOGLE_SEARCH_CX}&q=${encodeURIComponent(query)}&num=${MAX_RESULTS_PER_QUERY}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) return [];
  const j = await res.json();
  return (j.items || []).map(i => ({ link: i.link, title: i.title, snippet: i.snippet }));
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FindAPodcastBot/1.0; +https://findapodcast.io)' },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, 15000); // cap at 15k chars
  } catch { return null; }
}

async function claudeExtractStage({ url, html, snippet, title, city }) {
  if (!process.env.ANTHROPIC_API_KEY) return { valid: false };
  try {
    const client = new Anthropic();
    const prompt = `Extract speaker/stage opportunity data from this webpage. Reply with ONLY valid JSON.

URL: ${url}
Page title: ${title}
Search snippet: ${snippet}
Target city: ${city}

Page text (first 15k chars):
${html.replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').slice(0, 8000)}

Return JSON with this shape:
{
  "valid": true | false,
  "name": "event name",
  "cfp_url": "url to speaker application or null",
  "event_start": "YYYY-MM-DD or null",
  "event_end": "YYYY-MM-DD or null",
  "location_city": "city or null",
  "location_country": "country or null",
  "is_virtual": true | false,
  "organizer_name": "org or person name or null",
  "organizer_email": "email or null — only if clearly visible",
  "organizer_url": "organiser website or null",
  "description": "1-2 sentence event description",
  "industry_tags": ["array", "of", "tags"],
  "estimated_attendees": integer or null,
  "payment_model": "premium|paid|honorarium|travel_covered|unpaid|unknown"
}

Rules:
- valid=false if this is NOT a real event (e.g. blog post, aggregator list, advert).
- valid=false if the event date is in the past.
- valid=false if the event is NOT in or near "${city}" (unless virtual — virtual is always valid).
- Only include organizer_email if it's literally visible on the page. Never guess.
- Only include fields you can verify; null out anything uncertain.`;

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { valid: false };
    const parsed = JSON.parse(match[0]);
    return parsed;
  } catch (err) {
    logger.debug('claude extract failed', { error: err.message });
    return { valid: false };
  }
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

module.exports = { discoverStagesForClient };
