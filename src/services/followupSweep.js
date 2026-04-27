'use strict';

/**
 * 7-day automatic follow-up sweep.
 * Fires daily at 7am UTC from scheduler.js.
 *
 * Picks up matches in 'sent' status whose sent_at is 6.5–7.5 days ago,
 * skipping any with status='replied' (host already responded) or follow_up_sent=true.
 *
 * For each eligible match:
 *   1. Generates a personalised, threaded follow-up via Claude haiku-4.5
 *      (References the original pitch angle, soft re-ask, "circling back" tone)
 *   2. Charges 1 credit (skips silently if customer is out of credits)
 *   3. Sends via Gmail in the SAME thread as the original pitch
 *      (uses gmail_thread_id captured at original send for proper Re: threading)
 *   4. Marks follow_up_sent = true, status = 'followed_up'
 */

const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const { createDraft, sendDraft, sendThreadedReply, getMessageMetadata } = require('./gmailService');
const { chargeCredits } = require('../lib/credits');
const { getClient: getAnthropicClient } = require('../lib/anthropic');

async function generateFollowUpBody({ client, podcast, match }) {
  const clientName    = (client.name || '').trim();
  const firstName     = clientName.split(' ')[0] || clientName;
  const hostName      = (podcast.host_name || 'there').trim();
  const podcastTitle  = (podcast.title || 'your show').trim();
  const angle         = (match.best_pitch_angle || match.email_subject_edited || match.email_subject || '').trim();
  const originalSubject = (match.email_subject_edited || match.email_subject || '').trim();
  const replySubject  = originalSubject ? `Re: ${originalSubject}` : `Following up — ${podcastTitle}`;

  // Fast path if Anthropic key isn't present — fall back to a clean-but-generic template
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      subject: replySubject,
      body: [
        `Hi ${hostName},`,
        ``,
        `Circling back on my last email — I know inboxes move fast.`,
        ``,
        angle
          ? `My angle for ${podcastTitle} would be ${angle}. I think it lands in your sweet spot based on what you've been having on the show.`
          : `I genuinely think there's a strong fit here for your audience.`,
        ``,
        `Even a 15-minute chat to see if it's worth exploring. Happy to work around your schedule.`,
        ``,
        `Thanks,`,
        firstName,
      ].join('\n'),
    };
  }

  try {
    const anthropic = getAnthropicClient();
    const prompt = `You are writing a polite, short follow-up email from a podcast guest pitching themselves to a host who didn't reply to the first email 7 days ago.

Sender: ${clientName}${client.business_name ? ` (${client.business_name})` : ''}
Sender bio: ${(client.bio_short || '').slice(0, 220)}
Host: ${hostName}
Podcast: ${podcastTitle}
Original pitch angle: ${angle || '(not specified)'}

Write a follow-up email body. Rules:
- 80 to 130 words. No fluff.
- Open with a warm "circling back" or "popping back into your inbox" type line.
- Reference the original angle in one sentence — make it feel like a continuation, not a fresh pitch.
- Soft re-ask: a 15-minute call OR a quick "is this not a fit, no worries" out.
- Sign off with first name only: ${firstName}
- No subject line in the body.
- No em-dashes anywhere. Use commas, periods, or hyphens instead.
- Plain text only. No markdown.`;

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    const body = (msg.content?.[0]?.text || '').trim();
    return { subject: replySubject, body };
  } catch (err) {
    logger.warn('followup-sweep: Claude generation failed, using fallback', { matchId: match.id, error: err.message });
    return generateFollowUpBody({ client, podcast, match: { ...match, _skipClaude: true } });
  }
}

