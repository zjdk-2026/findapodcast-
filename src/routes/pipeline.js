'use strict';

const express    = require('express');
const supabase   = require('../lib/supabase');
const logger     = require('../lib/logger');
const { discoverPodcasts }  = require('../services/discovery');
const { enrichPodcast }     = require('../services/enrichment');
const { scorePodcast }      = require('../services/scoring');
const { writeEmail }        = require('../services/emailWriter');
const { createDraft }       = require('../services/gmailService');
const { sendDigestEmail }   = require('../services/digestEmail');

const requireDashboardToken = require('../middleware/requireDashboardToken');
const router = express.Router();

/**
 * POST /api/run/:clientId
 * Runs the full pipeline for a single client:
 *   discover → enrich → score → save matches → write emails → create drafts → send digest
 */
router.post('/run/:clientId', requireDashboardToken, async (req, res) => {
  const clientId = req.clientId; // from middleware — verified token owner

  logger.info('Pipeline run started', { clientId });

  try {
    // ── 1. Fetch client ───────────────────────────────────────
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .single();

    if (clientError || !client) {
      logger.warn('Client not found', { clientId });
      return res.status(404).json({ success: false, error: 'Client not found.' });
    }

    if (!client.is_active) {
      return res.status(400).json({ success: false, error: 'Client is not active.' });
    }

    // ── Check monthly booking cap ─────────────────────────────
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { count: bookedThisMonth } = await supabase
      .from('podcast_matches')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .eq('status', 'booked')
      .gte('updated_at', startOfMonth.toISOString());

    const monthlyCapDefault = 10;
    const monthlyCap = client.monthly_booking_cap ?? monthlyCapDefault;

    if ((bookedThisMonth || 0) >= monthlyCap && !client.unlimited_pitching) {
      logger.info('Monthly booking cap reached — pipeline paused', { clientId, bookedThisMonth, monthlyCap });
      return res.json({
        success: true,
        matchesFound: 0,
        emailsWritten: 0,
        capReached: true,
        message: `You've booked ${bookedThisMonth} podcasts this month. Upgrade to Unlimited to keep pitching.`,
      });
    }

    // ── 2. Discovery ──────────────────────────────────────────
    logger.info('Step 1: Discovery', { clientId });
    const isManual = req.query.manual !== 'false'; // manual by default for POST runs
    const rawPodcasts = await discoverPodcasts(client, { isManual });
    logger.info('Discovery complete', { clientId, count: rawPodcasts.length });

    // Guardrail: log any run that falls short of the 50-podcast target
    if (rawPodcasts.length < 50) {
      logger.warn('GUARDRAIL: Discovery returned fewer than 50 podcasts', {
        clientId,
        found: rawPodcasts.length,
        target: 50,
      });
    }

    if (rawPodcasts.length === 0) {
      logger.warn('No podcasts discovered', { clientId });
      await updateLastRun(clientId);
      return res.json({ success: true, matchesFound: 0, emailsWritten: 0 });
    }

    // ── 3. Enrich & Score in parallel batches of 5 ───────────
    logger.info('Step 2: Enrichment + Scoring', { clientId, total: rawPodcasts.length });

    const savedMatches = [];
    const BATCH_SIZE = 5;

    for (let i = 0; i < rawPodcasts.length; i += BATCH_SIZE) {
      const batch = rawPodcasts.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(async (rawPodcast) => {
        // Cache check — skip enrichment if enriched within 30 days
        const { data: cached } = await supabase
          .from('podcasts')
          .select('*')
          .eq('external_id', rawPodcast.external_id)
          .gte('enriched_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
          .maybeSingle();

        const enriched = cached || await enrichPodcast(rawPodcast);
        const podcastRecord = buildPodcastRecord(enriched);

        const { data: savedPodcast, error: podcastError } = await supabase
          .from('podcasts')
          .upsert(podcastRecord, { onConflict: 'external_id' })
          .select()
          .single();

        if (podcastError || !savedPodcast) {
          logger.error('Failed to upsert podcast', { title: rawPodcast.title, error: podcastError?.message });
          return null;
        }

        const scoring = await scorePodcast(savedPodcast, client);

        const matchRecord = {
          client_id:            client.id,
          podcast_id:           savedPodcast.id,
          relevance_score:      scoring.relevance_score,
          audience_score:       scoring.audience_score,
          recency_score:        scoring.recency_score,
          guest_quality_score:  scoring.guest_quality_score,
          reach_score:          scoring.reach_score,
          contactability_score: scoring.contactability_score,
          brand_score:          scoring.brand_score,
          fit_score:            scoring.fit_score,
          show_summary:         scoring.show_summary,
          why_this_client_fits: scoring.why_this_client_fits,
          best_pitch_angle:     scoring.best_pitch_angle,
          episode_to_reference: scoring.episode_to_reference,
          red_flags:            scoring.red_flags,
          booking_likelihood:   scoring.booking_likelihood,
          status:               'new',
        };

        const { data: savedMatch, error: matchError } = await supabase
          .from('podcast_matches')
          .upsert(matchRecord, { onConflict: 'client_id,podcast_id', ignoreDuplicates: true })
          .select()
          .single();

        if (matchError || !savedMatch) {
          logger.error('Failed to insert match', { podcastId: savedPodcast.id, error: matchError?.message });
          return null;
        }

        // Email is written on approve — not at discovery time
        return { ...savedMatch, podcasts: savedPodcast };
      }));

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          savedMatches.push(result.value);
        } else if (result.status === 'rejected') {
          logger.error('Batch item failed', { error: result.reason?.message });
        }
      }
    }

    const emailsWritten = 0; // emails now written on approve

    logger.info('Step 3: Emails written', { clientId, emailsWritten });

    // ── 6. Send digest email ──────────────────────────────────
    logger.info('Step 4: Sending digest email', { clientId });
    await sendDigestEmail(client, savedMatches);

    // ── 7. Update last_run_at ─────────────────────────────────
    await updateLastRun(clientId);

    // Fire-and-forget deep enrichment for new podcasts (reachable shows only)
    const newPodcastIds = savedMatches.map((m) => m.podcast_id || m.podcasts?.id).filter(Boolean);
    if (newPodcastIds.length > 0) {
      const { deepEnrichNewPodcasts } = require('../lib/deep-enricher');
      deepEnrichNewPodcasts(newPodcastIds).catch((err) =>
        logger.warn('Deep enrichment background error', { error: err.message })
      );
    }

    logger.info('Pipeline run complete', {
      clientId,
      matchesFound:  savedMatches.length,
      emailsWritten,
    });

    return res.json({
      success:      true,
      matchesFound:  savedMatches.length,
      emailsWritten,
    });
  } catch (err) {
    logger.error('Pipeline run failed', {
      clientId,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ success: false, error: 'Pipeline run failed.', detail: err.message });
  }
});

