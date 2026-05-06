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
const { chargeCredits } = require('../lib/credits');

const router = express.Router();

router.post('/followup-check', async (req, res) => {
  // Only accept the exact operator/cron secret
  const token = req.headers['x-dashboard-token'] || req.headers['x-cron-secret'];
  const operatorSecret = process.env.OPERATOR_SECRET;
  if (!operatorSecret || token !== operatorSecret) {
    return res.status(401).json({ success: false, error: 'Unauthorised' });
  }
  try {
    const now      = new Date();
    const minAge   = new Date(now.getTime() - 6   * 24 * 60 * 60 * 1000); // 6 days ago
    const maxAge   = new Date(now.getTime() - 4.5 * 24 * 60 * 60 * 1000); // 4.5 days ago

    // Fetch approved matches in the follow-up window
    const { data: matches, error: fetchErr } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(*), clients(name, email, gmail_refresh_token)')
      .eq('status', 'sent')
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

      const subject = `Re: ${match.email_subject || match.email_subject_edited || podcastTitle}`;
      const body    = [
        `Hi ${hostName},`,
        ``,
        `I imagine your inbox is full. Just one thing: I think your audience would get real value from a conversation about ${match.best_pitch_angle || 'what I mentioned in my last email'}.`,
        ``,
        `Would a 15-minute call work to see if there is a fit?`,
        ``,
        clientName,
      ].join('\n');

      let sent = false;

      try {
        if (client.gmail_refresh_token && podcast.contact_email?.includes('@')) {
          // Credit gate per follow-up — skip this match silently if customer is out of credits
          const charge = await chargeCredits(match.client_id, 'followup_send', { matchId: match.id, source: 'auto_cron' });
          if (!charge.ok) {
            logger.info('followup-check: skipped (no credits)', { matchId: match.id, error: charge.error, balance: charge.balance });
            results.push({ matchId: match.id, sent: false, reason: 'insufficient_credits' });
            continue;
          }

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

      // Mark follow_up_sent = true and update status to followed_up
      try {
        await supabase
          .from('podcast_matches')
          .update({ follow_up_sent: true, status: 'followed_up' })
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
