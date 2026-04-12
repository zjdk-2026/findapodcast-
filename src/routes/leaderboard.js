'use strict';

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

const router = express.Router();

/**
 * GET /api/leaderboard
 * Returns:
 *  - community: opted-in members with full name + social links (cards section)
 *  - rows: all active clients ranked (anonymised if not opted in)
 */
router.get('/leaderboard', async (req, res) => {
  const token = req.headers['x-dashboard-token'] || req.query.token;

  try {
    const { data: clients, error } = await supabase
      .from('clients')
      .select('id, name, dashboard_token, is_active, share_with_community, photo_url, title, business_name, website, social_instagram, social_linkedin, social_twitter, social_facebook, extra_links')
      .eq('is_active', true);

    if (error) throw error;
    if (!clients?.length) return res.json({ success: true, rows: [], community: [] });

    const { data: matches } = await supabase
      .from('podcast_matches')
      .select('client_id, status')
      .in('client_id', clients.map(c => c.id));

    const counts = {};
    for (const m of matches || []) {
      if (!counts[m.client_id]) counts[m.client_id] = { booked: 0, sent: 0, appeared: 0, total: 0 };
      counts[m.client_id].total++;
      if (m.status === 'booked')                              counts[m.client_id].booked++;
      if (m.status === 'sent' || m.status === 'followed_up') counts[m.client_id].sent++;
      if (m.status === 'appeared')                           counts[m.client_id].appeared++;
    }

    const rows = clients.map(c => {
      const isMe   = c.dashboard_token === token;
      const parts  = (c.name || 'Anonymous').trim().split(' ');
      const first  = parts[0] || 'Someone';
      const last   = parts[1] ? parts[1][0].toUpperCase() + '.' : '';
      const stats  = counts[c.id] || { booked: 0, sent: 0, appeared: 0, total: 0 };
      return {
        display_name:   c.share_with_community || isMe ? (c.name || first) : (last ? `${first} ${last}` : first),
        is_me:          isMe,
        share_with_community: !!(c.share_with_community),
        photo_url:      (c.share_with_community || isMe) ? (c.photo_url || null) : null,
        title:          (c.share_with_community || isMe) ? (c.title || null) : null,
        business_name:  (c.share_with_community || isMe) ? (c.business_name || null) : null,
        website:        (c.share_with_community || isMe) ? (c.website || null) : null,
        social_instagram: (c.share_with_community || isMe) ? (c.social_instagram || null) : null,
        social_linkedin:  (c.share_with_community || isMe) ? (c.social_linkedin || null) : null,
        social_twitter:   (c.share_with_community || isMe) ? (c.social_twitter || null) : null,
        social_facebook:  (c.share_with_community || isMe) ? (c.social_facebook || null) : null,
        booked:   stats.booked,
        sent:     stats.sent,
        appeared: stats.appeared,
        total:    stats.total,
      };
    });

    rows.sort((a, b) =>
      b.booked   - a.booked   ||
      b.sent     - a.sent     ||
      b.appeared - a.appeared ||
      b.total    - a.total
    );
    rows.forEach((r, i) => { r.rank = i + 1; });

    // Community section: only opted-in members
    const community = rows.filter(r => r.share_with_community);

    logger.debug('Leaderboard fetched', { total: rows.length, community: community.length });
    return res.json({ success: true, rows, community });
  } catch (err) {
    logger.error('Leaderboard error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to load leaderboard.' });
  }
});

module.exports = router;
