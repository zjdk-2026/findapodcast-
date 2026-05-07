'use strict';

/**
 * POST /api/followup-check
 *
 * Finds all matches where status = 'sent', updated_at is between 4.5 and 6
 * days ago, and follow_up_sent is NOT true. For each match, sends a follow-up
 * email via Resend and marks follow_up_sent = true.
 *
 * Body resolution chain: client's default 'followup' template > hardcoded fallback.
 *
 * NOTE: This is the older (manual) cron route. The daily auto-sweep at 7am UTC
 * (followupSweep.js) handles the heavier lifting. This one exists for admin
 * override / manual trigger.
 */

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const { sendEmail } = require('../services/resendMailService');
const { chargeCredits } = require('../lib/credits');

const router = express.Router();

// ── Placeholder substitution ────────────────────────────────────────────
function replacePlaceholders(str, vars) {
  return (str || '').replace(/\{(\w+)\}/gi, (_, key) => {
    const k = key.toLowerCase();
    return vars[k] !== undefined && vars[k] !== null ? vars[k] : `{${key}}`;
  });
}

async function resolveBody(match) {
  const client  = match.clients  || {};
  const podcast = match.podcasts || {};

  const hostName     = podcast.host_name || 'there';
  const podcastTitle = podcast.title     || 'your show';
  const clientName   = client.name       || '';
  const firstName    = clientName.split(' ')[0] || clientName;
  const angle        = match.best_pitch_angle || match.email_subject_edited || match.email_subject || '';

  // 1. Try saved template
  const { data: templates } = await supabase
    .from('email_templates')
    .select('*')
    .eq('client_id', match.client_id)
    .eq('type', 'followup')
    .order('is_default', { ascending: false })
    .order('use_count', { ascending: false })
    .limit(1);

  const tpl = (templates && templates.length > 0) ? templates[0] : null;
  if (tpl && tpl.subject && tpl.body) {
    const vars = {
      host_name:         hostName,
      host_first_name:   hostName.split(' ')[0] || hostName,
      podcast_title:     podcastTitle,
      client_name:       clientName,
      client_first_name: firstName,
      one_liner:         client.bio_short || '',
      credential:        client.bio_short || '',
      business_name:     client.business_name || '',
    };

    // Bump use count
    try {
      await supabase.from('email_templates')
        .update({ use_count: (tpl.use_count || 0) + 1, last_used_at: new Date().toISOString() })
        .eq('id', tpl.id);
    } catch (_) {}

    return {
      subject: replacePlaceholders(tpl.subject, vars),
      body:    replacePlaceholders(tpl.body, vars),
      source:  'template',
    };
  }

  // 2. Hardcoded fallback
  const subject = `Re: ${match.email_subject || match.email_subject_edited || podcastTitle}`;
  const body = [
    `Hi ${hostName},`,
    ``,
    `I imagine your inbox is full. Just one thing: I think your audience would get real value from a conversation about ${angle || 'what I mentioned in my last email'}.`,
    ``,
    `Would a 15-minute call work to see if there is a fit?`,
    ``,
    clientName,
  ].join('\n');

  return { subject, body, source: 'fallback' };
}

router.post('/followup-check', async (req, res) => {
  // Only accept the exact operator/cron secret
  const token = req.headers['x-dashboard-token'] || req.headers['x-cron-secret'];
  const operatorSecret = process.env.OPERATOR_SECRET;
  if (!operatorSecret || token !== operatorSecret) {
    return res.status(401).json({ success: false, error: 'Unauthorised' });
  }

  try {
    const now      = new Date();
    const minAge   = new Date(now.getTime() - 6   * 24 * 60 * 60 * 1000);
    const maxAge   = new Date(now.getTime() - 4.5 * 24 * 60 * 60 * 1000);

    const { data: matches, error: fetchErr } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(*), clients(name, email, bio_short, business_name)')
      .eq('status', 'sent')
      .gte('updated_at', minAge.toISOString())
      .lte('updated_at', maxAge.toISOString());

    if (fetchErr) {
      logger.error('followup-check: fetch error', { error: fetchErr.message });
      return res.status(500).json({ success: false, error: fetchErr.message });
    }

    const pending = (matches || []).filter((m) => !m.follow_up_sent);
    logger.info('followup-check: matches found', { total: pending.length });

    const results = [];

    for (const match of pending) {
      const client  = match.clients  || {};
      const podcast = match.podcasts || {};

      if (!podcast.contact_email?.includes('@')) {
        results.push({ matchId: match.id, sent: false, reason: 'no_email' });
        continue;
      }

      let sent = false;
      let sentResult = null;

      try {
        // Credit gate
        const charge = await chargeCredits(match.client_id, 'followup_send', { matchId: match.id, source: 'auto_cron' });
        if (!charge.ok) {
          logger.info('followup-check: skipped (no credits)', { matchId: match.id, error: charge.error, balance: charge.balance });
          results.push({ matchId: match.id, sent: false, reason: 'insufficient_credits' });
          continue;
        }

        // Resolve body: template > fallback
        const { subject, body, source } = await resolveBody(match);
        logger.info('followup-check: body resolved', { matchId: match.id, source });

        sentResult = await sendEmail({
          to: podcast.contact_email,
          subject,
          body,
        });

        if (sentResult?.id) {
          sent = true;
          logger.info('followup-check: follow-up sent via Resend', { matchId: match.id, source });

          // Log thread message
          try {
            await supabase.from('match_thread_messages').insert({
              match_id:          match.id,
              gmail_message_id:  sentResult.id,
              direction:         'outbound',
              message_type:      'followup',
              from_email:        sentResult.from || null,
              to_email:          podcast.contact_email,
              subject,
              body_text:         body,
              rfc822_message_id: sentResult.id,
              sent_at:           new Date().toISOString(),
            });
          } catch (logErr) {
            logger.warn('followup-check: thread insert failed', { matchId: match.id, error: logErr.message });
          }
        }
      } catch (sendErr) {
        logger.warn('followup-check: send failed', { matchId: match.id, error: sendErr.message });
      }

      // Mark follow_up_sent
      try {
        await supabase
          .from('podcast_matches')
          .update({
            follow_up_sent:            true,
            status:                    'followed_up',
            gmail_followup_message_id: sentResult?.id || null,
            last_message_at:           new Date().toISOString(),
            message_count:             (match.message_count || 0) + 1,
          })
          .eq('id', match.id);
      } catch (_) {}

      results.push({ matchId: match.id, sent });
    }

    return res.json({ success: true, processed: results.length, results });
  } catch (err) {
    logger.error('followup-check: unexpected error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
