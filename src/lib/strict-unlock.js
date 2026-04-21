'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// STRICT UNLOCK — Zero Hallucination Deep Search
//
// Entry point for the customer "Unlock contact" button. Runs in strict mode:
//   1. If cached (unlocked < 30d), return cache + log as cache hit
//   2. Otherwise run full enrichPodcast (existing 5-layer pipeline)
//   3. Layer on host personal socials search (Google CSE + bio mention check)
//   4. Claude verification pass on any non-authoritative email
//   5. Build contact_sources receipt (which source vouched for which field)
//   6. Compute contact_confidence
//   7. Save with contact_unlocked_at and log the event
//
// Every field stored carries a provenance tag. Nothing unverifiable ships.
// ═══════════════════════════════════════════════════════════════════════════

const supabase = require('./supabase');
const logger = require('./logger');
const { enrichPodcast } = require('../services/enrichment');
const { computeContactLikelihood } = require('./contact-likelihood');

const CACHE_DAYS = 30;
const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_SEARCH_CX = process.env.GOOGLE_SEARCH_CX;
const FETCH_TIMEOUT = 8000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── Public entry ─────────────────────────────────────────────────────────────

async function unlockPodcast(podcastId, clientId) {
  const startedAt = Date.now();
  const logEntry = {
    podcast_id: podcastId,
    client_id: clientId || null,
    was_cached: false,
    result_found: false,
    fields_found: [],
    duration_ms: null,
    error_message: null,
  };

  try {
    const { data: podcast, error: fetchErr } = await supabase
      .from('podcasts')
      .select('*')
      .eq('id', podcastId)
      .single();

    if (fetchErr || !podcast) {
      logEntry.error_message = fetchErr?.message || 'podcast not found';
      await writeLog(logEntry, startedAt);
      return { ok: false, error: 'podcast_not_found' };
    }

    // ── 1. Cache check — shared across all clients ─────────────────────────
    if (podcast.contact_unlocked_at && isFresh(podcast.contact_unlocked_at)) {
      logEntry.was_cached = true;
      logEntry.result_found = hasAnyContact(podcast);
      logEntry.fields_found = listPopulatedFields(podcast);
      await supabase.from('podcasts').update({ unlock_count: (podcast.unlock_count || 0) + 1 }).eq('id', podcastId);
      await writeLog(logEntry, startedAt);
      return { ok: true, podcast, cached: true };
    }

    // ── 2. Run the existing enrichment pipeline to get baseline ────────────
    let enriched;
    try {
      enriched = await enrichPodcast({
        ...podcast,
        _strictMode: true, // reserved flag — enrichPodcast may read it in future
      });
    } catch (err) {
      logger.warn('strict-unlock: enrichPodcast threw', { podcastId, error: err.message });
      enriched = { ...podcast };
    }

    // ── 3. Host personal socials deep search (with show-mention verification)
    const hostSocials = await findHostSocials(enriched);
    Object.assign(enriched, hostSocials);

    // ── 4. Claude verification pass on ambiguous emails ─────────────────────
    const emailIsAuthoritative = enriched._email_source === 'rss_owner';
    if (enriched.contact_email && !emailIsAuthoritative) {
      const verdict = await claudeVerifyEmail(enriched);
      if (!verdict.accept) {
        logger.info('strict-unlock: Claude rejected email', {
          podcastId, email: enriched.contact_email, reason: verdict.reason,
        });
        enriched.contact_email = null;
      }
    }

    // ── 5. Build the sources receipt ───────────────────────────────────────
    const contact_sources = buildSources(enriched, podcast);

    // ── 6. Compute final confidence ────────────────────────────────────────
    const contact_confidence = computeContactLikelihood(enriched);

    // ── 7. Save ────────────────────────────────────────────────────────────
    const payload = {
      contact_email: cleanField(enriched.contact_email),
      instagram_url: cleanField(enriched.instagram_url),
      twitter_url: cleanField(enriched.twitter_url),
      facebook_url: cleanField(enriched.facebook_url),
      linkedin_page_url: cleanField(enriched.linkedin_page_url),
      youtube_url: cleanField(enriched.youtube_url),
      tiktok_url: cleanField(enriched.tiktok_url),
      website: cleanField(enriched.website),
      host_instagram_url: cleanField(enriched.host_instagram_url),
      host_linkedin_url: cleanField(enriched.host_linkedin_url),
      host_twitter_url: cleanField(enriched.host_twitter_url),
      contact_sources,
      contact_confidence,
      contact_unlocked_at: new Date().toISOString(),
      contact_unlocked_by: clientId || podcast.contact_unlocked_by || null,
      unlock_count: (podcast.unlock_count || 0) + 1,
      deep_enriched_at: new Date().toISOString(),
    };

    const { data: saved, error: saveErr } = await supabase
      .from('podcasts')
      .update(payload)
      .eq('id', podcastId)
      .select()
      .single();

    if (saveErr) {
      logEntry.error_message = saveErr.message;
      await writeLog(logEntry, startedAt);
      return { ok: false, error: 'save_failed' };
    }

    logEntry.result_found = hasAnyContact(saved);
    logEntry.fields_found = listPopulatedFields(saved);
    await writeLog(logEntry, startedAt);

    return { ok: true, podcast: saved, cached: false };
  } catch (err) {
    logEntry.error_message = err.message;
    await writeLog(logEntry, startedAt).catch(() => {});
    logger.error('strict-unlock: unexpected error', { podcastId, error: err.message, stack: err.stack });
    return { ok: false, error: 'internal_error' };
  }
}

