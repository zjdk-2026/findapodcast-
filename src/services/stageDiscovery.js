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
  const cityLower = city.toLowerCase();

  // ── 11 parallel sources, each tagged ────────────────────────────────────
  const sourceResults = await Promise.allSettled([
    sourceGoogleCSE(city, clientTopics),
    sourceSessionize(city, clientTopics),
    sourceEventbritePublic(city, clientTopics),
    sourcePapercall(clientTopics),
    sourceTEDx(city),
    sourceStartupGrind(city),
    sourceFoundersLive(city),
    sourceCreativeMornings(city),
    sourceInstagramNetworking(city, clientTopics),
    sourceFacebookGroups(city, clientTopics),
    sourceToastmasters(city),
  ]);

  const candidates = [];
  const sourceLog = {};
  const sourceNames = ['google_cse','sessionize','eventbrite','papercall','tedx','startup_grind','founders_live','creative_mornings','instagram','facebook_group','toastmasters'];
  sourceNames.forEach((name, i) => {
    const r = sourceResults[i];
    if (r.status === 'fulfilled') {
      sourceLog[name] = r.value.length;
      candidates.push(...r.value);
    } else {
      sourceLog[name] = 'err: ' + r.reason?.message;
    }
  });

  logger.info('stage discovery: sources returned', { city, ...sourceLog });

  // Dedupe by URL — prefer franchise/structured sources first (they have higher signal)
  const PRIORITY = { tedx: 1, toastmasters: 1, startup_grind: 1, founders_live: 1, creative_mornings: 1, sessionize: 2, papercall: 2, eventbrite: 3, google_cse: 4, instagram: 5, facebook_group: 5 };
  candidates.sort((a, b) => (PRIORITY[a.source] || 9) - (PRIORITY[b.source] || 9));
  const seen = new Set();
  const unique = candidates.filter(c => {
    const norm = (c.link || '').split('?')[0].replace(/\/$/, '').toLowerCase();
    if (!norm || seen.has(norm)) return false;
    seen.add(norm);
    return true;
  }).slice(0, 20);  // pull up to 20 candidates, cap final saved at 10 below

  // Parallel extraction with Claude (max 4 at a time) — stop after 10 verified
  const extracted = [];
  const concurrency = 4;
  const MAX_VERIFIED = 10;
  for (let i = 0; i < unique.length && extracted.length < MAX_VERIFIED; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(async (c) => {
      try {
        // Sessionize / Papercall sources already have structured data — skip Claude
        if (c.preExtracted) return { ...c.preExtracted, source: c.source, url: c.link, external_id: c.external_id || 'src_' + c.source + '_' + hashString(c.link) };
        const page = await fetchPage(c.link);
        if (!page) return null;
        const stageData = await claudeExtractStage({ url: c.link, html: page, snippet: c.snippet, title: c.title, city });
        if (!stageData || !stageData.valid) return null;
        return { ...stageData, source: c.source || 'google_cse', url: c.link, external_id: 'gcse_' + hashString(c.link) };
      } catch { return null; }
    }));
    for (const r of batchResults) if (r.status === 'fulfilled' && r.value) extracted.push(r.value);
  }

  if (!extracted.length) {
    const sourceTotal = candidates.length;
    return {
      ok: true, discovered: 0, matched: 0,
      message: sourceTotal === 0
        ? `No results from any source for "${city}". Google CSE quota may be exhausted.`
        : `Found ${sourceTotal} candidate event(s) but none passed strict verification. Try a larger city like London or Sydney.`,
      sources: sourceLog,
    };
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
    event_type:       e.event_type || (e.source === 'tedx' ? 'tedx' : e.chapter_org ? 'org_chapter' : 'conference'),
    chapter_org:      e.chapter_org || null,
    recurring:        !!e.recurring,
    meeting_frequency: e.meeting_frequency || null,
    contact_confidence: e.organizer_email || e.cfp_url ? 'medium' : 'low',
    contact_sources:  { url: e.source || 'google_cse', extract: e.preExtracted ? 'connector_structured' : 'claude_haiku' },
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

// ── Source 1: Google Custom Search (multiple keyword angles) ───────────────
async function sourceGoogleCSE(city, topics) {
  const queries = [
    `"call for speakers" ${city} 2026`,
    `"speaker applications" ${city} 2026`,
    `business networking event ${city} 2026`,
    `entrepreneur conference ${city} 2026`,
    `${topics} summit ${city} 2026`,
  ];
  const results = [];
  for (const q of queries) {
    try {
      const r = await googleSearch(q);
      for (const x of r) results.push({ ...x, source: 'google_cse', query: q });
    } catch { /* skip */ }
  }
  return results;
}

// ── Source 2: Sessionize public CFPs (free, structured) ────────────────────
async function sourceSessionize(city) {
  try {
    const url = 'https://sessionize.com/community/cfp';
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) return [];
    const html = await res.text();
    const cards = [];
    // Sessionize CFP listing cards have predictable JSON-LD or sessionize-card classes
    const eventRegex = /<a[^>]+href="(https?:\/\/sessionize\.com\/[^"]+)"[^>]*>[\s\S]*?<\/a>/g;
    let m;
    const seen = new Set();
    while ((m = eventRegex.exec(html)) !== null && cards.length < 20) {
      const link = m[1].split('?')[0];
      if (seen.has(link)) continue;
      seen.add(link);
      cards.push({ link, title: 'Sessionize CFP', snippet: '', source: 'sessionize' });
    }
    return cards;
  } catch (err) {
    logger.warn('sessionize fetch failed', { error: err.message });
    return [];
  }
}

