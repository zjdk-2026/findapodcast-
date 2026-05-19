'use strict';

/**
 * Apple Podcasts Artwork API Routes
 *
 * POST /api/fetch-artwork/:podcastId  — Fetch and store cover art for one podcast
 * POST /api/fetch-artwork/batch       — Batch-fetch artwork for all of a client's podcasts
 */

const express = require('express');
const logger = require('../lib/logger');
const requireDashboardToken = require('../middleware/requireDashboardToken');
const { fetchAndStoreArtwork, batchFetchArtwork } = require('../services/appleArtwork');

const router = express.Router();

// ── POST /api/fetch-artwork/:podcastId ────────────────────────────────────
// Fetch cover art for a single podcast by ID.
// Uses the public iTunes lookup API (free, no auth key needed).
router.post('/fetch-artwork/:podcastId', requireDashboardToken, async (req, res) => {
  const { podcastId } = req.params;

  if (!podcastId) {
    return res.status(400).json({ ok: false, error: 'podcastId_required' });
  }

  try {
    const result = await fetchAndStoreArtwork(podcastId);

    if (!result.ok) {
      // Return 200 with empty image so frontend can try client-side fallback
      return res.json({ ok: false, image: null, error: result.error });
    }

    return res.json({
      ok: true,
      image: result.imageUrl,
      cached: result.cached || false,
    });
  } catch (err) {
    logger.error('POST /api/fetch-artwork failed', {
      podcastId,
      error: err.message,
    });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ── POST /api/fetch-artwork/batch ─────────────────────────────────────────
// Batch-fetch artwork for all podcasts of the authenticated client
// that are missing cover art. Processes sequentially.
router.post('/fetch-artwork/batch', requireDashboardToken, async (req, res) => {
  const clientId = req.clientId || req.body?.clientId || null;
  const max = Math.min(parseInt(req.body?.max) || 20, 50);

  if (!clientId) {
    return res.status(400).json({ ok: false, error: 'clientId_required' });
  }

  try {
    const result = await batchFetchArtwork(clientId, max);
    return res.json({ ok: result.ok, results: result.results });
  } catch (err) {
    logger.error('POST /api/fetch-artwork/batch failed', {
      clientId,
      error: err.message,
    });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;