/**
 * Update the client's last_run_at timestamp.
 */
async function updateLastRun(clientId) {
  const { error } = await supabase
    .from('clients')
    .update({ last_run_at: new Date().toISOString() })
    .eq('id', clientId);

  if (error) {
    logger.warn('Failed to update last_run_at', { clientId, error: error.message });
  }
}

/**
 * Build niche_tags array from all available topic signals.
 * Used by the global cache pull in discovery guardrail Layer 4.
 */
function buildNicheTags(enriched) {
  const tags = new Set();
  // From explicit niche_tags already on the record
  for (const t of (enriched.niche_tags || [])) {
    if (t) tags.add(t.toLowerCase().trim());
  }
  // From category field
  if (enriched.category) tags.add(enriched.category.toLowerCase().trim());
  // From description keyword extraction (simple heuristic)
  const TOPIC_KEYWORDS = [
    'entrepreneurship','entrepreneur','business','technology','tech','health','wellness',
    'marketing','leadership','finance','money','investing','real estate','mindset',
    'productivity','parenting','relationships','personal development','education',
    'science','sports','comedy','news','politics','travel','food','fitness',
    'mental health','sales','startup','ecommerce','coaching','consulting',
    'branding','social media','content','podcasting','speaking','author',
  ];
  const desc = (enriched.description || '').toLowerCase();
  for (const kw of TOPIC_KEYWORDS) {
    if (desc.includes(kw)) tags.add(kw);
  }
  return Array.from(tags).slice(0, 20); // cap at 20 tags
}

/**
 * Build a podcast record suitable for upsert from enriched data.
 */
function toInt(val) {
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

function buildPodcastRecord(enriched) {
  return {
    external_id:             enriched.external_id,
    title:                   enriched.title,
    host_name:               enriched.host_name       || null,
    description:             enriched.description     || null,
    website:                 enriched.website         || null,
    contact_email:           enriched.contact_email   || null,
    contact_form_url:        enriched.contact_form_url || null,
    apple_url:               enriched.apple_url       || null,
    spotify_url:             enriched.spotify_url     || null,
    youtube_url:             enriched.youtube_url     || null,
    youtube_channel_id:      enriched.youtube_channel_id || null,
    youtube_subscribers:     toInt(enriched.youtube_subscribers),
    instagram_url:           enriched.instagram_url   || null,
    instagram_followers:     toInt(enriched.instagram_followers),
    linkedin_url:            enriched.linkedin_url    || null,
    category:                enriched.category        || null,
    niche_tags:              buildNicheTags(enriched),
    total_episodes:          toInt(enriched.total_episodes),
    last_episode_date:       enriched.last_episode_date || null,
    publish_frequency:       enriched.publish_frequency || null,
    avg_episode_duration_mins: toInt(enriched.avg_episode_duration_mins),
    has_guest_history:       enriched.has_guest_history ?? false,
    booking_page_url:        enriched.booking_page_url || null,
    guest_application_url:   enriched.guest_application_url || null,
    country:                 enriched.country         || null,
    language:                enriched.language        || 'English',
    listen_score:            toInt(enriched.listen_score),
    enriched_at:             enriched.enriched_at     || new Date().toISOString(),
  };
}

module.exports = router;
