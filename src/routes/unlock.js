'use strict';

const express = require('express');
const router = express.Router();
const { unlockPodcast } = require('../lib/strict-unlock');
const { buildFallbackTips } = require('../lib/contact-likelihood');
const { chargeCredits } = require('../lib/credits');
const logger = require('../lib/logger');
const supabase = require('../lib/supabase');
const requireDashboardToken = require('../middleware/requireDashboardToken');

// ═══════════════════════════════════════════════════════════════════════════
// POST /unlock/:podcastId  (mounted at /api — final path /api/unlock/:id)
//
// Requires dashboard token (header x-dashboard-token or pp_session cookie).
// clientId is taken from the authenticated session, not the request body.
//
// Response:
//   200 { ok: true, podcast, cached: bool, fallback_tips: [...] | null }
//   404 { ok: false, error: 'podcast_not_found' }
//   500 { ok: false, error: string }
// ═══════════════════════════════════════════════════════════════════════════

router.post('/unlock/:podcastId', requireDashboardToken, async (req, res) => {
  const { podcastId } = req.params;
  const clientId = req.clientId || req.body?.clientId || null;

  if (!podcastId) return res.status(400).json({ ok: false, error: 'podcastId required' });

  // Credit gate: 1 credit per unlock (skipped for unlimited Tour customers)
  if (clientId) {
    const charge = await chargeCredits(clientId, 'unlock', { podcastId });
    if (!charge.ok) {
      if (charge.error === 'insufficient_credits') {
        return res.status(402).json({ ok: false, error: 'insufficient_credits', balance: charge.balance, needed: charge.needed });
      }
      return res.status(500).json({ ok: false, error: 'credit_charge_failed' });
    }
  }

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

    // Fire-and-forget: scrape the podcast's website footer/contact for socials
    // we may have missed during enrichment. Zero-hallucination — only stores
    // socials literally present on the page.
    if (p.website && (!p.instagram_url || !p.twitter_url || !p.facebook_url || !p.linkedin_page_url || !p.youtube_url)) {
      const { grabFromWebsite } = require('../services/siteSocialGrab');
      grabFromWebsite(p.website).then(async (socials) => {
        if (!socials) return;
        const patch = {};
        // Only fill in fields we don't already have (don't overwrite verified data)
        if (!p.instagram_url     && socials.instagram_url) patch.instagram_url     = socials.instagram_url;
        if (!p.twitter_url       && socials.twitter_url)   patch.twitter_url       = socials.twitter_url;
        if (!p.facebook_url      && socials.facebook_url)  patch.facebook_url      = socials.facebook_url;
        if (!p.linkedin_page_url && socials.linkedin_url)  patch.linkedin_page_url = socials.linkedin_url;
        if (!p.youtube_url       && socials.youtube_url)   patch.youtube_url       = socials.youtube_url;
        if (!p.tiktok_url        && socials.tiktok_url)    patch.tiktok_url        = socials.tiktok_url;
        if (Object.keys(patch).length === 0) return;

        await supabase.from('podcasts').update(patch).eq('id', podcastId);
        logger.info('Site-social grab backfilled', { podcastId, found: Object.keys(patch) });
      }).catch((err) => {
        logger.warn('Site-social grab failed (non-fatal)', { podcastId, error: err.message });
      });
    }
  } catch (err) {
    logger.error('POST /api/unlock failed', { podcastId, error: err.message });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ── POST /api/grab-socials/:podcastId ─────────────────────────────────────
// Standalone trigger to scrape a podcast's website for social links.
// Useful for re-running on existing matches or for podcasts where unlock
// already happened. Does NOT charge credits (free, low-cost operation).
router.post('/grab-socials/:podcastId', requireDashboardToken, async (req, res) => {
  const { podcastId } = req.params;
  if (!podcastId) return res.status(400).json({ ok: false, error: 'podcastId_required' });

  try {
    const { data: pod, error } = await supabase
      .from('podcasts')
      .select('id, website, instagram_url, twitter_url, facebook_url, linkedin_page_url, youtube_url, tiktok_url')
      .eq('id', podcastId).single();
    if (error || !pod) return res.status(404).json({ ok: false, error: 'podcast_not_found' });
    if (!pod.website) return res.json({ ok: true, found: 0, message: 'no_website' });

    const { grabFromWebsite } = require('../services/siteSocialGrab');
    const socials = await grabFromWebsite(pod.website);
    if (!socials) return res.json({ ok: true, found: 0, message: 'no_socials_on_site' });

    const patch = {};
    if (!pod.instagram_url     && socials.instagram_url) patch.instagram_url     = socials.instagram_url;
    if (!pod.twitter_url       && socials.twitter_url)   patch.twitter_url       = socials.twitter_url;
    if (!pod.facebook_url      && socials.facebook_url)  patch.facebook_url      = socials.facebook_url;
    if (!pod.linkedin_page_url && socials.linkedin_url)  patch.linkedin_page_url = socials.linkedin_url;
    if (!pod.youtube_url       && socials.youtube_url)   patch.youtube_url       = socials.youtube_url;
    if (!pod.tiktok_url        && socials.tiktok_url)    patch.tiktok_url        = socials.tiktok_url;

    if (Object.keys(patch).length > 0) {
      await supabase.from('podcasts').update(patch).eq('id', podcastId);
    }

    res.json({
      ok: true,
      found: Object.keys(patch).length,
      added: patch,
      already_had: Object.keys(socials).filter(k => socials[k] && pod[k === 'linkedin_url' ? 'linkedin_page_url' : k]),
    });
  } catch (err) {
    logger.error('grab-socials error', { podcastId, error: err.message });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
