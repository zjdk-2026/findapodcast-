'use strict';

/**
 * Thread routes — Phase B of reply pipeline.
 *
 * GET    /api/thread/:matchId            — full conversation history
 * POST   /api/reply/:matchId             — send a threaded reply via Gmail
 * POST   /api/thread/:matchId/mark-read  — zero unread_inbound_count
 *
 * All require dashboard token + match must belong to the requesting client.
 * Replies use sendThreadedReply with In-Reply-To headers so they thread on
 * the host's side.
 */

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const requireDashboardToken = require('../middleware/requireDashboardToken');
const { sendThreadedReply, getMessageMetadata, fetchThread } = require('../services/gmailService');
const { chargeCredits } = require('../lib/credits');

const router = express.Router();
router.use(requireDashboardToken);

// ── GET /api/thread/:matchId ─────────────────────────────────────────────
router.get('/thread/:matchId', async (req, res) => {
  const { matchId } = req.params;
  if (!matchId) return res.status(400).json({ ok: false, error: 'matchId_required' });

  try {
    // Fetch match + verify ownership + grab Gmail metadata
    const { data: match, error: mErr } = await supabase
      .from('podcast_matches')
      .select('id, client_id, status, gmail_thread_id, gmail_pitch_message_id, message_count, unread_inbound_count, last_message_at, last_reply_seen_at, podcasts(title, host_name, contact_email), clients(gmail_refresh_token, gmail_email)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (mErr || !match) return res.status(404).json({ ok: false, error: 'match_not_found' });

    // Pull stored messages
    const { data: messages } = await supabase
      .from('match_thread_messages')
      .select('*')
      .eq('match_id', matchId)
      .order('sent_at', { ascending: true });

    // Lazy refresh: if customer is opening a thread we haven't synced recently,
    // re-fetch from Gmail to catch any new back-and-forth messages.
    let messagesOut = messages || [];
    if (match.gmail_thread_id && match.clients?.gmail_refresh_token) {
      const lastSync = match.last_message_at ? new Date(match.last_message_at).getTime() : 0;
      const stale = Date.now() - lastSync > 5 * 60 * 1000; // 5 min
      if (stale) {
        try {
          const fresh = await fetchThread(match.clients.gmail_refresh_token, match.gmail_thread_id);
          if (fresh && fresh.length > messagesOut.length) {
            // Insert any new messages we don't have yet (idempotent on gmail_message_id unique constraint)
            const customerEmail = (match.clients.gmail_email || '').toLowerCase();
            const known = new Set(messagesOut.map(m => m.gmail_message_id).filter(Boolean));
            for (const msg of fresh) {
              if (known.has(msg.gmail_message_id)) continue;
              const fromLower = (msg.from || '').toLowerCase();
              const isOutbound = customerEmail && fromLower.includes(customerEmail);
              try {
                await supabase.from('match_thread_messages').insert({
                  match_id:          matchId,
                  gmail_message_id:  msg.gmail_message_id,
                  gmail_thread_id:   msg.gmail_thread_id,
                  direction:         isOutbound ? 'outbound' : 'inbound',
                  message_type:      isOutbound ? 'customer_reply' : 'host_reply',
                  from_email:        msg.from || null,
                  to_email:          msg.to || null,
                  subject:           msg.subject || null,
                  body_text:         msg.body_text,
                  body_html:         msg.body_html,
                  rfc822_message_id: msg.rfc822_message_id,
                  in_reply_to:       msg.in_reply_to,
                  sent_at:           msg.date_ms ? new Date(msg.date_ms).toISOString() : null,
                  detected_at:       isOutbound ? null : new Date().toISOString(),
                });
              } catch { /* ignore duplicates */ }
            }
            // Re-pull
            const { data: refreshed } = await supabase
              .from('match_thread_messages')
              .select('*')
              .eq('match_id', matchId)
              .order('sent_at', { ascending: true });
            messagesOut = refreshed || messagesOut;
          }
        } catch (syncErr) {
          logger.warn('thread sync on view failed (non-fatal)', { matchId, error: syncErr.message });
        }
      }
    }

    res.json({
      ok: true,
      match: {
        id:                  match.id,
        status:              match.status,
        gmail_thread_id:     match.gmail_thread_id,
        message_count:       match.message_count || messagesOut.length,
        unread_inbound_count: match.unread_inbound_count || 0,
        host_name:           match.podcasts?.host_name || null,
        host_email:          match.podcasts?.contact_email || null,
        podcast_title:       match.podcasts?.title || null,
      },
      messages: messagesOut,
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
      .select('id, client_id, gmail_thread_id, gmail_pitch_message_id, message_count, podcasts(contact_email, title), clients(gmail_refresh_token)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();
    if (mErr || !match) return res.status(404).json({ ok: false, error: 'match_not_found' });
    if (!match.clients?.gmail_refresh_token) return res.status(400).json({ ok: false, error: 'gmail_not_connected' });
    if (!match.gmail_thread_id) return res.status(400).json({ ok: false, error: 'no_thread_to_reply_to' });
    const to = match.podcasts?.contact_email;
    if (!to?.includes('@')) return res.status(400).json({ ok: false, error: 'no_host_email' });

    // Find the latest message in the thread to use its Message-ID for In-Reply-To
    const { data: latestRow } = await supabase
      .from('match_thread_messages')
      .select('rfc822_message_id, subject, gmail_message_id')
      .eq('match_id', matchId)
      .order('sent_at', { ascending: false })
      .limit(1)
      .single();

    let inReplyTo = latestRow?.rfc822_message_id || null;
    if (!inReplyTo && latestRow?.gmail_message_id) {
      const meta = await getMessageMetadata(match.clients.gmail_refresh_token, latestRow.gmail_message_id);
      inReplyTo = meta?.rfc822MessageId || null;
    }

    const finalSubject = (subject && subject.trim())
      || (latestRow?.subject ? (latestRow.subject.startsWith('Re:') ? latestRow.subject : `Re: ${latestRow.subject}`) : `Re: ${match.podcasts?.title || ''}`);

    const sentMsg = await sendThreadedReply({
      refreshToken: match.clients.gmail_refresh_token,
      to,
      subject: finalSubject,
      body,
      threadId: match.gmail_thread_id,
      inReplyTo: inReplyTo || undefined,
    });

    // Persist the outbound reply in the thread ledger
    if (sentMsg?.id) {
      const meta = await getMessageMetadata(match.clients.gmail_refresh_token, sentMsg.id);
      try {
        await supabase.from('match_thread_messages').insert({
          match_id:          matchId,
          gmail_message_id:  sentMsg.id,
          gmail_thread_id:   sentMsg.threadId || match.gmail_thread_id,
          direction:         'outbound',
          message_type:      'customer_reply',
          from_email:        meta?.from || null,
          to_email:          to,
          subject:           finalSubject,
          body_text:         body,
          rfc822_message_id: meta?.rfc822MessageId || null,
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

    logger.info('Manual reply sent', { matchId, to });
    res.json({ ok: true, message_id: sentMsg?.id, credits_balance: charge.balance });
  } catch (err) {
    logger.error('POST /api/reply error', { matchId, error: err.message });
    res.status(500).json({ ok: false, error: 'send_failed', message: err.message });
  }
});

// ── POST /api/draft-reply/:matchId ───────────────────────────────────────
// Phase C: Claude reads the FULL thread + customer profile and drafts a reply
// that responds to the latest inbound message. Charges 1 credit per draft.
router.post('/draft-reply/:matchId', async (req, res) => {
  const { matchId } = req.params;
  if (!matchId) return res.status(400).json({ ok: false, error: 'matchId_required' });

  const charge = await chargeCredits(req.clientId, 'ai_draft_reply', { matchId });
  if (!charge.ok) {
    if (charge.error === 'insufficient_credits') {
      return res.status(402).json({ ok: false, error: 'insufficient_credits', balance: charge.balance, needed: charge.needed });
    }
    return res.status(500).json({ ok: false, error: 'credit_charge_failed' });
  }

  try {
    const { data: match, error: mErr } = await supabase
      .from('podcast_matches')
      .select('id, client_id, podcasts(title, host_name), clients(name, business_name, bio_short, speaking_angles)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();
    if (mErr || !match) return res.status(404).json({ ok: false, error: 'match_not_found' });

    const { data: messages } = await supabase
      .from('match_thread_messages')
      .select('direction, message_type, from_email, subject, body_text, sent_at')
      .eq('match_id', matchId)
      .order('sent_at', { ascending: true });

    const thread = (messages || []).map(m => {
      const who = m.direction === 'outbound' ? 'YOU' : 'HOST';
      const when = m.sent_at ? new Date(m.sent_at).toLocaleString() : 'unknown time';
      return `[${who} · ${when}]\nSubject: ${m.subject || '(no subject)'}\n${(m.body_text || '').trim()}\n`;
    }).join('\n---\n');

    const client  = match.clients  || {};
    const podcast = match.podcasts || {};
    const firstName = (client.name || '').split(' ')[0] || 'me';
    const angles = Array.isArray(client.speaking_angles) ? client.speaking_angles.join(', ') : (client.speaking_angles || '');

    const prompt = `You are drafting the next reply in an email conversation between a podcast guest pitcher (the customer) and a podcast host.

CUSTOMER PROFILE
Name: ${client.name || 'unknown'}
Business: ${client.business_name || 'not specified'}
One-liner: ${(client.bio_short || '').slice(0, 250)}
Speaking angles: ${angles.slice(0, 400)}

PODCAST + HOST
Show: ${podcast.title || 'unknown'}
Host: ${podcast.host_name || 'the host'}

FULL THREAD (oldest at top, latest at bottom):
${thread || '(no thread captured yet)'}

TASK
Draft the next reply FROM the customer TO the host. Respond directly to the most recent host message.
Rules:
- 60 to 130 words. Concise.
- Match the energy of the last host message (warm if they were warm, professional if formal).
- Reference one specific thing the host said (book the recording, answer their question, confirm a time, etc.)
- If the host asked to schedule, propose a few specific times next week.
- Sign off with first name only: ${firstName}
- No em-dashes anywhere. Use commas, periods, or hyphens.
- Plain text only. No markdown, no signatures, no quoted text.

Output the reply BODY only. No subject line. No preamble. Just the email body.`;

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    const body = (msg.content?.[0]?.text || '').trim();

    logger.info('AI draft-reply generated', { matchId, length: body.length });
    res.json({ ok: true, body, credits_balance: charge.balance });
  } catch (err) {
    logger.error('draft-reply error', { matchId, error: err.message });
    res.status(500).json({ ok: false, error: 'draft_failed', message: err.message });
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
