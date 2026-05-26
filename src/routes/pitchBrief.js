'use strict';

/**
 * Pitch Brief routes
 *
 * GET  /api/pitch-brief/:matchId            -> cached brief if exists, else generate (charges 5 credits)
 * POST /api/pitch-brief/:matchId/regenerate -> force regen (first regen is free, after that 5 credits)
 */

const express = require('express');
const router = express.Router();

const supabase = require('../lib/supabase');
const logger = require('../lib/logger');
const requireDashboardToken = require('../middleware/requireDashboardToken');
const { chargeCredits } = require('../lib/credits');
const { generateBrief, hasAnglePoweringProfile, profileGapMessage } = require('../services/pitchBriefService');

router.use(requireDashboardToken);

// ── Helper: load match + podcast + client in one go ────────────────────────
async function loadContext(matchId, clientId) {
  const { data: match, error: mErr } = await supabase
    .from('podcast_matches')
    .select('id, podcast_id, client_id')
    .eq('id', matchId)
    .eq('client_id', clientId)
    .single();
  if (mErr || !match) return { error: 'match_not_found' };

  const [{ data: podcast }, { data: client }] = await Promise.all([
    supabase.from('podcasts').select('*').eq('id', match.podcast_id).single(),
    supabase.from('clients').select('*').eq('id', clientId).single(),
  ]);

  if (!podcast) return { error: 'podcast_not_found' };
  if (!client)  return { error: 'client_not_found' };

  return { match, podcast, client };
}

