'use strict';
const express = require('express');
const supabase = require('../lib/supabase');
const logger = require('../lib/logger');
const { enrichPodcast } = require('../services/enrichment');
const { scorePodcast } = require('../services/scoring');
const router = express.Router();

// POST /api/operator/add-podcast
// Accepts requests from the client dashboard (x-dashboard-token) OR operator panel (x-operator-key)
// Body: { resolvedClientId, podcastUrl, podcastName, ...optional fields }
router.post('/add-podcast', async (req, res) => {
  const { resolvedClientId, podcastUrl, podcastName, contactEmail, instagramUrl, linkedinUrl, facebookUrl, spotifyUrl, appleUrl, notes } = req.body;

  // Resolve resolvedClientId: if coming from client dashboard, derive from token
  const token = req.headers['x-dashboard-token'];
  let resolvedClientId = resolvedClientId;
  if (token && !resolvedClientId) {
    const { data: c } = await supabase.from('clients').select('id').eq('dashboard_token', token).single();
    resolvedClientId = c?.id || null;
  }

  if (!resolvedClientId || (!podcastUrl && !podcastName)) {
    return res.status(400).json({ success: false, error: 'resolvedClientId and podcastUrl or podcastName required.' });
  }

  try {
    // Build base podcast object from provided info
    const base = {
      external_id: `manual_${Date.now()}`,
      title: podcastName || podcastUrl,
      website: podcastUrl || null,
      source: 'manual',
      host_name: null,
      contact_email: contactEmail || null,
      instagram_url: instagramUrl || null,
      linkedin_url: linkedinUrl || null,
      facebook_url: facebookUrl || null,
      spotify_url: spotifyUrl || null,
      apple_url: appleUrl || null,
      description: null,
      total_episodes: null,
      last_episode_date: null,
      listen_score: null,
      country: null,
      language: 'English',
    };

    // Enrich by scraping the website
    const enriched = await enrichPodcast(base);

    // Upsert podcast into podcasts table
    const { data: podcast, error: podcastError } = await supabase
      .from('podcasts')
      .upsert(enriched, { onConflict: 'external_id' })
      .select()
      .single();

    if (podcastError) throw podcastError;

    // Check if match already exists for this client
    const { data: existing } = await supabase
      .from('podcast_matches')
      .select('id')
      .eq('client_id', resolvedClientId)
      .eq('podcast_id', podcast.id)
      .single();

    if (existing) {
      return res.json({ success: true, message: 'Already in pipeline.', matchId: existing.id });
    }

    // Create match with 'new' status (notes stored in pitch_notes for operator reference)
    const { data: match, error: matchError } = await supabase
      .from('podcast_matches')
      .insert({
        client_id:   resolvedClientId,
        podcast_id:  podcast.id,
        status:      'new',
        fit_score:   0,
        pitch_notes: notes || null,
        restored_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (matchError) throw matchError;

    // Fetch client for scoring context
    const { data: client } = await supabase.from('clients').select('*').eq('id', resolvedClientId).single();

    // Score the match in background (don't block response)
    if (client) {
      scorePodcast(podcast, client).then((scored) => {
        if (scored) {
          supabase.from('podcast_matches').update(scored).eq('id', match.id)
            .then(() => logger.info('Manual podcast scored', { matchId: match.id, fit_score: scored.fit_score }));
        }
      }).catch((err) => logger.warn('Manual podcast scoring failed', { error: err.message }));
    }

    logger.info('Manual podcast added', { resolvedClientId, podcastId: podcast.id, title: enriched.title });
    return res.json({ success: true, match, podcast });
  } catch (err) {
    logger.error('Manual podcast add failed', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
