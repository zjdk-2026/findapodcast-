'use strict';

/**
 * Thread routes — inbox & reply pipeline (Resend-based, no Gmail).
 *
 * GET   /api/thread/:matchId            — full conversation history (from DB)
 * POST  /api/reply/:matchId             — send a threaded reply via Resend
 * POST  /api/thread/:matchId/mark-read  — zero unread_inbound_count
 *
 * All require dashboard token + match must belong to the requesting client.
 * Replies use sendEmail with In-Reply-To headers so they thread on the host's side.
 */

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const requireDashboardToken = require('../middleware/requireDashboardToken');
const { sendEmail } = require('../services/resendMailService');
const { chargeCredits } = require('../lib/credits');

const router = express.Router();
router.use(requireDashboardToken);

// ── GET /api/thread/:matchId ─────────────────────────────────────────────
router.get('/thread/:matchId', async (req, res) => {
  const { matchId } = req.params;
  if (!matchId) return res.status(400).json({ ok: false, error: 'matchId_required' });

  try {
    const { data: match, error: mErr } = await supabase
      .from('podcast_matches')
      .select('id, client_id, status, message_count, unread_inbound_count, last_message_at, last_reply_seen_at, podcasts(title, host_name, contact_email)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (mErr || !match) return res.status(404).json({ ok: false, error: 'match_not_found' });

    const { data: messages } = await supabase
      .from('match_thread_messages')
      .select('*')
      .eq('match_id', matchId)
      .order('sent_at', { ascending: true });

    res.json({
      ok: true,
      match: {
        id:                    match.id,
        status:                match.status,
        message_count:         match.message_count || (messages || []).length,
        unread_inbound_count:  match.unread_inbound_count || 0,
        host_name:             match.podcasts?.host_name || null,
        host_email:            match.podcasts?.contact_email || null,
        podcast_title:         match.podcasts?.title || null,
      },
      messages: messages || [],
    });
  } catch (err) {
    logger.error('GET /api/thread error', { matchId, error: err.message });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ── POST /api/reply/:matchId ─────────────────────────────────────────────
router.post('/reply/:matchId', async (req, res) => {
  const { matchId } = req.params;
  const { subject, body } = req.body || {};
  if (!matchId) return res.status(400).json({ ok: false, error: 'matchId_required' });
  if (!body || !body.trim()) return res.status(400).json({ ok: false, error: 'body_required' });

  // Credit gate (1 credit per manual reply send)
  const charge = await chargeCredits(req.clientId, 'followup_send', { matchId, source: 'manual_reply' });
  if (!charge.ok) {
    if (charge.error === 'insufficient_credits') {
      return res.status(402).json({ ok: false, error: 'insufficient_credits', balance: charge.balance, needed: charge.needed });
    }
    return res.status(500).json({ ok: false, error: 'credit_charge_failed' });
  }

  try {
    const { data: match, error: mErr } = await supabase
      .from('podcast_matches')
      .select('id, client_id, message_count, podcasts(contact_email, title), clients(name)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (mErr || !match) return res.status(404).json({ ok: false, error: 'match_not_found' });

    const to = match.podcasts?.contact_email;
    if (!to?.includes('@')) return res.status(400).json({ ok: false, error: 'no_host_email' });

    // Find the latest message in the thread to use its Message-ID for In-Reply-To
    const { data: latestRow } = await supabase
      .from('match_thread_messages')
      .select('rfc822_message_id, subject')
      .eq('match_id', matchId)
      .order('sent_at', { ascending: false })
      .limit(1)
      .single();

    const inReplyTo = latestRow?.rfc822_message_id || null;
    const references = inReplyTo ? inReplyTo : null;

    const finalSubject = (subject && subject.trim())
      || (latestRow?.subject ? (latestRow.subject.startsWith('Re:') ? latestRow.subject : `Re: ${latestRow.subject}`) : `Re: ${match.podcasts?.title || ''}`);

    // Send via Resend with threading headers
    const sentResult = await sendEmail({
      to,
      subject: finalSubject,
      body,
      inReplyTo: inReplyTo || undefined,
      references: references || undefined,
    });

    // Persist the outbound reply in the thread ledger
    if (sentResult?.id) {
      try {
        await supabase.from('match_thread_messages').insert({
          match_id:          matchId,
          gmail_message_id:  sentResult.id,
          direction:         'outbound',
          message_type:      'customer_reply',
          from_email:        sentResult.from || null,
          to_email:          to,
          subject:           finalSubject,
          body_text:         body,
          rfc822_message_id: sentResult.id,
          in_reply_to:       inReplyTo || null,
          sent_at:           new Date().toISOString(),
        });
      } catch (logErr) {
        logger.warn('thread reply: ledger insert failed', { matchId, error: logErr.message });
      }
    }

    // Bump match metadata
    await supabase.from('podcast_matches').update({
      last_message_at:  new Date().toISOString(),
      message_count:    (match.message_count || 0) + 1,
    }).eq('id', matchId);

    logger.info('Manual reply sent via Resend', { matchId, to });
    res.json({ ok: true, message_id: sentResult?.id, credits_balance: charge.balance });
  } catch (err) {
    logger.error('POST /api/reply error', { matchId, error: err.message });
    res.status(500).json({ ok: false, error: 'send_failed', message: err.message });
  }
});

// ── POST /api/thread/:matchId/mark-read ─────────────────────────────────
router.post('/thread/:matchId/mark-read', async (req, res) => {
  const { matchId } = req.params;
  try {
    await supabase.from('podcast_matches')
      .update({ unread_inbound_count: 0, last_reply_seen_at: new Date().toISOString() })
      .eq('id', matchId)
      .eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (err) {
    logger.error('mark-read error', { matchId, error: err.message });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
