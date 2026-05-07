'use strict';

/**
 * 7-day automatic follow-up sweep.
 * Fires daily at 7am UTC from scheduler.js.
 *
 * Picks up matches in 'sent' status whose sent_at is 6.5–7.5 days ago,
 * skipping any with status='replied' (host already responded) or follow_up_sent=true.
 *
 * For each eligible match:
 *   1. Checks the client's saved default 'followup' template — if found, uses
 *      it with {host_name}, {podcast_title}, {client_name} etc. substitution.
 *   2. If no saved template, generates a personalised follow-up via Claude.
 *   3. If Claude fails, uses a clean hardcoded fallback.
 *   4. Charges 1 credit (skips silently if customer is out of credits).
 *   5. Sends via Resend with In-Reply-To headers for proper threading.
 *   6. Marks follow_up_sent = true, status = 'followed_up'.
 */

const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const { sendEmail } = require('./resendMailService');
const { chargeCredits } = require('../lib/credits');
const { getClient: getAnthropicClient } = require('../lib/anthropic');

// ── Placeholder substitution ────────────────────────────────────────────
function replacePlaceholders(str, vars) {
  return (str || '').replace(/\{(\w+)\}/gi, (_, key) => {
    const k = key.toLowerCase();
    return vars[k] !== undefined && vars[k] !== null ? vars[k] : `{${key}}`;
  });
}

// ── Template lookup ─────────────────────────────────────────────────────
async function getFollowUpTemplate(clientId) {
  try {
    // Prefer the default, fall back to most-recently-used
    const { data: templates } = await supabase
      .from('email_templates')
      .select('*')
      .eq('client_id', clientId)
      .eq('type', 'followup')
      .order('is_default', { ascending: false })
      .order('use_count', { ascending: false })
      .limit(1);

    if (templates && templates.length > 0) {
      return templates[0];
    }
  } catch (err) {
    logger.warn('followup-sweep: template lookup failed', { clientId, error: err.message });
  }
  return null;
}

// ── Body resolution: template > AI > hardcoded fallback ────────────────
async function resolveFollowUpBody({ client, podcast, match }) {
  const clientName    = (client.name || '').trim();
  const firstName     = clientName.split(' ')[0] || clientName;
  const hostName      = (podcast.host_name || 'there').trim();
  const podcastTitle  = (podcast.title || 'your show').trim();
  const angle         = (match.best_pitch_angle || match.email_subject_edited || match.email_subject || '').trim();
  const originalSubject = (match.email_subject_edited || match.email_subject || '').trim();
  const replySubject  = originalSubject ? `Re: ${originalSubject}` : `Following up — ${podcastTitle}`;

  // 1. Try saved template
  const tpl = await getFollowUpTemplate(match.client_id || client.id);
  if (tpl && tpl.subject && tpl.body) {
    const vars = {
      host_name:           hostName,
      host_first_name:     hostName.split(' ')[0] || hostName,
      podcast_title:       podcastTitle,
      client_name:         clientName,
      client_first_name:   firstName,
      one_liner:           client.bio_short || '',
      credential:          client.bio_short || '',
      business_name:       client.business_name || '',
    };

    // Increment template use count
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

  // 2. Claude AI generation (fast path if no Anthropic key)
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
      source: 'fallback',
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

    // 3. If the AI returns something meaningful, use it
    if (body.length > 20) {
      return { subject: replySubject, body, source: 'ai' };
    }
  } catch (err) {
    logger.warn('followup-sweep: Claude generation failed, using fallback', { matchId: match.id, error: err.message });
  }

  // 3. Hardcoded fallback (clean, short, human)
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
    source: 'fallback',
  };
}

// ── Main sweep ─────────────────────────────────────────────────────────
async function runFollowupSweep() {
  logger.info('Daily follow-up sweep: starting');

  const now = new Date();
  const minAge = new Date(now.getTime() - 7.5 * 24 * 60 * 60 * 1000);
  const maxAge = new Date(now.getTime() - 6.5 * 24 * 60 * 60 * 1000);

  const { data: matches, error } = await supabase
    .from('podcast_matches')
    .select('id, client_id, status, sent_at, follow_up_sent, email_subject, email_subject_edited, best_pitch_angle, message_count, podcasts(id, title, host_name, contact_email), clients(id, name, email, bio_short, business_name)')
    .eq('status', 'sent')
    .gte('sent_at', minAge.toISOString())
    .lte('sent_at', maxAge.toISOString());

  if (error) {
    logger.error('Daily follow-up sweep: fetch error', { error: error.message });
    return;
  }

  const eligible = (matches || []).filter(m => !m.follow_up_sent);
  logger.info('Daily follow-up sweep: eligible matches', { count: eligible.length });

  let sent = 0;
  let skippedCredits = 0;
  let skippedNoEmail = 0;
  let failed = 0;

  for (const match of eligible) {
    const client = match.clients || {};
    const podcast = match.podcasts || {};

    if (!podcast.contact_email?.includes('@')) {
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
      const { subject, body, source } = await resolveFollowUpBody({ client, podcast, match });
      logger.info('followup sweep: body resolved', { matchId: match.id, source });

      // Look up the most recent outbound message's RFC-822 Message-ID for threading
      let inReplyTo = null;
      let references = null;
      const { data: latestMsg } = await supabase
        .from('match_thread_messages')
        .select('rfc822_message_id')
        .eq('match_id', match.id)
        .eq('direction', 'outbound')
        .not('rfc822_message_id', 'is', null)
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestMsg?.rfc822_message_id) {
        inReplyTo = latestMsg.rfc822_message_id;
        references = latestMsg.rfc822_message_id;
      }

      // Send via Resend with threading headers
      const sentResult = await sendEmail({
        to: podcast.contact_email,
        subject,
        body,
        inReplyTo: inReplyTo || undefined,
        references: references || undefined,
      });

      if (!sentResult?.id) {
        failed++;
        logger.warn('followup sweep: send returned no id', { matchId: match.id });
        continue;
      }

      // Persist the follow-up message in the thread ledger
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
          in_reply_to:       inReplyTo || null,
          sent_at:           new Date().toISOString(),
        });
      } catch (logErr) {
        logger.warn('followup sweep: thread message insert failed', { matchId: match.id, error: logErr.message });
      }

      // Update match metadata
      await supabase.from('podcast_matches')
        .update({
          follow_up_sent:            true,
          status:                    'followed_up',
          gmail_followup_message_id: sentResult.id || null,
          last_message_at:           new Date().toISOString(),
          message_count:             (match.message_count || 0) + 1,
        })
        .eq('id', match.id);

      sent++;
      logger.info('followup sweep: sent via Resend', { matchId: match.id, hostEmail: podcast.contact_email, source });
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
  <p style="font-size:12.5px;margin:24px 0 0;color:#6b7280;">Tip: use your saved Follow-up template in Settings to control the exact copy that fires. Templates beat auto-generated every time.</p>
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

module.exports = { runFollowupSweep, runFollowupHeadsUp, resolveFollowUpBody };
