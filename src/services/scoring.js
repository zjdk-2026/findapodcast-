'use strict';

const { getClient } = require('../lib/anthropic');
const { getScoringPrompt } = require('../prompts/scoring.prompt');
const logger = require('../lib/logger');

const MODEL = 'claude-sonnet-4-6';

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

  // Send only the fields Claude needs — trimmed client and podcast objects
  const podcastForScoring = {
    title:            podcast.title,
    description:      podcast.description,
    host_name:        podcast.host_name,
    category:         podcast.category,
    niche_tags:       podcast.niche_tags,
    total_episodes:   podcast.total_episodes,
    last_episode_date: podcast.last_episode_date,
    listen_score:     podcast.listen_score,
    has_guest_history: podcast.has_guest_history,
    website:          podcast.website,
    contact_email:    podcast.contact_email,
    booking_page_url: podcast.booking_page_url,
    guest_application_url: podcast.guest_application_url,
    youtube_subscribers: podcast.youtube_subscribers,
    instagram_url:    podcast.instagram_url,
    twitter_url:      podcast.twitter_url,
    country:          podcast.country,
    language:         podcast.language,
  };

  const clientForScoring = {
    name:             client.name,
    title:            client.title,
    business_name:    client.business_name,
    bio_short:        client.bio_short,
    topics:           client.topics,
    speaking_angles:  client.speaking_angles,
    target_audience:  client.target_audience,
    preferred_tone:   client.preferred_tone,
    avoid_industries: client.avoid_industries,
    avoid_topics:     client.avoid_topics,
    pitch_style:      client.pitch_style,
  };

  const userMessage = JSON.stringify({ podcast: podcastForScoring, client: clientForScoring });

  // Neutral fallback — used when scoring fails. Saves the podcast in the pipeline
  // at a mid-range score rather than 0/100 which would make it appear as a bad match.
  const neutralFallback = {
    relevance_score:       50,
    audience_score:        50,
    recency_score:         50,
    guest_quality_score:   50,
    reach_score:           50,
    contactability_score:  50,
    brand_score:           50,
    fit_score:             50,
    show_summary:          'Score pending review.',
    why_this_client_fits:  '',
    best_pitch_angle:      '',
    episode_to_reference:  'none identified',
    red_flags:             'none',
    booking_likelihood:    'medium',
  };

  try {
    const message = await getClient().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: getScoringPrompt(),
      messages: [{ role: 'user', content: userMessage }],
    });

    const rawText = message.content?.[0]?.text || '';
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    let scores;
    try {
      scores = JSON.parse(cleaned);
    } catch (parseErr) {
      logger.error('Failed to parse scoring JSON', { podcastTitle: podcast.title, parseError: parseErr.message });
      return neutralFallback;
    }

    // Clamp all scores to 0-100 in case Claude returns out-of-range values
    const clamp = (v) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
    const clamped = {
      ...scores,
      relevance_score:      clamp(scores.relevance_score),
      audience_score:       clamp(scores.audience_score),
      recency_score:        clamp(scores.recency_score),
      guest_quality_score:  clamp(scores.guest_quality_score),
      reach_score:          clamp(scores.reach_score),
      contactability_score: clamp(scores.contactability_score),
      brand_score:          clamp(scores.brand_score),
    };

    const fit_score = calculateFitScore(clamped);
    return { ...clamped, fit_score };

  } catch (err) {
    logger.error('Claude scoring API call failed', { podcastTitle: podcast.title, error: err.message });
    return neutralFallback;
  }
}

module.exports = { scorePodcast };