async function runFollowupSweep() {
  logger.info('Daily follow-up sweep: starting');

  const now = new Date();
  const minAge = new Date(now.getTime() - 7.5 * 24 * 60 * 60 * 1000);
  const maxAge = new Date(now.getTime() - 6.5 * 24 * 60 * 60 * 1000);

  const { data: matches, error } = await supabase
    .from('podcast_matches')
    .select('id, client_id, status, sent_at, follow_up_sent, email_subject, email_subject_edited, best_pitch_angle, gmail_thread_id, gmail_pitch_message_id, message_count, podcasts(id, title, host_name, contact_email), clients(id, name, email, bio_short, business_name, gmail_refresh_token)')
    .eq('status', 'sent')
    .gte('sent_at', minAge.toISOString())
    .lte('sent_at', maxAge.toISOString());

  if (error) {
    logger.error('Daily follow-up sweep: fetch error', { error: error.message });
    return;
  }

  // Filter out matches that already have follow_up_sent = true
  const eligible = (matches || []).filter(m => !m.follow_up_sent);
  logger.info('Daily follow-up sweep: eligible matches', { count: eligible.length });

  let sent = 0;
  let skippedCredits = 0;
  let skippedNoEmail = 0;
  let failed = 0;

  for (const match of eligible) {
    const client = match.clients || {};
    const podcast = match.podcasts || {};

    if (!client.gmail_refresh_token || !podcast.contact_email?.includes('@')) {
      skippedNoEmail++;
      continue;
    }

    // Charge 1 credit — skip silently if customer out of credits
    const charge = await chargeCredits(match.client_id, 'followup_send', { matchId: match.id, source: 'auto_sweep' });
    if (!charge.ok) {
      skippedCredits++;
      logger.info('followup sweep: skipped (no credits)', { matchId: match.id, error: charge.error });
      continue;
    }

    try {
      const { subject, body } = await generateFollowUpBody({ client, podcast, match });

      let sentMsg = null;
      // If we captured the original Message-ID + threadId on the initial pitch, send as a proper threaded reply
      if (match.gmail_thread_id && match.gmail_pitch_message_id) {
        // Look up the original RFC-822 Message-ID from match_thread_messages (or fetch from Gmail as fallback)
        let rfcMessageId = null;
        const { data: pitchRow } = await supabase
          .from('match_thread_messages')
          .select('rfc822_message_id')
          .eq('match_id', match.id)
          .eq('direction', 'outbound')
          .eq('message_type', 'pitch')
          .limit(1)
          .single();
        rfcMessageId = pitchRow?.rfc822_message_id || null;

        if (!rfcMessageId) {
          // Fallback: fetch from Gmail directly
          const meta = await getMessageMetadata(client.gmail_refresh_token, match.gmail_pitch_message_id);
          rfcMessageId = meta?.rfc822MessageId || null;
        }

        try {
          sentMsg = await sendThreadedReply({
            refreshToken: client.gmail_refresh_token,
            to:           podcast.contact_email,
            subject,
            body,
            threadId:     match.gmail_thread_id,
            inReplyTo:    rfcMessageId || undefined,
          });
        } catch (threadErr) {
          logger.warn('followup sweep: threaded reply failed, falling back to draft+send', { matchId: match.id, error: threadErr.message });
        }
      }

      // Fallback path: no threadId stored (older matches) — send as a new email with Re: subject
      if (!sentMsg) {
        const draftId = await createDraft(client.gmail_refresh_token, podcast.contact_email, subject, body).catch(() => null);
        if (!draftId) { failed++; continue; }
        sentMsg = await sendDraft(client.gmail_refresh_token, draftId).catch(() => null);
        if (!sentMsg) { failed++; continue; }
      }

      // Persist the follow-up message in the thread ledger
      if (sentMsg?.id) {
        const meta = await getMessageMetadata(client.gmail_refresh_token, sentMsg.id);
        try {
          await supabase.from('match_thread_messages').insert({
            match_id:          match.id,
            gmail_message_id:  sentMsg.id,
            gmail_thread_id:   sentMsg.threadId || match.gmail_thread_id,
            direction:         'outbound',
            message_type:      'followup',
            from_email:        meta?.from || null,
            to_email:          podcast.contact_email,
            subject,
            body_text:         body,
            rfc822_message_id: meta?.rfc822MessageId || null,
            in_reply_to:       null,
            sent_at:           new Date().toISOString(),
          });
        } catch (logErr) {
          logger.warn('followup sweep: thread message insert failed', { matchId: match.id, error: logErr.message });
        }
      }

      await supabase.from('podcast_matches')
        .update({
          follow_up_sent:           true,
          status:                   'followed_up',
          gmail_followup_message_id: sentMsg?.id || null,
          last_message_at:          new Date().toISOString(),
          message_count:            (match.message_count || 0) + 1,
        })
        .eq('id', match.id);

      sent++;
      logger.info('followup sweep: sent', { matchId: match.id, hostEmail: podcast.contact_email, threaded: !!match.gmail_thread_id });
    } catch (err) {
      failed++;
      logger.warn('followup sweep: send failed', { matchId: match.id, error: err.message });
    }
  }

  logger.info('Daily follow-up sweep: complete', { sent, skippedCredits, skippedNoEmail, failed, total: eligible.length });
  return { sent, skippedCredits, skippedNoEmail, failed };
}