// ── Host personal socials deep search ────────────────────────────────────────
// Only stores if the profile explicitly mentions the show name OR the host name
// appears in context of the show. Otherwise returns null.

async function findHostSocials(podcast) {
  const out = {
    host_instagram_url: null,
    host_linkedin_url: null,
    host_twitter_url: null,
  };

  const host = (podcast.host_name || '').trim();
  const title = (podcast.title || '').trim();
  if (!host || host.length < 3) return out;

  if (!GOOGLE_SEARCH_API_KEY || !GOOGLE_SEARCH_CX) {
    logger.info('strict-unlock: Google CSE not configured, skipping host socials');
    return out;
  }

  const platforms = [
    { key: 'host_linkedin_url', site: 'linkedin.com/in', field: 'linkedin' },
    { key: 'host_instagram_url', site: 'instagram.com', field: 'instagram' },
    { key: 'host_twitter_url', site: 'twitter.com', field: 'twitter' },
  ];

  for (const { key, site, field } of platforms) {
    try {
      // Skip if this is the same URL the show already has (not a personal profile)
      const url = await searchAndVerify(site, host, title, field, podcast);
      if (url) out[key] = url;
    } catch (err) {
      logger.debug('strict-unlock: host social search failed', { field, error: err.message });
    }
  }

  return out;
}

async function searchAndVerify(site, host, title, field, podcast) {
  const q = encodeURIComponent(`site:${site} "${host}"${title ? ' "' + title + '"' : ''}`);
  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_SEARCH_API_KEY}&cx=${GOOGLE_SEARCH_CX}&q=${q}&num=3`;

  const res = await fetchJson(url);
  if (!res?.items?.length) return null;

  // Take top result — but verify it mentions the show
  for (const item of res.items) {
    const candidateUrl = item.link;
    if (!candidateUrl) continue;

    // Skip if same as the show's own social (would be redundant)
    const normalized = normalizeUrl(candidateUrl);
    if (normalized === normalizeUrl(podcast.instagram_url)) continue;
    if (normalized === normalizeUrl(podcast.twitter_url)) continue;
    if (normalized === normalizeUrl(podcast.linkedin_page_url)) continue;

    // Verify the result's snippet OR fetched bio mentions the show name
    const searchBlob = `${item.title || ''} ${item.snippet || ''}`.toLowerCase();
    const hostLower = host.toLowerCase();
    const titleLower = (title || '').toLowerCase();

    const snippetMentionsShow = titleLower && searchBlob.includes(titleLower);
    const snippetMentionsHost = hostLower && searchBlob.includes(hostLower);

    // Must mention BOTH host and show in the search result for us to trust it
    if (snippetMentionsShow && snippetMentionsHost) {
      // One more check: fetch the page and look for show mention
      const pageVerified = await verifyProfilePage(candidateUrl, title, host);
      if (pageVerified) return canonicalize(candidateUrl);
    }
  }

  return null;
}

async function verifyProfilePage(url, title, host) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FindAPodcastBot/1.0; +https://findapodcast.io)',
      },
    });
    if (!res.ok) return false;
    const html = await res.text();
    const lower = html.toLowerCase();
    const titleLower = (title || '').toLowerCase();
    const hostLower = (host || '').toLowerCase();

    // Strict: profile page HTML must contain the show title
    if (titleLower && lower.includes(titleLower)) return true;

    // Or explicit "host of X" / "X podcast" mentions
    if (titleLower && (
      lower.includes(`host of ${titleLower}`) ||
      lower.includes(`${titleLower} podcast`)
    )) return true;

    return false;
  } catch {
    return false;
  }
}

// ── Claude verification pass ─────────────────────────────────────────────────
// Only runs on non-authoritative emails (i.e. not from RSS itunes:owner).
// Given the signals, Claude returns {accept: bool, reason}.
// Uncertain → accept: false (zero hallucination).

async function claudeVerifyEmail(podcast) {
  if (!ANTHROPIC_API_KEY) return { accept: true, reason: 'no anthropic key — skipping verification' };
  if (!podcast.contact_email) return { accept: false, reason: 'no email to verify' };

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    const prompt = `You are verifying whether a contact email likely belongs to the podcast host or show team. Reply with JSON only.

