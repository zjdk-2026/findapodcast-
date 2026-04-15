'use strict';

const cron     = require('node-cron');
const supabase = require('./lib/supabase');
const logger   = require('./lib/logger');

// We avoid importing pipeline route directly; instead we call the service layer.
// The scheduler triggers the pipeline via an internal HTTP call or direct service call.
// Here we call the pipeline services directly to avoid circular deps.
const { discoverPodcasts }  = require('./services/discovery');
const { enrichPodcast }     = require('./services/enrichment');
const { scorePodcast }      = require('./services/scoring');
const { writeEmail }        = require('./services/emailWriter');
const { createDraft }       = require('./services/gmailService');
const { sendDigestEmail }   = require('./services/digestEmail');
const { sendFollowUps }     = require('./services/followUp');
const { sendWeeklyDigest }  = require('./services/weeklyDigest');

// Keep track of per-client cron jobs so we can reschedule dynamically
const activeJobs = new Map(); // clientId → cron.ScheduledTask

/**
 * Run the full pipeline for a single client.
 * Mirrors the logic in src/routes/pipeline.js but called directly.
 */
async function runPipelineForClient(client) {
  logger.info('Scheduled pipeline run starting', {
    clientId:   client.id,
    clientName: client.name,
    timezone:   client.timezone,
  });

  try {
    const rawPodcasts = await discoverPodcasts(client);
    logger.info('Discovery done', { clientId: client.id, count: rawPodcasts.length });

    if (rawPodcasts.length === 0) {
      await markLastRun(client.id);
      return;
    }

    const savedMatches = [];
    let emailsWritten  = 0;

    for (const rawPodcast of rawPodcasts) {
      try {
        const enriched = await enrichPodcast(rawPodcast);

        const podcastRecord = buildPodcastRecord(enriched);
        const { data: savedPodcast, error: podcastError } = await supabase
          .from('podcasts')
          .upsert(podcastRecord, { onConflict: 'external_id' })
          .select()
          .single();

        if (podcastError || !savedPodcast) {
          logger.error('Scheduler: failed to upsert podcast', {
            title: rawPodcast.title,
            error: podcastError?.message,
          });
          continue;
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
          .insert(matchRecord)
          .select()
          .single();

        if (matchError || !savedMatch) {
          logger.error('Scheduler: failed to insert match', { error: matchError?.message });
          continue;
        }

        savedMatches.push({ ...savedMatch, podcasts: savedPodcast });

        const email = await writeEmail(client, scoring, savedPodcast);

        let gmailDraftId = null;
        if (client.gmail_refresh_token && savedPodcast.contact_email?.includes('@')) {
          try {
            gmailDraftId = await createDraft(
              client.gmail_refresh_token,
              savedPodcast.contact_email,
              email.subject,
              email.body,
              null
            );
          } catch (dErr) {
            logger.warn('Scheduler: Gmail draft failed', { error: dErr.message });
          }
        }

        await supabase
          .from('podcast_matches')
          .update({
            email_subject:  email.subject,
            email_body:     email.body,
            gmail_draft_id: gmailDraftId,
          })
          .eq('id', savedMatch.id);

        emailsWritten++;
        savedMatch.email_subject  = email.subject;
        savedMatch.email_body     = email.body;
        savedMatch.gmail_draft_id = gmailDraftId;
      } catch (innerErr) {
        logger.error('Scheduler: podcast processing error', { error: innerErr.message });
      }
    }

    await sendDigestEmail(client, savedMatches);
    await sendFollowUps(client);
    await markLastRun(client.id);

    logger.info('Scheduled pipeline run complete', {
      clientId:     client.id,
      matchesFound: savedMatches.length,
      emailsWritten,
    });
  } catch (err) {
    logger.error('Scheduled pipeline run failed', {
      clientId: client.id,
      error:    err.message,
      stack:    err.stack,
    });
  }
}

/**
 * Schedule a cron job for a specific client at 7am in their timezone.
 * Falls back to 7am UTC if the timezone is invalid.
 */
function scheduleClientJob(client) {
  // Cancel existing job if present
  if (activeJobs.has(client.id)) {
    activeJobs.get(client.id).destroy();
    activeJobs.delete(client.id);
  }

  // node-cron uses server local time, not per-job timezones in the community edition.
  // We schedule all jobs at 7am UTC and log the client's local timezone as context.
  // For production per-timezone support, use the node-cron timezone option.
  const tz = client.timezone || 'America/New_York';

  // Validate timezone by attempting to use it
  let cronExpression = '0 7 * * *'; // 7:00am daily
  let usedTimezone   = tz;

  try {
    // Test that the timezone is valid
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    logger.warn('Invalid timezone for client — using UTC', {
      clientId:       client.id,
      invalidTimezone: tz,
    });
    usedTimezone = 'UTC';
  }

  logger.info('Scheduling pipeline job for client', {
    clientId:  client.id,
    name:      client.name,
    timezone:  usedTimezone,
    cron:      cronExpression,
  });

  // node-cron v3 supports timezone option directly
  const job = cron.schedule(cronExpression, async () => {
    logger.info('Cron job triggered', { clientId: client.id, timezone: usedTimezone });
    await runPipelineForClient(client);
  }, {
    timezone:  usedTimezone,
    scheduled: true,
  });

  activeJobs.set(client.id, job);
}

/**
 * Load all active clients and set up their scheduled jobs.
 */
async function loadAndScheduleClients() {
  logger.info('Loading active clients for scheduling');

  try {
    const { data: clients, error } = await supabase
      .from('clients')
      .select('id, name, email, timezone, is_active, topics, speaking_angles, target_audience, languages, max_show_age_days, min_show_episodes, daily_target, gmail_refresh_token, dashboard_token')
      .eq('is_active', true);

    if (error) {
      logger.error('Failed to load clients for scheduling', { error: error.message });
      return;
    }

    logger.info('Scheduling jobs for active clients', { count: (clients || []).length });

    for (const client of (clients || [])) {
      scheduleClientJob(client);
    }

    // Remove jobs for clients no longer in the active list
    const activeIds = new Set((clients || []).map((c) => c.id));
    for (const [id, job] of activeJobs.entries()) {
      if (!activeIds.has(id)) {
        logger.info('Removing job for inactive/deleted client', { clientId: id });
        job.destroy();
        activeJobs.delete(id);
      }
    }
  } catch (err) {
    logger.error('loadAndScheduleClients error', { error: err.message });
  }
}

// Re-enrichment is triggered individually per client when they open a card
// (via POST /api/re-enrich/:matchId) — no bulk nightly job to save API tokens.

/**
 * initScheduler()
 * Called once on server start.
 * Sets up the initial jobs and a 24-hour refresh cycle to pick up new clients.
 */
function initScheduler() {
  logger.info('Initialising scheduler');

  // Initial load
  loadAndScheduleClients();

  // Refresh client list every 24 hours to pick up new clients or deactivations
  cron.schedule('0 0 * * *', () => {
    logger.info('Daily scheduler refresh — reloading client list');
    loadAndScheduleClients();
  }, { timezone: 'UTC', scheduled: true });

  // Weekly digest — every Monday at 8am UTC
  cron.schedule('0 8 * * 1', async () => {
    logger.info('Weekly digest — sending to all active clients');
    const { data: clients, error } = await supabase
      .from('clients')
      .select('id, name, email, dashboard_token')
      .eq('active', true)
      .not('onboarded_at', 'is', null);
    if (error) { logger.error('Weekly digest: failed to load clients', { error: error.message }); return; }
    for (const client of clients || []) {
      try { await sendWeeklyDigest(client); } catch (err) { logger.warn('Weekly digest failed for client', { clientId: client.id, error: err.message }); }
    }
    logger.info('Weekly digest complete', { count: (clients || []).length });
  }, { timezone: 'UTC', scheduled: true });

  logger.info('Scheduler initialised');
}

// ── Helpers ─────────────────────────────────────────────────────────

async function markLastRun(clientId) {
  const { error } = await supabase
    .from('clients')
    .update({ last_run_at: new Date().toISOString() })
    .eq('id', clientId);

  if (error) {
    logger.warn('Failed to update last_run_at', { clientId, error: error.message });
  }
}

function buildPodcastRecord(enriched) {
  return {
    external_id:               enriched.external_id,
    title:                     enriched.title,
    host_name:                 enriched.host_name          || null,
    description:               enriched.description        || null,
    website:                   enriched.website            || null,
    contact_email:             enriched.contact_email      || null,
    contact_form_url:          enriched.contact_form_url   || null,
    apple_url:                 enriched.apple_url          || null,
    spotify_url:               enriched.spotify_url        || null,
    youtube_url:               enriched.youtube_url        || null,
    youtube_channel_id:        enriched.youtube_channel_id || null,
    youtube_subscribers:       enriched.youtube_subscribers || null,
    instagram_url:             enriched.instagram_url      || null,
    instagram_followers:       enriched.instagram_followers || null,
    linkedin_url:              enriched.linkedin_url       || null,
    category:                  enriched.category           || null,
    niche_tags:                enriched.niche_tags         || [],
    total_episodes:            enriched.total_episodes     ?? null,
    last_episode_date:         enriched.last_episode_date  || null,
    publish_frequency:         enriched.publish_frequency  || null,
    avg_episode_duration_mins: enriched.avg_episode_duration_mins || null,
    has_guest_history:         enriched.has_guest_history  ?? false,
    booking_page_url:          enriched.booking_page_url   || null,
    guest_application_url:     enriched.guest_application_url || null,
    country:                   enriched.country            || null,
    language:                  enriched.language           || 'English',
    listen_score:              enriched.listen_score       ?? null,
    facebook_url:              enriched.facebook_url       || null,
    twitter_url:               enriched.twitter_url        || null,
    tiktok_url:                enriched.tiktok_url         || null,
    linkedin_page_url:         enriched.linkedin_page_url  || null,
    enriched_at:               enriched.enriched_at        || new Date().toISOString(),
  };
}

module.exports = { initScheduler, runPipelineForClient };
