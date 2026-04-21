'use strict';

const express = require('express');
const router = express.Router();
const { unlockPodcast } = require('../lib/strict-unlock');
const { buildFallbackTips } = require('../lib/contact-likelihood');
const logger = require('../lib/logger');
const supabase = require('../lib/supabase');

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/unlock/:podcastId
//
// Body: { clientId?: uuid }
// Response:
//   200 { ok: true, podcast, cached: bool, fallback_tips: [...] | null }
//   404 { ok: false, error: 'podcast_not_found' }
//   500 { ok: false, error: string }
// ═══════════════════════════════════════════════════════════════════════════

router.post('/api/unlock/:podcastId', async (req, res) => {
  const { podcastId } = req.params;
  const clientId = req.body?.clientId || null;

  if (!podcastId) return res.status(400).json({ ok: false, error: 'podcastId required' });

  try {
    const result = await unlockPodcast(podcastId, clientId);
    if (!result.ok) {
      return res.status(result.error === 'podcast_not_found' ? 404 : 500).json(result);
    }

    // If no contact data was found, bundle fallback tips
    const p = result.podcast;
    const anyContact = !!(p.contact_email || p.instagram_url || p.twitter_url ||
                          p.facebook_url || p.linkedin_page_url || p.youtube_url ||
                          p.host_instagram_url || p.host_linkedin_url || p.host_twitter_url);

    const responsePayload = {
      ok: true,
      cached: !!result.cached,
      podcast: p,
      fallback_tips: anyContact ? null : buildFallbackTips(p),
    };

    res.json(responsePayload);
  } catch (err) {
    logger.error('POST /api/unlock failed', { podcastId, error: err.message });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
