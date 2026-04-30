'use strict';

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const { redactForDemo, isDemoLocked, isDemoExpired, buildUnlockUrl, STRIPE_UNLOCK_URL } = require('../lib/demo');

const router = express.Router();

/**
 * GET /api/dashboard/:token
 * Look up a client by their dashboard_token.
 * Returns the full client profile plus all podcast_matches joined with podcast details,
 * sorted by fit_score descending.
 */
router.get('/dashboard/:token', async (req, res) => {
  const { token } = req.params;

  if (!token || token.trim().length < 8) {
    return res.status(400).json({ success: false, error: 'Invalid dashboard token.' });
  }

  try {
    // Fetch client
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('*')
      .eq('dashboard_token', token)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ success: false, error: 'Dashboard not found.' });
    }

    // Fetch all matches with joined podcast data, ordered by fit_score desc
    const { data: matches, error: matchesError } = await supabase
      .from('podcast_matches')
      .select(`
        *,
        podcasts (
          id,
          external_id,
          title,
          host_name,
          description,
          website,
          contact_email,
          contact_form_url,
          apple_url,
          spotify_url,
          youtube_url,
          youtube_subscribers,
          instagram_url,
          instagram_followers,
          linkedin_url,
          facebook_url,
          twitter_url,
          tiktok_url,
          linkedin_page_url,
          category,
          niche_tags,
          total_episodes,
          last_episode_date,
          publish_frequency,
          avg_episode_duration_mins,
          has_guest_history,
          booking_page_url,
          guest_application_url,
          country,
          language,
          listen_score,
          enriched_at,
          contact_unlocked_at,
          contact_confidence,
          contact_sources,
          host_instagram_url,
          host_linkedin_url,
          host_twitter_url,
          unlock_count
        )
        ,
        client_notes,
        email_subject_edited,
        email_body_edited,
        follow_up_sent_at,
        booked_show_name
      `)
      .eq('client_id', client.id)
      .order('fit_score', { ascending: false });

    if (matchesError) {
      logger.error('Failed to fetch matches for dashboard', {
        clientId: client.id,
        error:    matchesError.message,
      });
      return res.status(500).json({ success: false, error: 'Failed to load matches.' });
    }

    // Strip sensitive fields from client response
    const safeClient = { ...client };
    delete safeClient.gmail_refresh_token;

    // ── Demo mode redaction ─────────────────────────────────────────────────
    // When client.demo_mode === true, every match runs through redactForDemo()
    // before leaving the server. Frontend never sees real podcast titles, host
    // names, contact emails, social URLs, websites, or exact download numbers.
    // Score, why-fits, pitch angle and the AI-drafted pitch body STAY visible
    // — that's the value proof. Frontend reads match._locked to render
    // black-bar / lock-icon UI.
    const demoLocked = isDemoLocked(client);
    const demoExpired = isDemoExpired(client);
    const rawMatches = matches || [];

    // Pin showcase contact info — enrichment occasionally clobbers the
    // contact_email on the Breakthrough Moment seed row. The card is
    // useless without Zac's real email visible, so force-set it here on
    // every dashboard fetch as a permanent guard.
    const SHOWCASE_PODCAST_ID = 'fa9303fd-3567-4535-9c6f-b918723d8c68';
    for (const m of rawMatches) {
      if (m.podcast_id === SHOWCASE_PODCAST_ID && m.podcasts) {
        m.podcasts.contact_email      = 'hi@zacdeane.com';
        m.podcasts.contact_unlocked_at = m.podcasts.contact_unlocked_at || new Date().toISOString();
        m.podcasts.contact_confidence = 'high';
        m.podcasts.host_name           = m.podcasts.host_name || 'Zac Deane';
      }
    }

    const outboundMatches = demoLocked ? rawMatches.map(redactForDemo) : rawMatches;

    return res.json({
      success: true,
      client:  safeClient,
      community_group_url: process.env.COMMUNITY_GROUP_URL || 'https://www.facebook.com/groups/1271256181171237',
      matches: outboundMatches,
      demo: demoLocked ? {
        active:        true,
        expired:       demoExpired,
        expires_at:    client.demo_expires_at,
        unlock_url:    buildUnlockUrl(client),
        message:       demoExpired
          ? 'Your 14-day demo has expired. Unlock to keep your pipeline.'
          : 'You are in demo mode. Unlock the platform to send pitches and contact hosts.',
      } : null,
      stats: {
        total:    rawMatches.length,
        new:      rawMatches.filter((m) => m.status === 'new').length,
        approved: rawMatches.filter((m) => m.status === 'approved').length,
        sent:     rawMatches.filter((m) => m.status === 'sent').length,
        replied:  rawMatches.filter((m) => m.status === 'replied').length,
        booked:   rawMatches.filter((m) => m.status === 'booked').length,
        dismissed:rawMatches.filter((m) => m.status === 'dismissed').length,
        avgScore: rawMatches.length > 0
          ? Math.round(rawMatches.reduce((sum, m) => sum + (m.fit_score || 0), 0) / rawMatches.length)
          : 0,
      },
    });
  } catch (err) {
    logger.error('Dashboard route error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
