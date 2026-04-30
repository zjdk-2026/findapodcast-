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

// City → country aliases for region-based matching when searching by city.
// Dubai search should also match Abu Dhabi (same country, ~75min drive).
// Sydney search should NOT match Dubai. Etc.
const CITY_TO_COUNTRY = {
  'dubai': 'uae', 'abu dhabi': 'uae', 'sharjah': 'uae', 'ajman': 'uae',
  'sydney': 'australia', 'melbourne': 'australia', 'brisbane': 'australia', 'perth': 'australia', 'gold coast': 'australia',
  'london': 'uk', 'manchester': 'uk', 'birmingham': 'uk', 'edinburgh': 'uk',
  'new york': 'usa', 'brooklyn': 'usa', 'manhattan': 'usa', 'nyc': 'usa',
  'los angeles': 'usa', 'san francisco': 'usa', 'silicon valley': 'usa', 'palo alto': 'usa',
  'austin': 'usa', 'miami': 'usa', 'chicago': 'usa', 'dallas': 'usa', 'boston': 'usa',
  'singapore': 'singapore',
  'hong kong': 'hong kong',
  'toronto': 'canada', 'vancouver': 'canada', 'montreal': 'canada',
  'berlin': 'germany', 'munich': 'germany',
  'paris': 'france',
  'amsterdam': 'netherlands',
  'mumbai': 'india', 'bangalore': 'india', 'delhi': 'india',
};

// Stage matches the searched city if same city, same country (50-mile-radius approx via region), or virtual.
function stageMatchesCity(stage, searchCity) {
  if (!searchCity) return true;
  if (!stage) return false;
  if (stage.is_virtual) return true;

  const sc = searchCity.toLowerCase().trim();
  const stCity = (stage.location_city || '').toLowerCase().trim();
  const stCountry = (stage.location_country || '').toLowerCase().trim();

  if (stCity && (stCity === sc || stCity.includes(sc) || sc.includes(stCity))) return true;

  // Normalise common ISO/full-name variants for country matching
  const COUNTRY_ALIASES = {
    'ae': 'uae', 'united arab emirates': 'uae', 'emirates': 'uae',
    'gb': 'uk', 'united kingdom': 'uk', 'britain': 'uk', 'great britain': 'uk',
    'us': 'usa', 'united states': 'usa', 'america': 'usa',
    'au': 'australia',
    'sg': 'singapore',
    'hk': 'hong kong',
    'ca': 'canada',
    'de': 'germany', 'deutschland': 'germany',
    'fr': 'france',
    'nl': 'netherlands', 'holland': 'netherlands',
    'in': 'india',
  };
  const normaliseCountry = (c) => {
    if (!c) return c;
    const k = c.toLowerCase().trim().replace(/^the /, '').replace(/^united /, '');
    return COUNTRY_ALIASES[k] || COUNTRY_ALIASES[c.toLowerCase()] || k;
  };

  const searchCountry = CITY_TO_COUNTRY[sc];
  if (searchCountry && stCountry && normaliseCountry(stCountry) === searchCountry) return true;

  return false;
}

// GET /api/stages/:token?city=Dubai — returns client + filtered matches (city OR same country OR virtual)
router.get('/api/stages/:token', async (req, res) => {
  const { token } = req.params;
  const cityFilter = (req.query.city || '').trim();
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

    const all = matches || [];
    const filtered = cityFilter ? all.filter(m => stageMatchesCity(m.stages, cityFilter)) : all;

    res.json({
      ok: true,
      client,
      matches: filtered,
      filter: { city: cityFilter || null, total_in_db: all.length, shown: filtered.length },
    });
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

  // Fire-and-forget owner notification. Resend REST API (no SDK installed).
  if (process.env.RESEND_API_KEY) {
    const subject = `New Find A Stage waitlist signup: ${email}`;
    const lines = [
      `<strong>Email:</strong> ${email}`,
      city     ? `<strong>City:</strong> ${city}`         : null,
      industry ? `<strong>Industry / Niche:</strong> ${industry}` : null,
      notes    ? `<strong>Notes:</strong> ${notes}`       : null,
      clientId ? `<strong>Existing client:</strong> Yes (${clientId})` : `<strong>Existing client:</strong> No (anonymous lead)`,
    ].filter(Boolean);
    const html = `<h2>Find A Stage waitlist signup</h2><p>${lines.join('<br>')}</p><p style="color:#888;font-size:12px;">Saved to Supabase stage_waitlist table.</p>`;
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    process.env.RESEND_FROM_EMAIL || 'noreply@findapodcast.io',
        to:      ['hi@zacdeane.com'],
        subject,
        html,
      }),
    }).catch((err) => logger.warn('stage waitlist notify failed', { error: err.message }));
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
