'use strict';

/**
 * ScrapeGraphAI Enrichment API Routes
 *
 * POST /api/enrich-ai/:podcastId  — Enrich a single podcast card with AI-extracted data
 * POST /api/enrich-ai/batch       — Enrich all missing-data cards for the authenticated client
 *
 * Uses the SGAI cloud API (free tier) to extract host names, social links,
 * topics, and descriptions from podcast websites. Results are cached in
 * the FAPIO database for cross-customer reuse.
 *
 * No credit charge — uses the platform's SGAI API key, not the customer's credits.
 */

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const { enrichPodcastWithSGAI, enrichBatch } = require('../services/sgai-enricher');
const requireDashboardToken = require('../middleware/requireDashboardToken');

const router = express.Router();

// ── POST /api/enrich-ai/:podcastId ──────────────────────────────────────────
// Enrich a single podcast by ID. Authenticated via dashboard token.
// Adds extra frontend-friendly fields (host_name, description) to the
// response so the card can update immediately without re-fetching state.
router.post('/enrich-ai/:podcastId', requireDashboardToken, async (req, res) => {
  const { podcastId } = req.params;
  const clientId = req.clientId || req.body?.clientId || null;

  if (!podcastId) {
    return res.status(400).json({ ok: false, error: 'podcastId_required' });
  }

  try {
    const result = await enrichPodcastWithSGAI(podcastId);

    if (!result.ok) {
      const statusMap = {
        podcast_not_found: 404,
        no_url_available:  400,
        empty_result:      422,
        sgai_api_error:    502,
        sgai_http_429:     429,
        db_update_failed:  500,
      };
      return res.status(statusMap[result.error?.split(':')[0]] || 500).json(result);
    }

    // Re-fetch the podcast so the frontend gets complete, up-to-date data
    const { data: podcast } = await supabase
      .from('podcasts')
      .select('id, host_name, description, website, contact_email, instagram_url, twitter_url, linkedin_page_url, facebook_url, youtube_url, tiktok_url, booking_page_url, guest_application_url, niche_tags, enriched_at')
      .eq('id', podcastId)
      .single();

    return res.json({
      ok: true,
      enriched: result.enriched,
      podcast: podcast || null,
    });
  } catch (err) {
    logger.error('POST /api/enrich-ai failed', { podcastId, error: err.message });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ── POST /api/enrich-ai/batch ───────────────────────────────────────────────
// Enrich up to N podcasts for the authenticated client that have
// missing data and a website URL available. Processes sequentially
// to respect SGAI free-tier rate limits.
router.post('/enrich-ai/batch', requireDashboardToken, async (req, res) => {
  const clientId = req.clientId || req.body?.clientId || null;
  const max = Math.min(parseInt(req.body?.max) || 5, 10); // cap at 10 per request

  if (!clientId) {
    return res.status(400).json({ ok: false, error: 'clientId_required' });
  }

  try {
    // Find podcasts linked to this client that have:
    //   - A website/URL we can scrape
    //   - No host_name OR no description (haven't been deeply enriched)
    const { data: matches, error: matchError } = await supabase
      .from('podcast_matches')
      .select('podcast_id')
      .eq('client_id', clientId);

    if (matchError) {
      logger.error('batch enrich: failed to fetch matches', { clientId, error: matchError.message });
      return res.status(500).json({ ok: false, error: 'fetch_matches_failed' });
    }

    if (!matches || matches.length === 0) {
      return res.json({ ok: true, results: [], message: 'no_matches' });
    }

    const podcastIds = matches.map(m => m.podcast_id).filter(Boolean);

    // Filter to podcasts that haven't been SGAI-enriched yet
    const { data: podcasts } = await supabase
      .from('podcasts')
      .select('id, title, website, url, host_name, description, enriched_at')
      .in('id', podcastIds);

    if (!podcasts || podcasts.length === 0) {
      return res.json({ ok: true, results: [], message: 'no_podcasts_found' });
    }

    // Pick pods that have a URL but are missing key enrichment fields
    const candidates = podcasts.filter(p =>
      (p.website || p.url) &&
      (!p.host_name || !p.description)
    ).slice(0, max);

    if (candidates.length === 0) {
      return res.json({ ok: true, results: [], message: 'all_already_enriched' });
    }

    logger.info('Batch SGAI enrichment', {
      clientId,
      candidateCount: candidates.length,
      ids: candidates.map(c => c.id),
    });

    const { results } = await enrichBatch(
      candidates.map(c => c.id),
      max
    );

    return res.json({ ok: true, results });
  } catch (err) {
    logger.error('POST /api/enrich-ai/batch failed', { clientId, error: err.message });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