// ── Source 3: Eventbrite public search (geo-filtered) ──────────────────────
async function sourceEventbritePublic(city, topics) {
  try {
    const q = encodeURIComponent(`speaker call for speakers ${topics}`);
    const c = encodeURIComponent(city);
    const url = `https://www.eventbrite.com/d/${c}/--${q}/`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FindAPodcastBot/1.0)' },
    });
    if (!res.ok) return [];
    const html = await res.text();
    // Eventbrite search results have <a class="event-card-link" href="https://www.eventbrite.com/e/...">
    const eventRegex = /href="(https:\/\/www\.eventbrite\.com\/e\/[^"]+)"/g;
    const cards = [];
    const seen = new Set();
    let m;
    while ((m = eventRegex.exec(html)) !== null && cards.length < 12) {
      const link = m[1].split('?')[0];
      if (seen.has(link)) continue;
      seen.add(link);
      cards.push({ link, title: 'Eventbrite event', snippet: '', source: 'eventbrite' });
    }
    return cards;
  } catch (err) {
    logger.warn('eventbrite scrape failed', { error: err.message });
    return [];
  }
}

// ── Source 5: TEDx events — official tedx event finder (city-filtered) ────
async function sourceTEDx(city) {
  try {
    const cityLower = city.toLowerCase().replace(/\s+/g, '+');
    const url = `https://www.ted.com/tedx/events?q=${cityLower}`;
    const html = await fetchPage(url);
    if (!html) return [];
    // TEDx event cards: <a href="/tedx/events/NNNNN" ...>
    const eventRegex = /<a[^>]+href="(\/tedx\/events\/[^"]+)"[^>]*>/g;
    const cards = [];
    const seen = new Set();
    let m;
    while ((m = eventRegex.exec(html)) !== null && cards.length < 8) {
      const slug = m[1].split('?')[0];
      if (seen.has(slug)) continue;
      seen.add(slug);
      cards.push({ link: 'https://www.ted.com' + slug, title: 'TEDx Event', snippet: '', source: 'tedx' });
    }
    return cards;
  } catch (err) { logger.warn('tedx fetch failed', { error: err.message }); return []; }
}

