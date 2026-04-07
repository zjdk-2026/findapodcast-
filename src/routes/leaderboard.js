'use strict';

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

const router = express.Router();

/**
 * GET /api/leaderboard
 * Returns ranked stats for all active clients.
 * Passes x-dashboard-token so the caller's own row is flagged is_me: true.
 * Names are shown as "First L." for privacy.
 */
router.get('/leaderboard', async (req, res) => {
  const token = req.headers['x-dashboard-token'] || req.query.token;

  try {
    // Pull all active clients + their match counts
    const { data: clients, error } = await supabase
      .from('clients')
      .select('id, name, dashboard_token, is_active')
      .eq('is_active', true);

    if (error) throw error;
    if (!clients?.length) return res.json({ success: true, rows: [] });

    // Pull match status counts in one query
    const { data: matches } = await supabase
      .from('podcast_matches')
      .select('client_id, status')
      .in('client_id', clients.map(c => c.id));

    // Aggregate per client
    const counts = {};
    for (const m of matches || []) {
      if (!counts[m.client_id]) counts[m.client_id] = { booked: 0, sent: 0, appeared: 0, total: 0 };
      counts[m.client_id].total++;
      if (m.status === 'booked')   counts[m.client_id].booked++;
      if (m.status === 'sent' || m.status === 'followed_up') counts[m.client_id].sent++;
      if (m.status === 'appeared') counts[m.client_id].appeared++;
    }

    // Build rows — display name is "First L." format
    const rows = clients.map(c => {
      const parts  = (c.name || 'Anonymous').trim().split(' ');
      const first  = parts[0] || 'Someone';
      const last   = parts[1] ? parts[1][0].toUpperCase() + '.' : '';
      const display = last ? `${first} ${last}` : first;
      const stats  = counts[c.id] || { booked: 0, sent: 0, appeared: 0, total: 0 };
      return {
        display_name: display,
        is_me:        c.dashboard_token === token,
        booked:       stats.booked,
        sent:         stats.sent,
        appeared:     stats.appeared,
        total:        stats.total,
      };
    });

    // Sort: booked DESC → sent DESC → appeared DESC → total DESC
    rows.sort((a, b) =>
      b.booked - a.booked ||
      b.sent   - a.sent   ||
      b.appeared - a.appeared ||
      b.total  - a.total
    );

    // Add rank
    rows.forEach((r, i) => { r.rank = i + 1; });

    logger.debug('Leaderboard fetched', { count: rows.length });
    return res.json({ success: true, rows });
  } catch (err) {
    logger.error('Leaderboard error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to load leaderboard.' });
  }
});

module.exports = router;