/**
 * runFollowupHeadsUp — daily 24h-before-auto-followup nudge
 *
 * Customer-control upgrade. Premium customers do NOT want their pitches
 * auto-followed-up without warning. This sweep finds matches whose 7-day
 * mark falls TOMORROW (between 5.5 and 6.5 days since sent_at) and emails
 * the customer a heads-up so they can edit/skip/send-now from the dashboard.
 *
 * One consolidated email per customer per day (groups multiple matches).
 */
async function runFollowupHeadsUp() {
  logger.info('Follow-up heads-up: starting');

  const now    = new Date();
  const minAge = new Date(now.getTime() - 6.5 * 24 * 60 * 60 * 1000);
  const maxAge = new Date(now.getTime() - 5.5 * 24 * 60 * 60 * 1000);

  const { data: matches, error } = await supabase
    .from('podcast_matches')
    .select('id, client_id, sent_at, follow_up_sent, email_subject, email_subject_edited, podcasts(title, host_name), clients(id, name, email, dashboard_token)')
    .eq('status', 'sent')
    .gte('sent_at', minAge.toISOString())
    .lte('sent_at', maxAge.toISOString());

  if (error) { logger.error('Follow-up heads-up: fetch error', { error: error.message }); return; }
  const eligible = (matches || []).filter(m => !m.follow_up_sent);
  if (eligible.length === 0) { logger.info('Follow-up heads-up: no eligible matches'); return; }

  // Group by client
  const byClient = new Map();
  for (const m of eligible) {
    const cid = m.client_id;
    if (!byClient.has(cid)) byClient.set(cid, { client: m.clients, items: [] });
    byClient.get(cid).items.push(m);
  }

  const apiKey   = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'hi@zacdeane.com';
  const baseUrl  = process.env.BASE_URL || 'https://findapodcast.io';
  let sent = 0;
  if (!apiKey) { logger.warn('Follow-up heads-up: RESEND_API_KEY missing — skipping'); return; }

  for (const { client, items } of byClient.values()) {
    if (!client?.email || !client?.dashboard_token) continue;
    const dashUrl = `${baseUrl}/dashboard/${client.dashboard_token}?tab=sent`;
    const firstName = (client.name || 'there').split(' ')[0];
    const list = items.slice(0, 8).map(m => `<li><strong>${(m.podcasts?.title || 'a podcast').replace(/[<>]/g, '')}</strong>${m.podcasts?.host_name ? ' · ' + m.podcasts.host_name.replace(/[<>]/g, '') : ''}</li>`).join('');
    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111827;line-height:1.55;">
  <h1 style="font-size:22px;font-weight:800;margin:0 0 14px;">Follow-ups firing tomorrow, ${firstName}.</h1>
  <p style="font-size:15px;margin:0 0 14px;color:#374151;">${items.length === 1 ? 'One pitch hits its 7-day mark in 24 hours' : `${items.length} pitches hit their 7-day mark in 24 hours`}. Find A Podcast will auto-send a follow-up unless you edit, skip, or send now.</p>
  <ul style="font-size:14px;margin:0 0 18px;padding-left:20px;color:#1f2937;">${list}</ul>
  <a href="${dashUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:13px 24px;border-radius:10px;font-weight:700;font-size:15px;">Review in dashboard</a>
  <p style="font-size:12.5px;margin:24px 0 0;color:#6b7280;">Tip: tweaking the follow-up subject or angle can lift reply rates 20%+. Quick edits beat the auto-send.</p>
  <p style="font-size:12px;margin:18px 0 0;color:#9ca3af;">— Find A Podcast</p>
</div>`;
    try {
      await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromEmail, to: [client.email],
          subject: `${items.length === 1 ? '1 follow-up' : items.length + ' follow-ups'} firing tomorrow`,
          html,
        }),
      });
      sent++;
    } catch (err) {
      logger.warn('Follow-up heads-up: email send failed', { clientId: client.id, error: err.message });
    }
  }
  logger.info('Follow-up heads-up: complete', { customers: byClient.size, eligible: eligible.length, sent });
  return { sent, eligible: eligible.length };
}

module.exports = { runFollowupSweep, runFollowupHeadsUp, generateFollowUpBody };