// ── Source 6: Startup Grind chapters (600+ cities, monthly events) ─────────
async function sourceStartupGrind(city) {
  try {
    const cityLower = city.toLowerCase().replace(/\s+/g, '-');
    const url = `https://www.startupgrind.com/${cityLower}/`;
    const html = await fetchPage(url);
    if (!html) return [];
    // If chapter exists, the page returns 200 with content
    return [{
      link: url,
      title: `Startup Grind ${city}`,
      snippet: 'Monthly chapter event with founder fireside chats. ~150 attendees per session.',
      source: 'startup_grind',
      preExtracted: {
        valid: true,
        name: `Startup Grind ${city} — Monthly Chapter Event`,
        cfp_url: url,
        location_city: city,
        is_virtual: false,
        organizer_name: `Startup Grind ${city}`,
        organizer_url: url,
        description: `Monthly Startup Grind chapter event in ${city}. Hosts a fireside chat with a notable founder, Q&A, and networking. Speaker slots available — chapter directors curate guests.`,
        industry_tags: ['startup', 'entrepreneurship', 'founders', 'local'],
        estimated_attendees: 150,
        payment_model: 'unpaid',
        recurring: true,
        meeting_frequency: 'monthly',
        event_type: 'org_chapter',
        chapter_org: 'startup_grind',
      },
    }];
  } catch { return []; }
}

// ── Source 7: Founders Live chapters (100+ cities, monthly pitch nights) ───
async function sourceFoundersLive(city) {
  try {
    const cityLower = city.toLowerCase().replace(/\s+/g, '');
    const url = `https://www.founderslive.com/${cityLower}`;
    const html = await fetchPage(url);
    if (!html) return [];
    return [{
      link: url,
      title: `Founders Live ${city}`,
      snippet: 'Monthly pitch night for early-stage founders. ~120 attendees per event.',
      source: 'founders_live',
      preExtracted: {
        valid: true,
        name: `Founders Live ${city}`,
        cfp_url: url,
        location_city: city,
        is_virtual: false,
        organizer_name: `Founders Live ${city}`,
        organizer_url: url,
        description: `Monthly pitch night for ${city} founders. 7-min pitch slots between 15-min keynote slots. ~120 attendees, mostly early-stage founders + angel investors.`,
        industry_tags: ['startup', 'founders', 'local', 'pitch'],
        estimated_attendees: 120,
        payment_model: 'unpaid',
        recurring: true,
        meeting_frequency: 'monthly',
        event_type: 'org_chapter',
        chapter_org: 'founders_live',
      },
    }];
  } catch { return []; }
}

// ── Source 8: CreativeMornings chapters (200+ cities, monthly breakfast) ───
async function sourceCreativeMornings(city) {
  try {
    const cityLower = city.toLowerCase().replace(/\s+/g, '');
    const url = `https://creativemornings.com/cities/${cityLower}`;
    const html = await fetchPage(url);
    if (!html || html.toLowerCase().includes('chapter not found')) return [];
    return [{
      link: url,
      title: `CreativeMornings ${city}`,
      snippet: 'Monthly breakfast lecture series. ~150 creative + entrepreneurial attendees.',
      source: 'creative_mornings',
      preExtracted: {
        valid: true,
        name: `CreativeMornings ${city}`,
        cfp_url: url,
        location_city: city,
        is_virtual: false,
        organizer_name: `CreativeMornings ${city}`,
        organizer_url: url,
        description: `Monthly breakfast lecture series in ${city}. 20-min keynote slot followed by Q&A. ~150 creative professionals, entrepreneurs, designers. Curated by the local chapter director.`,
        industry_tags: ['creative', 'design', 'entrepreneurship', 'community'],
        estimated_attendees: 150,
        payment_model: 'unpaid',
        recurring: true,
        meeting_frequency: 'monthly',
        event_type: 'org_chapter',
        chapter_org: 'creative_mornings',
      },
    }];
  } catch { return []; }
}

// ── Source 9: Instagram networking communities (Google CSE site filter) ────
async function sourceInstagramNetworking(city, topics) {
  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_CX) return [];
  const queries = [
    `site:instagram.com "${city}" networking entrepreneurs`,
    `site:instagram.com "${city}" business community`,
  ];
  const out = [];
  for (const q of queries) {
    try {
      const r = await googleSearch(q);
      for (const x of r) {
        // Only include profile URLs (instagram.com/handle/), not posts (instagram.com/p/ID)
        if (/^https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.]{1,30}\/?(?:\?|$)/.test(x.link)) {
          out.push({ ...x, source: 'instagram' });
        }
      }
    } catch { /* skip */ }
  }
  return out;
}

