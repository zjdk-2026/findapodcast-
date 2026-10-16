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

  return rows.filter((r) => !r.in_trash && !r.archived).map((r) => ({
    id:        r.id,
    url:       r.url,
    name:      prop(r.properties['Show Name']) || 'Untitled',
    host:      prop(r.properties['Host']),
    status:    prop(r.properties['Status']),
    clientIds: prop(r.properties['Client']) || [],
    dateAdded: prop(r.properties['Date Added']),
    notes:     prop(r.properties['Notes']),
    lastEdited: r.last_edited_time,
  }));
}

const clientNameCache = new Map();
async function resolveClientNames(ids) {
  const missing = [...new Set(ids)].filter((id) => !clientNameCache.has(id));
  await Promise.all(missing.map(async (id) => {
    try {
      const page = await notion(`pages/${id}`);
      clientNameCache.set(id, prop(page.properties['Name']) || 'Unnamed');
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

let inflight = null;
async function buildPayload() {
  if (!process.env.NOTION_TOKEN) throw new Error('NOTION_TOKEN is not set.');

  const shows = (await fetchShows()).filter((s) => s.status !== 'DUPLICATE');
  await resolveClientNames(shows.flatMap((s) => s.clientIds));

  let events = null;
  let historyError = null;
  try {
    events = await syncEvents(shows);
  } catch (err) {
    historyError = err.message;
    logger.warn('[tour-tracker] history unavailable', { error: err.message });
  }

  const pitchedAt = new Map();
  for (const e of events || []) {
    if (e.to_status === 'PITCHED' && !pitchedAt.has(e.page_id)) {
      pitchedAt.set(e.page_id, { at: e.observed_at, firstSeen: e.from_status === null });
    }
  }

  return {
    syncedAt: new Date().toISOString(),
    historyError,
    shows: shows.map((s) => ({
      id: s.id,
      url: s.url,
      name: s.name,
      host: s.host,
      status: s.status,
      clients: s.clientIds.map((id) => clientNameCache.get(id)).filter(Boolean),
      dateAdded: s.dateAdded,
      notes: s.notes,
      pitchedAt: pitchedAt.get(s.id)?.at || null,
      pitchedAtIsFirstSeen: pitchedAt.get(s.id)?.firstSeen || false,
    })),
    activity: events ? events.slice(-15).reverse() : null,
  };
}

router.get('/api/tour-tracker', requireOperatorKey, async (req, res) => {
  try {
    inflight = inflight || buildPayload().finally(() => { inflight = null; });
    res.json({ success: true, ...(await inflight) });
  } catch (err) {
    logger.error('[tour-tracker] sync failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
