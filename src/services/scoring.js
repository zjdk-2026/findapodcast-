'use strict';

const { getClient } = require('../lib/anthropic');
const { getScoringPrompt } = require('../prompts/scoring.prompt');
const logger = require('../lib/logger');

const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Calculate the composite fit_score as a weighted sum of individual dimension scores.
 * Weights (matching scoring.prompt.js):
 *   relevance      30%
 *   audience       25%
 *   recency        15%
 *   reach          15%
 *   accessibility  10%
 *   engagement      3%
 *   quality         2%
 */
function calculateFitScore(scores) {
  const {
    relevance_score       = 0,
    audience_score        = 0,
    recency_score         = 0,
    reach_score           = 0,
    accessibility_score   = 0,
    engagement_score      = 0,
    quality_score         = 0,
  } = scores;

  const fit =
    relevance_score      * 0.30 +
    audience_score       * 0.25 +
    recency_score        * 0.15 +
    reach_score          * 0.15 +
    accessibility_score  * 0.10 +
    engagement_score     * 0.03 +
    quality_score        * 0.02;

  return Math.round(fit);
}

/**
 * Apply server-side algorithmic overrides AFTER the LLM scores.
 * This catches cases where the LLM ignores prompt rules (which it often does).
 */
function applyAlgorithmicOverrides(scores, podcast) {
  const clamped = { ...scores };

  // ── Recency algorithmic override ──────────────────────────────────────
  if (podcast.last_episode_date) {
    const lastEp = new Date(podcast.last_episode_date);
    const now = new Date();
    const daysSince = Math.floor((now - lastEp) / (1000 * 60 * 60 * 24));

    if (daysSince > 365) {
      clamped.recency_score = 0;
    } else if (daysSince > 180) {
      clamped.recency_score = Math.min(clamped.recency_score, 15);
    } else if (daysSince > 90) {
      clamped.recency_score = Math.min(clamped.recency_score, 30);
    } else if (daysSince > 60) {
      clamped.recency_score = Math.min(clamped.recency_score, 45);
    } else if (daysSince > 30) {
      clamped.recency_score = Math.min(clamped.recency_score, 60);
    }

    // Abandoned project: <5 episodes AND >180 days old
    if ((podcast.total_episodes || 0) <= 5 && daysSince > 180) {
      clamped.recency_score = 0;
    }
  } else {
    // No last_episode_date at all
    clamped.recency_score = 0;
  }

  // ── Relevance override: dead shows have ZERO relevance ─────────────────
  if (podcast.last_episode_date) {
    const lastEp = new Date(podcast.last_episode_date);
    const now = new Date();
    const daysSince = Math.floor((now - lastEp) / (1000 * 60 * 60 * 24));

    if (daysSince > 365) {
      clamped.relevance_score = 0;
    } else if (daysSince > 180) {
      clamped.relevance_score = Math.min(clamped.relevance_score, 10);
    }
  }

  // ── Accessibility override: dead shows can't be booked ────────────────
  if (podcast.last_episode_date) {
    const lastEp = new Date(podcast.last_episode_date);
    const now = new Date();
    const daysSince = Math.floor((now - lastEp) / (1000 * 60 * 60 * 24));
    if (daysSince > 180) {
      clamped.accessibility_score = Math.min(clamped.accessibility_score, 10);
    }
  }

  // ── Reach override: small show with few episodes over long period ─────
  if ((podcast.total_episodes || 0) <= 7 && podcast.last_episode_date) {
    const lastEp = new Date(podcast.last_episode_date);
    const firstEp = podcast.first_episode_date ? new Date(podcast.first_episode_date) : null;
    if (firstEp) {
      const spanMonths = (lastEp - firstEp) / (1000 * 60 * 60 * 24 * 30);
      if (spanMonths > 24) {
        // 7 episodes over 2+ years = tiny audience
        clamped.reach_score = Math.min(clamped.reach_score, 20);
      }
    }
  }

  return clamped;
}

/**
 * scorePodcast(podcast, client)
 * Calls Claude to score the podcast against the client profile.
 * Runs algorithmic overrides on the returned scores for accuracy.
 * Returns the full scoring object including the calculated fit_score.
 * Returns a null-scored object on failure rather than throwing.
 */
async function scorePodcast(podcast, client) {
  logger.debug('Scoring podcast', { podcastTitle: podcast.title, clientId: client.id });

  // Send only the fields Claude needs — trimmed client and podcast objects
  const podcastForScoring = {
    title:                podcast.title,
    description:          podcast.description,
    host_name:            podcast.host_name,
    category:             podcast.category,
    niche_tags:           podcast.niche_tags,
    total_episodes:       podcast.total_episodes,
    last_episode_date:    podcast.last_episode_date,
    listen_score:         podcast.listen_score,
    has_guest_history:    podcast.has_guest_history,
    website:              podcast.website,
    contact_email:        podcast.contact_email,
    booking_page_url:     podcast.booking_page_url,
    guest_application_url: podcast.guest_application_url,
    youtube_subscribers:  podcast.youtube_subscribers,
    instagram_url:        podcast.instagram_url,
    twitter_url:          podcast.twitter_url,
    country:              podcast.country,
    language:             podcast.language,
  };

  const clientForScoring = {
    name:               client.name,
    title:              client.title,
    business_name:      client.business_name,
    bio_short:          client.bio_short,
    topics:             client.topics,
    speaking_angles:    client.speaking_angles,
    target_audience:    client.target_audience,
    preferred_tone:     client.preferred_tone,
    avoid_industries:   client.avoid_industries,
    avoid_topics:       client.avoid_topics,
    pitch_style:        client.pitch_style,
  };

  const userMessage = JSON.stringify({ podcast: podcastForScoring, client: clientForScoring });

  // Neutral fallback — used when scoring fails. Saves the podcast in the pipeline
  // at a mid-range score rather than 0/100 which would make it appear as a bad match.
  const neutralFallback = {
    relevance_score:       50,
    audience_score:        50,
    recency_score:         50,
    reach_score:           50,
    accessibility_score:   50,
    engagement_score:      50,
    quality_score:         50,
    fit_score:             50,
    seo_score:             50,
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
      relevance_score:      clamp(scores.relevance_score),
      audience_score:       clamp(scores.audience_score),
      recency_score:        clamp(scores.recency_score),
      reach_score:          clamp(scores.reach_score),
      accessibility_score:  clamp(scores.accessibility_score),
      engagement_score:     clamp(scores.engagement_score),
      quality_score:        clamp(scores.quality_score),
      seo_score:            clamp(scores.seo_score || 50),
      show_summary:         scores.analysis || scores.show_summary || '',
      why_this_client_fits: scores.why_this_client_fits || '',
      best_pitch_angle:     scores.best_pitch_angle || '',
      episode_to_reference: scores.episode_to_reference || 'none identified',
      red_flags:            scores.red_flags || 'none',
      booking_likelihood:   scores.booking_likelihood || 'medium',
    };

    // Apply algorithmic overrides (recency cap, accessibility cap, etc.)
    const overridden = applyAlgorithmicOverrides(clamped, podcast);

    const fit_score = calculateFitScore(overridden);
    return { ...overridden, fit_score };

  } catch (err) {
    logger.error('Claude scoring API call failed', { podcastTitle: podcast.title, error: err.message });
    return neutralFallback;
  }
}

module.exports = { scorePodcast };
