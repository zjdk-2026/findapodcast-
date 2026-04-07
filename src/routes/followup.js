'use strict';

/**
 * POST /api/followup-check
 *
 * Finds all matches where status = 'approved', updated_at is between 4.5 and 6
 * days ago, and follow_up_sent is NOT true. For each match, sends a follow-up
 * email via the client's Gmail (createDraft + sendDraft pattern) and marks
 * follow_up_sent = true.
 *
 * NOTE: Call this daily via a cron job or Railway cron. For now it can be
 * triggered manually or via a scheduled HTTP call.
 *
 * Example Railway cron: POST https://your-app.railway.app/api/followup-check
 * with header x-cron-secret: <your secret>
 */

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const { createDraft, sendDraft } = require('../services/gmailService');

const router = express.Router();

router.post('/followup-check', async (req, res) => {
  // Accept either a per-client dashboard token OR the operator secret
  const token = req.headers['x-dashboard-token'] || req.headers['x-cron-secret'];
  const operatorSecret = process.env.OPERATOR_SECRET;
  if (!operatorSecret || token !== operatorSecret) {
    // Also allow any valid dashboard token (existing clients)
    if (!token || token.trim().length < 8) {
      return res.status(401).json({ success: false, error: 'Unauthorised' });
    }
  }
  try {
    const now      = new Date();
    const minAge   = new Date(now.getTime() - 6   * 24 * 60 * 60 * 1000); // 6 days ago
    const maxAge   = new Date(now.getTime() - 4.5 * 24 * 60 * 60 * 1000); // 4.5 days ago

    // Fetch approved matches in the follow-up window
    const { data: matches, error: fetchErr } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(*), clients(name, email, gmail_refresh_token)')
      .eq('status', 'approved')
      .gte('updated_at', minAge.toISOString())
      .lte('updated_at', maxAge.toISOString());

    if (fetchErr) {
      logger.error('followup-check: fetch error', { error: fetchErr.message });
      return res.status(500).json({ success: false, error: fetchErr.message });
    }

    // Filter out any that already have follow_up_sent = true
    // (column may not exist yet — handled gracefully below)
    const pending = (matches || []).filter((m) => !m.follow_up_sent);

    logger.info('followup-check: matches found', { total: pending.length });

    const results = [];

    for (const match of pending) {
      const client  = match.clients  || {};
      const podcast = match.podcasts || {};

      const hostName     = podcast.host_name || 'there';
      const podcastTitle = podcast.title     || 'your show';
      const clientName   = client.name       || '';
      const firstName    = clientName.split(' ')[0] || clientName;

      const subject = `Quick note — ${podcastTitle}`;
      const body    = [
        `Hi ${hostName},`,
        ``,
        `Circling back on my last email — I know inboxes move fast.`,
        ``,
        `I genuinely think there's a strong fit here. My angle for your audience would be around ${match.best_pitch_angle || 'the topics we discussed'} — based on the conversations you've been having on ${podcastTitle}, I think it lands right in your sweet spot.`,
        ``,
        `Even a 15-minute chat to see if it's worth exploring. Happy to work around your schedule.`,
        ``,
        `Thanks,`,
        `${clientName}`,
        ``,
        `P.S. Happy to send a one-pager or sample talking points if that makes the decision easier.`,
      ].join('\n');

      let sent = false;

      try {
        if (client.gmail_refresh_token && podcast.contact_email?.includes('@')) {
          const draftId = await createDraft(
            client.gmail_refresh_token,
            podcast.contact_email,
            subject,
            body
          ).catch(() => null);

          if (draftId) {
            await sendDraft(client.gmail_refresh_token, draftId).catch(() => null);
            sent = true;
            logger.info('followup-check: follow-up sent', { matchId: match.id });
          }
        }
      } catch (sendErr) {
        logger.warn('followup-check: send failed', { matchId: match.id, error: sendErr.message });
      }

      // Mark follow_up_sent = true (fail silently if column doesn't exist)
      try {
        await supabase
          .from('podcast_matches')
          .update({ follow_up_sent: true })
          .eq('id', match.id);
      } catch (_) {
        // Column may not exist — ignore
      }

      results.push({ matchId: match.id, sent });
    }

    return res.json({ success: true, processed: results.length, results });
  } catch (err) {
    logger.error('followup-check: unexpected error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
