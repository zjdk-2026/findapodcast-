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
const { createDraft, sendDraft } = require('./gmailService');
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
    .select('*, podcasts(*), clients(id, name, email, bio_short, business_name, gmail_refresh_token)')
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
      const draftId = await createDraft(client.gmail_refresh_token, podcast.contact_email, subject, body).catch(() => null);
      if (!draftId) { failed++; continue; }

      const sentMsg = await sendDraft(client.gmail_refresh_token, draftId).catch(() => null);
      if (!sentMsg) { failed++; continue; }

      await supabase.from('podcast_matches')
        .update({ follow_up_sent: true, status: 'followed_up' })
        .eq('id', match.id);

      sent++;
      logger.info('followup sweep: sent', { matchId: match.id, hostEmail: podcast.contact_email });
    } catch (err) {
      failed++;
      logger.warn('followup sweep: send failed', { matchId: match.id, error: err.message });
    }
  }

  logger.info('Daily follow-up sweep: complete', { sent, skippedCredits, skippedNoEmail, failed, total: eligible.length });
  return { sent, skippedCredits, skippedNoEmail, failed };
}

module.exports = { runFollowupSweep, generateFollowUpBody };
