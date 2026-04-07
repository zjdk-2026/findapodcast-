'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const supabase  = require('../lib/supabase');
const logger    = require('../lib/logger');
const { createDraft } = require('./gmailService');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FOLLOW_UP_DAYS = 7;

/**
 * sendFollowUps(client)
 * Find all matches for this client that were sent 7+ days ago with no follow-up,
 * generate a short follow-up email via Claude, save as Gmail draft, and mark the match.
 */
async function sendFollowUps(client) {
  logger.info('Running follow-up job', { clientId: client.id, clientName: client.name });

  const cutoff = new Date(Date.now() - FOLLOW_UP_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Find eligible matches: sent > 7 days ago, no follow-up yet
  const { data: matches, error } = await supabase
    .from('podcast_matches')
    .select('*, podcasts(title, contact_email)')
    .eq('client_id', client.id)
    .eq('status', 'sent')
    .lte('sent_at', cutoff)
    .is('follow_up_sent_at', null);

  if (error) {
    logger.error('Follow-up: failed to fetch eligible matches', {
      clientId: client.id,
      error: error.message,
    });
    return;
  }

  if (!matches || matches.length === 0) {
    logger.info('Follow-up: no eligible matches', { clientId: client.id });
    return;
  }

  logger.info('Follow-up: processing matches', { clientId: client.id, count: matches.length });

  for (const match of matches) {
    try {
      const podcastName  = match.podcasts?.title || 'the podcast';
      const contactEmail = match.podcasts?.contact_email;
      const origSubject  = match.email_subject_edited || match.email_subject || '';

      // Generate follow-up via Claude
      const message = await anthropic.messages.create({
        model:      'claude-opus-4-5',
        max_tokens: 300,
        system:     `You are a podcast pitch follow-up writer. The initial pitch has already been sent. Write a short second-touch email that re-opens the conversation without being needy or repeating the original pitch verbatim.

Rules:
- Body: 60–80 words max. Short is powerful here.
- Do NOT open with "Just wanted to follow up" or "Checking in" — these are ignored by hosts
- Open with a confident re-entry: acknowledge they're busy, then immediately pivot back to value
- Remind them of one specific reason the episode idea fits their audience — use the podcast name naturally
- Close with: "Even a 15-minute call works — happy to be flexible."
- Add a one-sentence P.S. that names a result, credential, or offers to send talking points
- Tone: warm, peer-level, slightly bolder than the first email. Not apologetic. Not pushy.
- Subject line: use "Re: [original_subject]" format — highest open rates on follow-ups
- No bullet points. No exclamation marks. No em dashes. First person only.

Return ONLY valid JSON: {"subject": "Re: [original_subject]", "body": "..."}`,
        messages: [{
          role:    'user',
          content: JSON.stringify({
            original_subject: origSubject,
            podcast_name:     podcastName,
            sender_name:      client.name,
          }),
        }],
      });

      let parsed;
      try {
        const raw = message.content[0].text;
        // Handle possible markdown code fences
        const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
        parsed = JSON.parse(jsonStr);
      } catch (parseErr) {
        logger.warn('Follow-up: failed to parse Claude response', {
          matchId: match.id,
          error:   parseErr.message,
        });
        continue;
      }

      // Save as Gmail draft if possible
      if (client.gmail_refresh_token && contactEmail?.includes('@')) {
        try {
          await createDraft(
            client.gmail_refresh_token,
            contactEmail,
            parsed.subject,
            parsed.body
          );
          logger.info('Follow-up draft created', { matchId: match.id, to: contactEmail });
        } catch (draftErr) {
          logger.warn('Follow-up: Gmail draft failed', {
            matchId: match.id,
            error:   draftErr.message,
          });
        }
      }

      // Mark follow_up_sent_at
      await supabase
        .from('podcast_matches')
        .update({ follow_up_sent_at: new Date().toISOString() })
        .eq('id', match.id);

      logger.info('Follow-up processed', { matchId: match.id });
    } catch (innerErr) {
      logger.error('Follow-up: error processing match', {
        matchId: match.id,
        error:   innerErr.message,
      });
    }
  }

  logger.info('Follow-up job complete', { clientId: client.id, processed: matches.length });
}

module.exports = { sendFollowUps };