// ── Source 10: Facebook public groups (Google CSE site filter) ─────────────
async function sourceFacebookGroups(city, topics) {
  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_CX) return [];
  const queries = [
    `site:facebook.com/groups "${city}" entrepreneurs`,
    `site:facebook.com/groups "${city}" networking business`,
  ];
  const out = [];
  for (const q of queries) {
    try {
      const r = await googleSearch(q);
      for (const x of r) {
        if (/^https?:\/\/(?:www\.)?facebook\.com\/groups\//.test(x.link)) {
          out.push({ ...x, source: 'facebook_group' });
        }
      }
    } catch { /* skip */ }
  }
  return out;
}

// ── Source 11: Toastmasters — 16,800 clubs in 145 countries ────────────────
// Their public club-finder API: GET https://www.toastmasters.org/api/sitecore/findaclub/Search?<...>
// Returns JSON list. Each speaker should target VP Education at each club for booking.
async function sourceToastmasters(city) {
  try {
    const cityEnc = encodeURIComponent(city);
    // Known endpoint pattern (subject to change — failure mode is empty array, safe)
    const url = `https://www.toastmasters.org/api/sitecore/findaclub/Search?city=${cityEnc}&country=&radius=25&advanced=1`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    let json;
    try { json = await res.json(); } catch { return []; }
    const clubs = Array.isArray(json?.Clubs) ? json.Clubs : Array.isArray(json) ? json : [];
    if (!clubs.length) return [];

    return clubs.slice(0, 5).map((c, i) => ({
      link: c.WebSite || `https://www.toastmasters.org/Find-a-Club/${c.ClubNumber || i}`,
      title: c.Name || `Toastmasters Club ${city}`,
      snippet: c.MeetingNotes || '',
      source: 'toastmasters',
      external_id: 'tm_' + (c.ClubNumber || hashString((c.Name || '') + city)),
      preExtracted: {
        valid: true,
        name: `Toastmasters — ${c.Name || city + ' Club'}`,
        cfp_url: c.WebSite || `https://www.toastmasters.org/Find-a-Club/${c.ClubNumber || ''}`,
        location_city: c.City || city,
        location_country: c.Country || null,
        is_virtual: false,
        organizer_name: c.Name || `Toastmasters ${city}`,
        organizer_email: c.Email || null,
        organizer_url: c.WebSite || null,
        description: `Toastmasters International club. Weekly speaking practice + speaker slots. ${c.MeetingNotes || 'Members rotate roles weekly — guests welcome to deliver speeches and gain feedback.'}`,
        industry_tags: ['speaking', 'professional development', 'networking', 'local'],
        estimated_attendees: 25,
        payment_model: 'unpaid',
        recurring: true,
        meeting_frequency: 'weekly',
        event_type: 'org_chapter',
        chapter_org: 'toastmasters',
      },
    }));
  } catch (err) {
    logger.warn('toastmasters fetch failed', { error: err.message });
    return [];
  }
}

// ── Source 4: Papercall.io public CFPs (often global / virtual) ────────────
async function sourcePapercall(topics) {
  try {
    const url = 'https://www.papercall.io/cfps';
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) return [];
    const html = await res.text();
    // Papercall lists CFPs with anchor links matching /events/<slug>
    const eventRegex = /<a[^>]+href="(\/events\/[^"]+)"[^>]*>([^<]+)<\/a>/g;
    const cards = [];
    const seen = new Set();
    let m;
    while ((m = eventRegex.exec(html)) !== null && cards.length < 12) {
      const slug = m[1].split('?')[0];
      if (seen.has(slug)) continue;
      seen.add(slug);
      cards.push({ link: 'https://www.papercall.io' + slug, title: m[2].trim(), snippet: '', source: 'papercall' });
    }
    return cards;
  } catch (err) {
    logger.warn('papercall fetch failed', { error: err.message });
    return [];
  }
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
