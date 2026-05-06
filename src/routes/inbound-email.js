'use strict';

/**
 * Inbound email webhook — receives Resend inbound email events.
 *
 * Resend sends a POST to /api/inbound-email with JSON body containing:
 *   { from, to, subject, text, html, headers, attachments, ... }
 *
 * We look up the corresponding podcast_match by:
 *   1. Checking In-Reply-To / References headers against match_thread_messages.rfc822_message_id
 *   2. Falling back to searching by sender email for recent matches
 *
 * Then we store the inbound message and update the match.
 */

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

const router = express.Router();

// Simple HTML-to-text stripper for inbound email body fallback
function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

router.post('/inbound-email', async (req, res) => {
  const payload = req.body;

  // Immediately ACK to Resend so they don't retry
  try {
    if (!payload) {
      logger.warn('Inbound webhook: empty payload');
      return res.status(200).json({ ok: true });
    }

    const fromEmail   = payload.from   || '';
    const toEmail     = payload.to     || '';
    const subject     = payload.subject || '';
    const bodyText    = payload.text   || payload.body_plain || stripHtml(payload.html) || '';
    const bodyHtml    = payload.html   || '';
    const rawHeaders  = payload.headers || {};

    // Extract Message-ID, In-Reply-To, References from headers
    const messageId     = rawHeaders['Message-ID'] || rawHeaders['message-id'] || null;
    const inReplyTo     = rawHeaders['In-Reply-To'] || rawHeaders['in-reply-to'] || null;
    const references    = rawHeaders['References'] || rawHeaders['references'] || null;

    logger.info('Inbound email received', {
      from: fromEmail,
      to: toEmail,
      subject,
      messageId,
      inReplyTo,
    });

    // ── Strategy 1: Look up by In-Reply-To or References ───────────────
    let matchId = null;
    let gmailThreadId = null;

    // Check In-Reply-To against stored rfc822_message_id
    if (inReplyTo) {
      const refIds = [inReplyTo];
      if (references) {
        // References can contain multiple Message-IDs separated by spaces
        refIds.push(...references.split(/\s+/).filter(Boolean));
      }

      for (const refId of refIds) {
        const cleanRef = refId.replace(/^</, '').replace(/>$/, '');
        const { data: msgRows } = await supabase
          .from('match_thread_messages')
          .select('match_id, gmail_thread_id')
          .eq('rfc822_message_id', cleanRef)
          .limit(1);

        if (msgRows && msgRows.length > 0) {
          matchId = msgRows[0].match_id;
          gmailThreadId = msgRows[0].gmail_thread_id;
          logger.info('Inbound: matched by rfc822_message_id', { matchId, refId: cleanRef });
          break;
        }
      }
    }

    // ── Strategy 2: Look up by gmail_thread_id (legacy / renamed later) ─
    if (!matchId && gmailThreadId) {
      const { data: matchRows } = await supabase
        .from('podcast_matches')
        .select('id')
        .eq('gmail_thread_id', gmailThreadId)
        .limit(1);

      if (matchRows && matchRows.length > 0) {
        matchId = matchRows[0].id;
        logger.info('Inbound: matched by gmail_thread_id', { matchId, gmailThreadId });
      }
    }

    // ── Strategy 3: Look up by sender email ────────────────────────────
    if (!matchId) {
      // Try to find matches where we recently sent to this sender
      const senderEmail = fromEmail.replace(/^.*<([^>]+)>.*$/, '$1').trim().toLowerCase();
      if (senderEmail.includes('@')) {
        const { data: recentMsgs } = await supabase
          .from('match_thread_messages')
          .select('match_id')
          .eq('direction', 'outbound')
          .ilike('to_email', senderEmail)
          .order('sent_at', { ascending: false })
          .limit(1);

        if (recentMsgs && recentMsgs.length > 0) {
          matchId = recentMsgs[0].match_id;
          logger.info('Inbound: matched by sender email', { matchId, senderEmail });
        }
      }
    }

    // If we still can't find a match, log and accept (don't error — Resend would retry)
    if (!matchId) {
      logger.warn('Inbound: no matching match found', { from: fromEmail, subject, inReplyTo });
      return res.status(200).json({ ok: true, matched: false });
    }

    // ── Insert inbound message into match_thread_messages ──────────────
    try {
      await supabase.from('match_thread_messages').insert({
        match_id:          matchId,
        direction:         'inbound',
        message_type:      'host_reply',
        from_email:        fromEmail,
        to_email:          toEmail,
        subject:           subject,
        body_text:         bodyText || null,
        body_html:         bodyHtml || null,
        message_id:        messageId,
        in_reply_to:       inReplyTo,
        references:        references,
        sent_at:           new Date().toISOString(),
        detected_at:       new Date().toISOString(),
      });

      logger.info('Inbound: message stored in match_thread_messages', { matchId });
    } catch (insertErr) {
      // Duplicate or table issue — non-fatal
      logger.warn('Inbound: insert into match_thread_messages failed', {
        matchId,
        error: insertErr.message,
      });
    }

    // ── Update podcast_matches ────────────────────────────────────────
    try {
      await supabase.rpc('increment_match_reply', { p_match_id: matchId }).catch(async () => {
        // Fallback: manual update if RPC doesn't exist
        const { data: match } = await supabase
          .from('podcast_matches')
          .select('reply_count, status')
          .eq('id', matchId)
          .single();

        const newReplyCount = (match?.reply_count || 0) + 1;
        let newStatus = match?.status || 'sent';

        // Only advance status if it's not already further along
        const order = ['new', 'approved', 'sent', 'followed_up', 'replied', 'booked', 'appeared'];
        const currentIdx = order.indexOf(newStatus);
        const repliedIdx = order.indexOf('replied');
        if (currentIdx < repliedIdx) {
          newStatus = 'replied';
        }

        await supabase.from('podcast_matches').update({
          reply_count:       newReplyCount,
          last_reply_at:     new Date().toISOString(),
          last_message_at:   new Date().toISOString(),
          message_count:     supabase.rpc ? undefined : undefined, // handled below
          status:            newStatus,
          unread_inbound_count: supabase.raw('COALESCE(unread_inbound_count, 0) + 1'),
        }).eq('id', matchId);
      });

      // Also try to increment unread count and message_count with raw SQL approach
      await supabase.from('podcast_matches').update({
        unread_inbound_count: supabase.raw('COALESCE(unread_inbound_count, 0) + 1'),
        last_reply_at:        new Date().toISOString(),
        last_message_at:      new Date().toISOString(),
        status:               supabase.raw(`CASE WHEN status IN ('new','approved','sent','followed_up') THEN 'replied' ELSE status END`),
      }).eq('id', matchId);

      logger.info('Inbound: podcast_match updated', { matchId });
    } catch (updateErr) {
      logger.warn('Inbound: update podcast_matches failed', {
        matchId,
        error: updateErr.message,
      });
    }

    return res.status(200).json({ ok: true, matched: true, matchId });
  } catch (err) {
    logger.error('Inbound email webhook error', {
      error: err.message,
      payload: req.body ? Object.keys(req.body).join(',') : 'empty',
    });
    // Always return 200 so Resend doesn't retry
    return res.status(200).json({ ok: true, error: err.message });
  }
});

module.exports = router;
