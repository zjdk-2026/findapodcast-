'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const supabase = require('../lib/supabase');
const logger = require('../lib/logger');
const { discoverStagesForClient } = require('../services/stageDiscovery');

// ═══════════════════════════════════════════════════════════════════════════
// FIND A STAGE — speaker opportunity routes
// Customer-facing COMING SOON (waitlist capture) + preview dashboard for demos
// ═══════════════════════════════════════════════════════════════════════════

// Preview page — HTML shell served to operator / demo
router.get('/stages/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'dashboard', 'stages-preview.html'));
});

// GET /api/stages/:token — returns client + all stage_matches (sorted by fit desc)
router.get('/api/stages/:token', async (req, res) => {
  const { token } = req.params;
  if (!token || token.length < 8) return res.status(400).json({ ok: false, error: 'invalid_token' });

  try {
    const { data: client, error: cErr } = await supabase
      .from('clients').select('id,name,email,geographies,topics,target_audience,bio_short').eq('dashboard_token', token).single();
    if (cErr || !client) return res.status(404).json({ ok: false, error: 'client_not_found' });

    const { data: matches, error: mErr } = await supabase
      .from('stage_matches')
      .select('*, stages(*)')
      .eq('client_id', client.id)
      .order('fit_score', { ascending: false });

    if (mErr) {
      logger.warn('stage matches fetch failed', { error: mErr.message });
      return res.status(500).json({ ok: false, error: mErr.message });
    }

    res.json({ ok: true, client, matches: matches || [] });
  } catch (err) {
    logger.error('/api/stages/:token error', { error: err.message });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// POST /api/stages/waitlist — coming-soon email capture (unauthenticated)
router.post('/api/stages/waitlist', async (req, res) => {
  const { email, city, industry, notes, clientToken } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  let clientId = null;
  if (clientToken) {
    const { data: c } = await supabase.from('clients').select('id').eq('dashboard_token', clientToken).single();
    if (c) clientId = c.id;
  }

  const { error } = await supabase.from('stage_waitlist').insert({
    client_id: clientId,
    email: email.trim().toLowerCase(),
    city: (city || '').trim() || null,
    industry: (industry || '').trim() || null,
    notes: (notes || '').trim() || null,
  });

  if (error) {
    logger.error('stage_waitlist insert failed', { error: error.message });
    return res.status(500).json({ ok: false, error: 'save_failed' });
  }
  res.json({ ok: true });
});

// POST /api/stages/discover — live discovery via Google Custom Search + Claude extract
router.post('/api/stages/discover', async (req, res) => {
  const { token, city } = req.body || {};
  if (!token || !city) return res.status(400).json({ ok: false, error: 'token_and_city_required' });
  const { data: client } = await supabase.from('clients').select('id').eq('dashboard_token', token).single();
  if (!client) return res.status(404).json({ ok: false, error: 'client_not_found' });
  try {
    const result = await discoverStagesForClient(client.id, city);
    res.json(result);
  } catch (err) {
    logger.error('stage discover failed', { error: err.message });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
