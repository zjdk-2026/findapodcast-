'use strict';

/**
 * Apple Podcasts Enrichment API Routes
 *
 * POST /api/enrich-apple/:podcastId  — Scrape Apple Podcasts page + host page + host Facebook for data
 * POST /api/enrich-apple/batch       — Batch-enrich all of a client's podcasts
 *
 * Uses the free Apple Podcasts HTML pages + Facebook mbasic pages to extract:
 *   rating, review count, chart rank, ad flag, host social links, contact info
 * No API keys needed — completely free.
 */

const express = require('express');
const logger = require('../lib/logger');
const requireDashboardToken = require('../middleware/requireDashboardToken');
const {
  scrapeAndStoreAppleData,
  batchScrapeAppleData,
} = require('../services/appleScraper');

const router = express.Router();

// ── POST /api/enrich-apple/:podcastId ─────────────────────────────────
// Enrich a single podcast by ID using Apple Podcasts + Facebook scraping.
router.post('/enrich-apple/:podcastId', requireDashboardToken, async (req, res) => {
  const { podcastId } = req.params;

  if (!podcastId) {
    return res.status(400).json({ ok: false, error: 'podcastId_required' });
  }

  try {
    const result = await scrapeAndStoreAppleData(podcastId);

    if (!result.ok || !result.data) {
      const statusMap = {
        not_found: 404,
        no_apple_url: 400,
        no_url: 400,
        invalid_apple_id: 400,
        db_update_failed: 500,
      };
      return res.status(statusMap[result.error] || 422).json(result);
    }

    return res.json({
      ok: true,
      data: result.data,
    });
  } catch (err) {
    logger.error('POST /api/enrich-apple failed', { podcastId, error: err.message });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ── POST /api/enrich-apple/batch ─────────────────────────────────────────────
// Batch-enrich all podcasts for the authenticated client that have
// an Apple URL and haven't been scraped yet.
router.post('/enrich-apple/batch', requireDashboardToken, async (req, res) => {
  const clientId = req.clientId || req.body?.clientId || null;
  const max = Math.min(parseInt(req.body?.max) || 20, 50);

  if (!clientId) {
    return res.status(400).json({ ok: false, error: 'clientId_required' });
  }

  try {
    const result = await batchScrapeAppleData(clientId, max);
    return res.json({ ok: true, results: result.results || [] });
  } catch (err) {
    logger.error('POST /api/enrich-apple/batch failed', {
      clientId,
      error: err.message,
    });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
