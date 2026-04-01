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

const router = express.Router();

/**
 * POST /api/run/:clientId
 * Runs the full pipeline for a single client:
 *   discover → enrich → score → save matches → write emails → create drafts → send digest
 */
router.post('/run/:clientId', async (req, res) => {
  const { clientId } = req.params;

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

    // ── 2. Discovery ──────────────────────────────────────────
    logger.info('Step 1: Discovery', { clientId });
    const rawPodcasts = await discoverPodcasts(client);
    logger.info('Discovery complete', { clientId, count: rawPodcasts.length });

    if (rawPodcasts.length === 0) {
      logger.warn('No podcasts discovered', { clientId });
      await updateLastRun(clientId);
      return res.json({ success: true, matchesFound: 0, emailsWritten: 0 });
    }

    // ── 3. Enrich & Score ─────────────────────────────────────
    logger.info('Step 2: Enrichment + Scoring', { clientId, total: rawPodcasts.length });

    const savedMatches = [];
    let emailsWritten  = 0;

    for (const rawPodcast of rawPodcasts) {
      try {
        // Enrich
        const enriched = await enrichPodcast(rawPodcast);

        // Upsert podcast record
        const podcastRecord = buildPodcastRecord(enriched);
        const { data: savedPodcast, error: podcastError } = await supabase
          .from('podcasts')
          .upsert(podcastRecord, { onConflict: 'external_id' })
          .select()
          .single();

        if (podcastError || !savedPodcast) {
          logger.error('Failed to upsert podcast', {
            title: rawPodcast.title,
            error: podcastError?.message,
          });
          continue;
        }

        // Score
        const scoring = await scorePodcast(savedPodcast, client);

        // Save initial match record
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
          .insert(matchRecord)
          .select()
          .single();

        if (matchError || !savedMatch) {
          logger.error('Failed to insert podcast match', {
            podcastId: savedPodcast.id,
            error: matchError?.message,
          });
          continue;
        }

        savedMatches.push({ ...savedMatch, podcasts: savedPodcast });

        // ── 4. Write email ────────────────────────────────────
        logger.debug('Writing email for match', { matchId: savedMatch.id });
        const email = await writeEmail(client, scoring, savedPodcast);

        // ── 5. Create Gmail draft if client has OAuth ─────────
        let gmailDraftId = null;
        if (client.gmail_refresh_token) {
          const contactEmail = savedPodcast.contact_email
            || savedPodcast.booking_page_url
            || null;

          if (contactEmail && contactEmail.includes('@')) {
            try {
              gmailDraftId = await createDraft(
                client.gmail_refresh_token,
                contactEmail,
                email.subject,
                email.body
              );
            } catch (draftErr) {
              logger.warn('Gmail draft creation failed', {
                matchId: savedMatch.id,
                error: draftErr.message,
              });
            }
          }
        }

        // Update match with email content and draft ID
        const { error: updateError } = await supabase
          .from('podcast_matches')
          .update({
            email_subject:  email.subject,
            email_body:     email.body,
            gmail_draft_id: gmailDraftId,
          })
          .eq('id', savedMatch.id);

        if (updateError) {
          logger.warn('Failed to update match with email', {
            matchId: savedMatch.id,
            error: updateError.message,
          });
        } else {
          emailsWritten++;
          // Sync local object for digest
          savedMatch.email_subject  = email.subject;
          savedMatch.email_body     = email.body;
          savedMatch.gmail_draft_id = gmailDraftId;
        }
      } catch (podcastErr) {
        logger.error('Error processing podcast', {
          title: rawPodcast.title,
          error: podcastErr.message,
          stack: podcastErr.stack,
        });
        // Continue with next podcast
      }
    }

    logger.info('Step 3: Emails written', { clientId, emailsWritten });

    // ── 6. Send digest email ──────────────────────────────────
    logger.info('Step 4: Sending digest email', { clientId });
    await sendDigestEmail(client, savedMatches);

    // ── 7. Update last_run_at ─────────────────────────────────
    await updateLastRun(clientId);

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
    niche_tags:              enriched.niche_tags      || [],
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
