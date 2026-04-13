'use strict';

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

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
          enriched_at
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

    return res.json({
      success: true,
      client:  safeClient,
      community_group_url: process.env.COMMUNITY_GROUP_URL || 'https://www.facebook.com/groups/1453098208738507',
      matches: matches || [],
      stats: {
        total:    (matches || []).length,
        new:      (matches || []).filter((m) => m.status === 'new').length,
        approved: (matches || []).filter((m) => m.status === 'approved').length,
        sent:     (matches || []).filter((m) => m.status === 'sent').length,
        replied:  (matches || []).filter((m) => m.status === 'replied').length,
        booked:   (matches || []).filter((m) => m.status === 'booked').length,
        dismissed:(matches || []).filter((m) => m.status === 'dismissed').length,
        avgScore: (matches || []).length > 0
          ? Math.round(
              (matches || []).reduce((sum, m) => sum + (m.fit_score || 0), 0) / (matches || []).length
            )
          : 0,
      },
    });
  } catch (err) {
    logger.error('Dashboard route error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
