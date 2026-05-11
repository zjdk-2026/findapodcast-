'use strict';

const express        = require('express');
const supabase       = require('../lib/supabase');
const logger         = require('../lib/logger');
const { enrichPodcast } = require('../services/enrichment');

const router = express.Router();

const OPERATOR_KEY = process.env.OPERATOR_KEY || 'pipeline2026';

/**
 * Middleware: require x-operator-key header
 */
function requireOperatorKey(req, res, next) {
  const key = req.headers['x-operator-key'] || req.query.key;
  if (key !== OPERATOR_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }
  next();
}

/**
 * GET /api/operator/clients
 * Returns all clients with aggregated match counts.
 */
router.get('/clients', requireOperatorKey, async (req, res) => {
  try {
    // Fetch all clients
    const { data: clients, error: clientsError } = await supabase
      .from('clients')
      .select('id, name, email, last_run_at, is_active')
      .order('onboarded_at', { ascending: false });

    if (clientsError) {
      logger.error('Operator: failed to fetch clients', { error: clientsError.message });
      return res.status(500).json({ success: false, error: 'Failed to fetch clients.' });
    }

    // For each client, get match counts
    const enrichedClients = await Promise.all(
      (clients || []).map(async (client) => {
        const { data: matches, error: mErr } = await supabase
          .from('podcast_matches')
          .select('id, status')
          .eq('client_id', client.id);

        if (mErr) {
          logger.warn('Operator: failed to fetch matches for client', {
            clientId: client.id,
            error: mErr.message,
          });
          return {
            ...client,
            total_matches:  0,
            approved_count: 0,
            sent_count:     0,
            booked_count:   0,
          };
        }

        const all = matches || [];
        return {
          ...client,
          total_matches:  all.length,
          approved_count: all.filter((m) => m.status === 'approved').length,
          sent_count:     all.filter((m) => m.status === 'sent').length,
          booked_count:   all.filter((m) => m.status === 'booked').length,
        };
      })
    );

    // Aggregate totals
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekAgo    = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { count: matchesToday } = await supabase
      .from('podcast_matches')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', todayStart);

    const { count: sentThisWeek } = await supabase
      .from('podcast_matches')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'sent')
      .gte('sent_at', weekAgo);

    return res.json({
      success: true,
      clients: enrichedClients,
      totals: {
        total_clients:    enrichedClients.length,
        matches_today:    matchesToday  || 0,
        sent_this_week:   sentThisWeek  || 0,
      },
    });
  } catch (err) {
    logger.error('Operator clients route error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * GET /api/operator/dashboard/:clientId
 * Redirects to the client's dashboard without exposing the token in the client list.
 */
router.get('/dashboard/:clientId', requireOperatorKey, async (req, res) => {
  const { clientId } = req.params;
  try {
    const { data: client, error } = await supabase
      .from('clients')
      .select('dashboard_token')
      .eq('id', clientId)
      .single();

    if (error || !client) {
      return res.status(404).json({ success: false, error: 'Client not found.' });
    }

    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    return res.redirect(`${baseUrl}/dashboard/${client.dashboard_token}`);
  } catch (err) {
    logger.error('Operator dashboard redirect error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/operator/toggle-active
 * Body: { clientId, is_active }
 */
router.post('/toggle-active', requireOperatorKey, async (req, res) => {
  const { clientId, is_active } = req.body;
  if (!clientId) return res.status(400).json({ success: false, error: 'clientId is required.' });

  try {
    const { data, error } = await supabase
      .from('clients')
      .update({ is_active: !!is_active })
      .eq('id', clientId)
      .select('id, is_active')
      .single();

    if (error) {
      logger.error('Operator: failed to toggle active', { clientId, error: error.message });
      return res.status(500).json({ success: false, error: 'Failed to update client.' });
    }

    logger.info('Operator: toggled client active', { clientId, is_active });
    return res.json({ success: true, client: data });
  } catch (err) {
    logger.error('Operator toggle-active error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * GET /api/operator/podcasts-for-review
 * Returns all podcasts joined with their client name for the admin review queue.
 */
router.get('/podcasts-for-review', requireOperatorKey, async (req, res) => {
  try {
    const { data: matches, error } = await supabase
      .from('podcast_matches')
      .select('client_id, clients(name), podcasts(id, title, host_name, contact_email, website, apple_url, spotify_url, instagram_url, enriched_at)')
      .not('podcasts', 'is', null)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) return res.status(500).json({ success: false, error: error.message });

    // Deduplicate by podcast id, attach client name
    const seen = new Set();
    const podcasts = [];
    for (const m of matches || []) {
      if (!m.podcasts || seen.has(m.podcasts.id)) continue;
      seen.add(m.podcasts.id);
      podcasts.push({ ...m.podcasts, client_name: m.clients?.name || '' });
    }

    return res.json({ success: true, podcasts });
  } catch (err) {
    logger.error('podcasts-for-review error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/operator/patch-podcast
 * Patches specific fields on a podcast record.
 * Body: { podcastId, updates: { field: value } }
 */
router.post('/patch-podcast', requireOperatorKey, async (req, res) => {
  const { podcastId, updates } = req.body;
  if (!podcastId || !updates) return res.status(400).json({ success: false, error: 'podcastId and updates required.' });

  const ALLOWED_FIELDS = ['website', 'instagram_url', 'twitter_url', 'facebook_url', 'contact_email', 'host_name', 'apple_url', 'spotify_url'];
  const safe = Object.fromEntries(Object.entries(updates).filter(([k]) => ALLOWED_FIELDS.includes(k)));
  if (!Object.keys(safe).length) return res.status(400).json({ success: false, error: 'No allowed fields in updates.' });

  try {
    const { error } = await supabase.from('podcasts').update(safe).eq('id', podcastId);
    if (error) return res.status(500).json({ success: false, error: error.message });
    logger.info('Operator: podcast field patched', { podcastId, fields: Object.keys(safe) });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/operator/bulk-reenrich
 * Re-enriches all podcasts that have bad data:
 *   - website is a platform URL (Apple/Spotify/etc stored as website)
 *   - never been enriched (enriched_at is null)
 *   - enriched more than 30 days ago
 * Processes in batches of 5 with a 2s delay between each to avoid hammering APIs.
 * Returns immediately with a job ID; progress logged server-side.
 */
router.post('/bulk-reenrich', requireOperatorKey, async (req, res) => {
  const PLATFORM_PATTERNS = [
    'podcasts.apple.com', 'itunes.apple.com', 'open.spotify.com',
    'anchor.fm', 'soundcloud.com', 'stitcher.com', 'podbean.com',
    'buzzsprout.com', 'transistor.fm', 'simplecast.com', 'libsyn.com',
    'captivate.fm', 'redcircle.com', 'listennotes.com', 'megaphone.fm',
  ];

  try {
    // Fetch all podcasts — we'll filter client-side for platform URLs
    const { data: allPodcasts, error } = await supabase
      .from('podcasts')
      .select('id, title, website, apple_url, spotify_url, instagram_url, contact_email, rss_feed_url, host_name, external_id, enriched_at')
      .order('enriched_at', { ascending: true, nullsFirst: true });

    if (error) return res.status(500).json({ success: false, error: error.message });

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const needsReenrich = allPodcasts.filter(p => {
      const websiteIsBad = p.website && PLATFORM_PATTERNS.some(d => p.website.toLowerCase().includes(d));
      const neverEnriched = !p.enriched_at;
      const stale = p.enriched_at && p.enriched_at < thirtyDaysAgo;
      return websiteIsBad || neverEnriched || stale;
    });

    logger.info('Bulk re-enrich started', { total: needsReenrich.length });
    res.json({ success: true, queued: needsReenrich.length, message: `Re-enriching ${needsReenrich.length} podcasts in background.` });

    // Process in background — don't await
    (async () => {
      let done = 0;
      for (const podcast of needsReenrich) {
        try {
          const enriched = await enrichPodcast(podcast);

          const isPlatform = (url) => url && PLATFORM_PATTERNS.some(d => url.toLowerCase().includes(d));
          const freshWebsite  = enriched.website  && !isPlatform(enriched.website)  ? enriched.website  : null;
          const keepOldWeb    = podcast.website   && !isPlatform(podcast.website)   ? podcast.website   : null;

          await supabase.from('podcasts').update({
            host_name:     enriched.host_name     || podcast.host_name,
            website:       freshWebsite            || keepOldWeb || null,
            contact_email: enriched.contact_email || podcast.contact_email,
            apple_url:     enriched.apple_url     || podcast.apple_url,
            spotify_url:   enriched.spotify_url   || podcast.spotify_url,
            instagram_url: enriched.instagram_url || null,
            twitter_url:   enriched.twitter_url   || null,
            facebook_url:  enriched.facebook_url  || null,
            linkedin_page_url: enriched.linkedin_page_url || null,
            rss_feed_url:  enriched.rss_feed_url  || podcast.rss_feed_url,
            enriched_at:   new Date().toISOString(),
          }).eq('id', podcast.id);

          done++;
          if (done % 10 === 0) logger.info('Bulk re-enrich progress', { done, total: needsReenrich.length });
        } catch (err) {
          logger.warn('Bulk re-enrich: podcast failed', { id: podcast.id, title: podcast.title, error: err.message });
        }
        // 2s throttle between each podcast
        await new Promise(r => setTimeout(r, 2000));
      }
      logger.info('Bulk re-enrich complete', { done, total: needsReenrich.length });
    })();

  } catch (err) {
    logger.error('Bulk re-enrich error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/operator/leaderboard
 * Live leaderboard ranked by monthly_points DESC. Operator-only.
 * Customer dashboard does NOT show this — points are invisible to them until launch.
 */
router.get('/leaderboard', requireOperatorKey, async (req, res) => {
  try {
    const { data: clients, error } = await supabase
      .from('clients')
      .select('id, name, email, credits_remaining, unlimited_credits, monthly_points, lifetime_points, last_action_at, is_active')
      .order('monthly_points', { ascending: false });

    if (error) {
      logger.error('Operator leaderboard fetch failed', { error: error.message });
      return res.status(500).json({ success: false, error: error.message });
    }

    // Compute ranks (handles ties — same rank for tied scores)
    let lastPoints = null;
    let lastRank = 0;
    const ranked = (clients || []).map((c, idx) => {
      if (c.monthly_points !== lastPoints) {
        lastRank = idx + 1;
        lastPoints = c.monthly_points;
      }
      return { ...c, rank: lastRank };
    });

    // Recent transactions for context (last 50)
    const { data: recent } = await supabase
      .from('credit_transactions')
      .select('client_id, action, credits_delta, points_delta, created_at')
      .order('created_at', { ascending: false })
      .limit(50);

    res.json({ ok: true, clients: ranked, recent_transactions: recent || [] });
  } catch (err) {
    logger.error('Operator leaderboard error', { error: err.message });
    res.status(500).json({ success: false, error: 'internal_error' });
  }
});

/**
 * GET /api/operator/leaderboard.html
 * Renders a simple HTML leaderboard page for operator viewing.
 */
router.get('/leaderboard.html', requireOperatorKey, async (req, res) => {
  try {
    const { data: clients } = await supabase
      .from('clients')
      .select('id, name, email, credits_remaining, unlimited_credits, monthly_points, lifetime_points, last_action_at, is_active')
      .order('monthly_points', { ascending: false });

    let lastPoints = null;
    let lastRank = 0;
    const rows = (clients || []).map((c, idx) => {
      if (c.monthly_points !== lastPoints) {
        lastRank = idx + 1;
        lastPoints = c.monthly_points;
      }
      const isLeader = lastRank === 1 && c.monthly_points > 0;
      const last = c.last_action_at ? new Date(c.last_action_at).toLocaleString() : '—';
      const credits = c.unlimited_credits ? 'UNLIMITED' : c.credits_remaining ?? 0;
      const initials = (c.name || c.email || '?').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
      return `
        <tr style="${isLeader ? 'background:rgba(245,158,11,0.08);' : ''}">
          <td style="padding:10px 14px;font-weight:800;font-size:14px;${isLeader ? 'color:#f59e0b;' : ''}">${isLeader ? '🏆 ' : ''}${lastRank}</td>
          <td style="padding:10px 14px;">
            <div style="display:flex;align-items:center;gap:10px;">
              <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fff;flex-shrink:0;">${initials}</div>
              <div>
                <div style="font-weight:700;font-size:14px;">${c.name || '(no name)'}</div>
                <div style="font-size:11px;color:#6b7280;">${c.email || ''}</div>
              </div>
            </div>
          </td>
          <td style="padding:10px 14px;font-weight:800;font-size:18px;color:#10b981;">${c.monthly_points ?? 0}</td>
          <td style="padding:10px 14px;font-size:13px;color:#6b7280;">${c.lifetime_points ?? 0}</td>
          <td style="padding:10px 14px;font-size:13px;${c.unlimited_credits ? 'color:#8b5cf6;font-weight:700;' : ''}">${credits}</td>
          <td style="padding:10px 14px;font-size:11px;color:#6b7280;">${last}</td>
          <td style="padding:10px 14px;font-size:11px;">${c.is_active ? '✅' : '⏸'}</td>
        </tr>
      `;
    }).join('');

    res.send(`
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Operator Leaderboard</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f0f17; color: #f1f5f9; padding: 32px; margin: 0; }
  h1 { margin: 0 0 8px; font-size: 28px; font-weight: 900; }
  .sub { color: #94a3b8; font-size: 14px; margin-bottom: 28px; }
  table { width: 100%; max-width: 1200px; border-collapse: collapse; background: #1c1c2e; border-radius: 14px; overflow: hidden; }
  th { text-align: left; padding: 12px 14px; background: #13131f; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.06); }
  tr:nth-child(even) { background: rgba(255,255,255,0.02); }
  tr:hover { background: rgba(99,102,241,0.06); }
  td { border-bottom: 1px solid rgba(255,255,255,0.04); }
  .refresh { display: inline-block; margin-bottom: 18px; padding: 8px 16px; background: #6366f1; color: #fff; border-radius: 999px; text-decoration: none; font-size: 13px; font-weight: 600; }
</style></head><body>
  <h1>🏆 Operator Leaderboard</h1>
  <p class="sub">Live points ranking. Customer-invisible. Refreshes on page load. Top of monthly_points wins +50 credits at month-end.</p>
  <a href="?key=${OPERATOR_KEY}" class="refresh">⟳ Refresh</a>
  <table>
    <thead>
      <tr>
        <th>Rank</th>
        <th>Client</th>
        <th>Monthly Pts</th>
        <th>Lifetime Pts</th>
        <th>Credits</th>
        <th>Last Action</th>
        <th>Active</th>
      </tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="7" style="padding:40px;text-align:center;color:#6b7280;">No clients yet.</td></tr>'}</tbody>
  </table>
</body></html>
    `);
  } catch (err) {
    logger.error('Operator leaderboard HTML error', { error: err.message });
    res.status(500).send('Internal error');
  }
});

/**
 * POST /api/operator/update-client
 * Updates arbitrary safe fields on a client record.
 * Body: { clientId, updates: { field: value } }
 */
router.post('/update-client', requireOperatorKey, async (req, res) => {
  const { clientId, updates } = req.body;
  if (!clientId || !updates) return res.status(400).json({ success: false, error: 'clientId and updates required.' });

  const ALLOWED = ['demo_mode', 'unlimited_credits', 'credits_remaining', 'is_active', 'plan', 'onboarding'];
  const safe = Object.fromEntries(Object.entries(updates).filter(([k]) => ALLOWED.includes(k)));
  if (!Object.keys(safe).length) return res.status(400).json({ success: false, error: 'No allowed fields in updates.' });

  try {
    const { data, error } = await supabase
      .from('clients')
      .update(safe)
      .eq('id', clientId)
      .select('id, name, email, plan, unlimited_credits, credits_remaining, is_active, demo_mode')
      .single();

    if (error) return res.status(500).json({ success: false, error: error.message });
    logger.info('Operator: client updated', { clientId, updates });
    return res.json({ success: true, client: data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
