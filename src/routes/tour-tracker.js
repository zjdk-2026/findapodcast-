'use strict';

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

const router = express.Router();

const OPERATOR_KEY   = process.env.OPERATOR_KEY || 'pipeline2026';
const NOTION_VERSION = '2025-09-03';
// Podcast Tour HQ → Show Directory
const DATA_SOURCE_ID = process.env.NOTION_SHOW_DIRECTORY_ID || 'd1500ea9-ff0f-402b-86c7-2b334911111f';

function requireOperatorKey(req, res, next) {
  const key = req.headers['x-operator-key'] || req.query.key;
  if (key !== OPERATOR_KEY) return res.status(401).json({ success: false, error: 'Unauthorized.' });
  next();
}

async function notion(path, body) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Notion ${res.status}: ${json.message || 'request failed'}`);
  return json;
}

function prop(p) {
  if (!p) return null;
  switch (p.type) {
    case 'title':     return p.title.map((t) => t.plain_text).join('') || null;
    case 'rich_text': return p.rich_text.map((t) => t.plain_text).join('') || null;
    case 'select':    return p.select?.name || null;
    case 'status':    return p.status?.name || null;
    case 'date':      return p.date?.start || null;
    case 'url':       return p.url || null;
    case 'relation':  return p.relation.map((r) => r.id);
    default:          return null;
  }
}

async function fetchShows() {
  const rows = [];
  let cursor;
  do {
    const page = await notion(`data_sources/${DATA_SOURCE_ID}/query`, { page_size: 100, start_cursor: cursor });
    rows.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);

  return rows.filter((r) => !r.in_trash && !r.archived).map((r) => {
    const p = r.properties;
    return {
      id:                 r.id,
      url:                r.url,
      name:               prop(p['Show Name']) || 'Untitled',
      host:               prop(p['Host']),
      status:             prop(p['Status']),
      clientIds:          prop(p['Client']) || [],
      introducedIds:      prop(p['Clients Introduced']) || [],
      instagram:          prop(p['Instagram Link']),
      facebook:           prop(p['Facebook Link']),
      emailOrBooking:     prop(p['Email or Booking Link']),
      channel:            prop(p['Channel']),
      dateSent:           prop(p['Date Sent']),
      followUpDate:       prop(p['Follow Up Date']),
      dmDraft:            prop(p['DM Draft']),
      perfectGuest:       prop(p['Perfect Guest']),
      source:             prop(p['Source']),
    };
  });
}

const clientNameCache = new Map();
async function resolveClientNames(ids) {
  const missing = [...new Set(ids)].filter((id) => !clientNameCache.has(id));
  await Promise.all(missing.map(async (id) => {
    try {
      const page = await notion(`pages/${id}`);
      const title = Object.values(page.properties).find((v) => v.type === 'title');
      clientNameCache.set(id, prop(title) || 'Unnamed');
    } catch (err) {
      logger.warn('[tour-tracker] client lookup failed', { id, error: err.message });
    }
  }));
}

async function fetchAllEvents() {
  const events = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('tour_status_events')
      .select('page_id, show_name, from_status, to_status, observed_at')
      .order('observed_at', { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    events.push(...data);
    if (data.length < 1000) return events;
  }
}

// Notion stores no status history, so each sync diffs current statuses against
// the last status we logged and records the change.
async function syncEvents(shows) {
  const events = await fetchAllEvents();
  const lastStatus = new Map();
  for (const e of events) lastStatus.set(e.page_id, e.to_status);

  const now = new Date().toISOString();
  const inserts = shows
    .filter((s) => lastStatus.get(s.id) !== s.status)
    .map((s) => ({ page_id: s.id, show_name: s.name, from_status: lastStatus.get(s.id) ?? null, to_status: s.status, observed_at: now }));

  if (inserts.length) {
    const { error } = await supabase.from('tour_status_events').insert(inserts);
    if (error) throw error;
    events.push(...inserts);
  }
  return events;
}

const SENT_STATUSES = new Set(['SENT', 'PITCHED']);

let inflight = null;
async function buildPayload() {
  if (!process.env.NOTION_TOKEN) throw new Error('NOTION_TOKEN is not set.');

  const shows = await fetchShows();
  await resolveClientNames(shows.flatMap((s) => [...s.clientIds, ...s.introducedIds]));

  let events = null;
  let historyError = null;
  try {
    events = await syncEvents(shows);
  } catch (err) {
    historyError = err.message;
    logger.warn('[tour-tracker] history unavailable', { error: err.message });
  }

  const firstSeenSent = new Map();
  for (const e of events || []) {
    if (SENT_STATUSES.has(e.to_status) && !firstSeenSent.has(e.page_id)) firstSeenSent.set(e.page_id, e.observed_at);
  }

  const names = (ids) => ids.map((id) => clientNameCache.get(id)).filter(Boolean);

  return {
    syncedAt: new Date().toISOString(),
    historyError,
    shows: shows.map(({ clientIds, introducedIds, ...s }) => ({
      ...s,
      status: s.status === 'PITCHED' ? 'SENT' : s.status,
      clients: names(clientIds),
      clientsIntroduced: names(introducedIds),
      sentAt: s.dateSent || firstSeenSent.get(s.id) || null,
      sentEstimated: !s.dateSent && firstSeenSent.has(s.id),
    })),
    activity: events ? events.slice(-15).reverse() : null,
  };
}

function sync() {
  inflight = inflight || buildPayload().finally(() => { inflight = null; });
  return inflight;
}

// Keeps status history accurate between dashboard visits.
if (process.env.NOTION_TOKEN) {
  setInterval(() => {
    sync().catch((err) => logger.warn('[tour-tracker] background sync failed', { error: err.message }));
  }, 15 * 60 * 1000).unref();
}

router.get('/api/tour-tracker', requireOperatorKey, async (req, res) => {
  try {
    res.json({ success: true, ...(await sync()) });
  } catch (err) {
    logger.error('[tour-tracker] sync failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
