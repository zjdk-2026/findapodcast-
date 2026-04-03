'use strict';

const express    = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const supabase   = require('../lib/supabase');
const logger     = require('../lib/logger');
const { writeEmail }            = require('../services/emailWriter');
const requireDashboardToken     = require('../middleware/requireDashboardToken');

const router = express.Router();

/**
 * POST /api/generate-pitch
 * Regenerates the pitch email for a given match and saves it back to the DB.
 */
router.post('/generate-pitch', requireDashboardToken, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data: match, error: fetchError } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(*), clients(*)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (fetchError || !match) {
      return res.status(404).json({ success: false, error: 'Match not found.' });
    }

    const email = await writeEmail(match.clients, match, match.podcasts);

    const { error: updateError } = await supabase
      .from('podcast_matches')
      .update({ email_subject: email.subject, email_body: email.body })
      .eq('id', matchId);

    if (updateError) {
      logger.error('Failed to save regenerated pitch', { matchId, error: updateError.message });
      return res.status(500).json({ success: false, error: 'Failed to save pitch.' });
    }

    logger.info('Pitch regenerated', { matchId });
    return res.json({ success: true, subject: email.subject, body: email.body });
  } catch (err) {
    logger.error('generate-pitch route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/interview-prep
 * Generates an interview prep briefing for a given match and saves it to the DB.
 */
router.post('/interview-prep', requireDashboardToken, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data: match, error: fetchError } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(*), clients(*)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (fetchError || !match) {
      return res.status(404).json({ success: false, error: 'Match not found.' });
    }

    const podcast = match.podcasts;
    const client  = match.clients;

    const prompt =
      'You are an expert podcast interview coach. Given this podcast and guest profile, create a concise interview prep briefing. ' +
      'Format as JSON with these fields: host_background (2 sentences), show_format (1 sentence), suggested_topics (array of 4 strings), ' +
      'likely_questions (array of 4 strings), talking_points (array of 3 strings), one_thing_to_avoid (1 sentence). ' +
      `Podcast: ${podcast.title}, ${podcast.category}, ${podcast.description}. ` +
      `Guest: ${client.name}, ${client.business}, ${client.topics}, ${client.bio}.`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model:      'claude-3-5-haiku-20241022',
      max_tokens: 1000,
      messages:   [{ role: 'user', content: prompt }],
    });

    const rawText = message.content?.[0]?.text || '';
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    let prep;
    try {
      prep = JSON.parse(cleaned);
    } catch (parseErr) {
      logger.error('Failed to parse interview prep JSON', { matchId, error: parseErr.message });
      return res.status(500).json({ success: false, error: 'Failed to parse interview prep response.' });
    }

    try {
      await supabase
        .from('podcast_matches')
        .update({ interview_prep: JSON.stringify(prep) })
        .eq('id', matchId);
    } catch (saveErr) {
      logger.warn('Could not save interview_prep (column may not exist)', { matchId, error: saveErr.message });
    }

    logger.info('Interview prep generated', { matchId });
    return res.json({ success: true, prep });
  } catch (err) {
    logger.error('interview-prep route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
