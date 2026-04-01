'use strict';

const { getClient } = require('../lib/anthropic');
const { getScoringPrompt } = require('../prompts/scoring.prompt');
const logger = require('../lib/logger');

const MODEL = 'claude-sonnet-4-20250514';

/**
 * Calculate the composite fit_score as a weighted sum of individual dimension scores.
 * Weights:
 *   relevance      30%
 *   audience       25%
 *   recency        15%
 *   guest_quality  10%
 *   reach          10%
 *   contactability  5%
 *   brand           5%
 */
function calculateFitScore(scores) {
  const {
    relevance_score    = 0,
    audience_score     = 0,
    recency_score      = 0,
    guest_quality_score = 0,
    reach_score        = 0,
    contactability_score = 0,
    brand_score        = 0,
  } = scores;

  const fit =
    relevance_score       * 0.30 +
    audience_score        * 0.25 +
    recency_score         * 0.15 +
    guest_quality_score   * 0.10 +
    reach_score           * 0.10 +
    contactability_score  * 0.05 +
    brand_score           * 0.05;

  return Math.round(fit);
}

/**
 * scorePodcast(podcast, client)
 * Calls Claude to score the podcast against the client profile.
 * Returns the full scoring object including the calculated fit_score.
 * Returns a null-scored object on failure rather than throwing.
 */
async function scorePodcast(podcast, client) {
  logger.debug('Scoring podcast', { podcastTitle: podcast.title, clientId: client.id });

  const userMessage = JSON.stringify({ podcast, client });

  try {
    const message = await getClient().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: getScoringPrompt(),
      messages: [{ role: 'user', content: userMessage }],
    });

    const rawText = message.content?.[0]?.text || '';

    // Strip any accidental markdown code fences
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    let scores;
    try {
      scores = JSON.parse(cleaned);
    } catch (parseErr) {
      logger.error('Failed to parse scoring JSON', {
        podcastTitle: podcast.title,
        parseError: parseErr.message,
        rawText: rawText.slice(0, 500),
      });
      // Return a zeroed-out scoring object so the pipeline can continue
      return {
        relevance_score:       0,
        audience_score:        0,
        recency_score:         0,
        guest_quality_score:   0,
        reach_score:           0,
        contactability_score:  0,
        brand_score:           0,
        fit_score:             0,
        show_summary:          'Scoring failed — parse error.',
        why_this_client_fits:  '',
        best_pitch_angle:      '',
        episode_to_reference:  'none identified',
        red_flags:             'Scoring parse failure',
        booking_likelihood:    'low',
      };
    }

    const fit_score = calculateFitScore(scores);

    return { ...scores, fit_score };
  } catch (err) {
    logger.error('Claude scoring API call failed', {
      podcastTitle: podcast.title,
      error: err.message,
    });

    return {
      relevance_score:       0,
      audience_score:        0,
      recency_score:         0,
      guest_quality_score:   0,
      reach_score:           0,
      contactability_score:  0,
      brand_score:           0,
      fit_score:             0,
      show_summary:          'Scoring unavailable.',
      why_this_client_fits:  '',
      best_pitch_angle:      '',
      episode_to_reference:  'none identified',
      red_flags:             `API error: ${err.message}`,
      booking_likelihood:    'low',
    };
  }
}

module.exports = { scorePodcast };
