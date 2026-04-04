'use strict';
const express = require('express');
const supabase = require('../lib/supabase');
const logger = require('../lib/logger');
const { enrichPodcast } = require('../services/enrichment');
const router = express.Router();

// POST /api/operator/add-podcast
// Body: { clientId, podcastUrl, podcastName }
// Operator pastes a podcast URL or name, system scrapes and adds to client pipeline
router.post('/add-podcast', async (req, res) => {
  const { clientId, podcastUrl, podcastName } = req.body;
  if (!clientId || (!podcastUrl && !podcastName)) {
    return res.status(400).json({ success: false, error: 'clientId and podcastUrl or podcastName required.' });
  }

  try {
    // Build base podcast object from provided info
    const base = {
      external_id: `manual_${Date.now()}`,
      title: podcastName || podcastUrl,
      website: podcastUrl || null,
      source: 'manual',
      host_name: null,
      contact_email: null,
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
      .eq('client_id', clientId)
      .eq('podcast_id', podcast.id)
      .single();

    if (existing) {
      return res.json({ success: true, message: 'Already in pipeline.', matchId: existing.id });
    }

    // Create match with 'new' status
    const { data: match, error: matchError } = await supabase
      .from('podcast_matches')
      .insert({ client_id: clientId, podcast_id: podcast.id, status: 'new', fit_score: 0 })
      .select()
      .single();

    if (matchError) throw matchError;

    logger.info('Manual podcast added', { clientId, podcastId: podcast.id, title: enriched.title });
    return res.json({ success: true, match, podcast: enriched });
  } catch (err) {
    logger.error('Manual podcast add failed', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