// GET — fetch cached or generate
router.get('/pitch-brief/:matchId', async (req, res) => {
  const { matchId } = req.params;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });

  try {
    const ctx = await loadContext(matchId, req.clientId);
    if (ctx.error) return res.status(404).json({ success: false, error: ctx.error });

    // Try cache first
    const { data: cached } = await supabase
      .from('pitch_briefs')
      .select('*')
      .eq('podcast_id', ctx.match.podcast_id)
      .eq('client_id', ctx.client.id)
      .single();

    if (cached) {
      return res.json({
        success: true,
        cached: true,
        brief: cached.brief_json,
        generated_at: cached.generated_at,
        regenerated_at: cached.regenerated_at,
        regenerate_count: cached.regenerate_count || 0,
        data_quality: cached.data_quality,
        episodes_analyzed_count: cached.episodes_analyzed_count,
      });
    }

    // Profile gate (cheap check before charging credits)
    if (!hasAnglePoweringProfile(ctx.client)) {
      return res.status(412).json({
        success: false,
        error: 'profile_incomplete',
        message: profileGapMessage(ctx.client),
      });
    }

    // Charge 5 credits
    const charge = await chargeCredits(req.clientId, 'pitch_brief', { matchId, podcastId: ctx.match.podcast_id });
    if (!charge.ok) {
      if (charge.error === 'insufficient_credits') {
        return res.status(402).json({ success: false, error: 'insufficient_credits', balance: charge.balance, needed: charge.needed });
      }
      return res.status(500).json({ success: false, error: 'credit_charge_failed' });
    }

    // Generate
    const result = await generateBrief({ podcast: ctx.podcast, client: ctx.client });
    if (!result.ok) {
      // Refund the credit charge by inserting a positive correction transaction.
      // chargeCredits accepts only spend keys; do a direct supabase update for the refund.
      try {
        await supabase
          .from('clients')
          .update({ credits_remaining: (charge.balance || 0) + 5 })
          .eq('id', req.clientId);
        await supabase.from('credit_transactions').insert({
          client_id:     req.clientId,
          action:        'pitch_brief_refund',
          credits_delta: 5,
          points_delta:  0,
          balance_after: (charge.balance || 0) + 5,
          metadata:      { matchId, reason: result.error },
        });
      } catch (_) {}
      return res.status(500).json({ success: false, error: result.error || 'generate_failed', message: result.message });
    }

    // Save
    const row = {
      podcast_id:              ctx.match.podcast_id,
      client_id:               ctx.client.id,
      brief_json:              result.brief,
      episodes_analyzed_count: result.episodes_analyzed_count,
      source_rss_url:          result.source_rss_url,
      data_quality:            result.data_quality,
    };
    const { data: inserted, error: insertErr } = await supabase
      .from('pitch_briefs')
      .insert(row)
      .select()
      .single();

    if (insertErr) {
      logger.warn('pitch_briefs insert failed', { matchId, error: insertErr.message });
      // Still return the brief — generation succeeded, only caching failed
    }

    return res.json({
      success: true,
      cached: false,
      brief: result.brief,
      generated_at: inserted?.generated_at || new Date().toISOString(),
      regenerate_count: 0,
      data_quality: result.data_quality,
      episodes_analyzed_count: result.episodes_analyzed_count,
      credits_remaining: charge.balance,
    });
  } catch (err) {
    logger.error('pitch-brief GET error', { error: err.message });
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// POST regenerate — first one is free, subsequent ones cost 5 credits
router.post('/pitch-brief/:matchId/regenerate', async (req, res) => {
  const { matchId } = req.params;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });

  try {
    const ctx = await loadContext(matchId, req.clientId);
    if (ctx.error) return res.status(404).json({ success: false, error: ctx.error });

    const { data: cached } = await supabase
      .from('pitch_briefs')
      .select('*')
      .eq('podcast_id', ctx.match.podcast_id)
      .eq('client_id', ctx.client.id)
      .single();

    const regenCount = cached?.regenerate_count || 0;
    const isFreeRegen = regenCount === 0;

    if (!isFreeRegen) {
      const charge = await chargeCredits(req.clientId, 'pitch_brief', { matchId, podcastId: ctx.match.podcast_id, regen: true });
      if (!charge.ok) {
        if (charge.error === 'insufficient_credits') {
          return res.status(402).json({ success: false, error: 'insufficient_credits', balance: charge.balance, needed: charge.needed });
        }
        return res.status(500).json({ success: false, error: 'credit_charge_failed' });
      }
    }

    const result = await generateBrief({ podcast: ctx.podcast, client: ctx.client });
    if (!result.ok) {
      return res.status(500).json({ success: false, error: result.error || 'generate_failed', message: result.message });
    }

    if (cached) {
      const { data: updated } = await supabase
        .from('pitch_briefs')
        .update({
          brief_json:              result.brief,
          episodes_analyzed_count: result.episodes_analyzed_count,
          source_rss_url:          result.source_rss_url,
          data_quality:            result.data_quality,
          regenerated_at:          new Date().toISOString(),
          regenerate_count:        regenCount + 1,
        })
        .eq('id', cached.id)
        .select()
        .single();
      return res.json({
        success: true,
        brief: result.brief,
        generated_at: cached.generated_at,
        regenerated_at: updated?.regenerated_at || new Date().toISOString(),
        regenerate_count: regenCount + 1,
        data_quality: result.data_quality,
        episodes_analyzed_count: result.episodes_analyzed_count,
        was_free_regen: isFreeRegen,
      });
    }

    // No prior cache: insert fresh
    const { data: inserted } = await supabase
      .from('pitch_briefs')
      .insert({
        podcast_id:              ctx.match.podcast_id,
        client_id:               ctx.client.id,
        brief_json:              result.brief,
        episodes_analyzed_count: result.episodes_analyzed_count,
        source_rss_url:          result.source_rss_url,
        data_quality:            result.data_quality,
      })
      .select()
      .single();

    return res.json({
      success: true,
      brief: result.brief,
      generated_at: inserted?.generated_at || new Date().toISOString(),
      regenerate_count: 0,
      data_quality: result.data_quality,
      episodes_analyzed_count: result.episodes_analyzed_count,
      was_free_regen: isFreeRegen,
    });
  } catch (err) {
    logger.error('pitch-brief regen error', { error: err.message });
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

module.exports = router;