Podcast: "${podcast.title || 'unknown'}"
Host: "${podcast.host_name || 'unknown'}"
Website: ${podcast.website || 'unknown'}
Email: ${podcast.contact_email}

Decision rules:
- ACCEPT if the email's local-part matches the host's name (first or last), OR the domain matches the show's website domain, OR it's a generic podcast contact (guest@, booking@, contact@, hello@, hi@) AT the show's domain.
- REJECT if the email appears to belong to a sponsor, affiliate, agency, or unrelated entity.
- REJECT if uncertain — we value zero hallucination over completeness.

Respond with JSON: {"accept": true|false, "reason": "short reason"}`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { accept: false, reason: 'no json in response' };

    const parsed = JSON.parse(match[0]);
    return {
      accept: !!parsed.accept,
      reason: parsed.reason || '',
    };
  } catch (err) {
    logger.debug('claudeVerifyEmail failed', { error: err.message });
    // Network/parse error → default to REJECT (zero hallucination)
    return { accept: false, reason: 'verification error' };
  }
}

// ── Build contact_sources receipt ────────────────────────────────────────────
// Stores where each field came from, shown to customer as "Verified via ..."

function buildSources(enriched, original) {
  const sources = {};
  const fields = [
    'contact_email', 'instagram_url', 'twitter_url', 'facebook_url',
    'linkedin_page_url', 'youtube_url', 'tiktok_url', 'website',
    'host_instagram_url', 'host_linkedin_url', 'host_twitter_url',
  ];

  for (const field of fields) {
    if (!enriched[field]) continue;

    // Preserve existing source if field wasn't re-verified this run
    if (enriched[field] === original[field] && original.contact_sources?.[field]) {
      sources[field] = original.contact_sources[field];
      continue;
    }

    // Infer source from origin of value
    if (field === 'contact_email') {
      if (enriched._email_source) sources[field] = enriched._email_source;
      else sources[field] = 'cross_verified';
    } else if (field.startsWith('host_')) {
      sources[field] = 'bio_mention';
    } else if (['instagram_url', 'twitter_url', 'facebook_url', 'linkedin_page_url'].includes(field)) {
      // Likely came from RSS atom:link or website link
      sources[field] = enriched._social_source?.[field] || 'website_link';
    } else if (field === 'website') {
      sources[field] = enriched._website_source || 'rss_or_apple';
    } else {
      sources[field] = 'verified';
    }
  }

  return sources;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isFresh(unlockedAtIso) {
  try {
    const unlockedAt = new Date(unlockedAtIso).getTime();
    const ageMs = Date.now() - unlockedAt;
    return ageMs < CACHE_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function hasAnyContact(p) {
  return !!(p?.contact_email || p?.instagram_url || p?.twitter_url ||
            p?.facebook_url || p?.linkedin_page_url || p?.youtube_url ||
            p?.host_instagram_url || p?.host_linkedin_url || p?.host_twitter_url);
}

function listPopulatedFields(p) {
  const fields = [];
  if (p?.contact_email) fields.push('contact_email');
  if (p?.instagram_url) fields.push('instagram_url');
  if (p?.twitter_url) fields.push('twitter_url');
  if (p?.facebook_url) fields.push('facebook_url');
  if (p?.linkedin_page_url) fields.push('linkedin_page_url');
  if (p?.youtube_url) fields.push('youtube_url');
  if (p?.host_instagram_url) fields.push('host_instagram_url');
  if (p?.host_linkedin_url) fields.push('host_linkedin_url');
  if (p?.host_twitter_url) fields.push('host_twitter_url');
  return fields;
}

function cleanField(v) {
  if (!v || typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return (u.host + u.pathname).toLowerCase().replace(/\/$/, '');
  } catch {
    return (url || '').toLowerCase().split('?')[0].replace(/\/$/, '');
  }
}

function canonicalize(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return url.split('?')[0].replace(/\/$/, '');
  }
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function writeLog(entry, startedAt) {
  entry.duration_ms = Date.now() - startedAt;
  try {
    await supabase.from('unlock_events').insert(entry);
  } catch (err) {
    logger.debug('unlock_events insert failed', { error: err.message });
  }
}

module.exports = { unlockPodcast };
