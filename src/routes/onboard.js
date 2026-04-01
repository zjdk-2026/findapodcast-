'use strict';

const express = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

const router = express.Router();

/**
 * POST /api/onboard
 * Onboard a new client into the system.
 *
 * Required body fields: name, email, topics (array)
 * Optional: all other client profile fields
 */
router.post('/onboard', async (req, res) => {
  try {
    const {
      name,
      email,
      topics,
      business_name,
      title,
      bio_short,
      bio_long,
      speaking_angles,
      target_audience,
      target_industries,
      avoid_industries,
      avoid_topics,
      website,
      booking_link,
      lead_magnet,
      social_instagram,
      social_linkedin,
      social_twitter,
      preferred_tone,
      min_show_episodes,
      min_show_age_days,
      max_show_age_days,
      geographies,
      languages,
      daily_target,
      timezone,
    } = req.body;

    // ── Validation ────────────────────────────────────────────
    const errors = [];
    if (!name  || typeof name  !== 'string' || !name.trim())  errors.push('name is required');
    if (!email || typeof email !== 'string' || !email.trim()) errors.push('email is required');
    if (!email?.includes('@')) errors.push('email must be a valid email address');
    if (!topics || !Array.isArray(topics) || topics.length === 0) errors.push('topics must be a non-empty array');

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    // ── Build client record ───────────────────────────────────
    const clientRecord = {
      name:              name.trim(),
      email:             email.trim().toLowerCase(),
      business_name:     business_name     || null,
      title:             title             || null,
      bio_short:         bio_short         || null,
      bio_long:          bio_long          || null,
      topics:            topics,
      speaking_angles:   speaking_angles   || [],
      target_audience:   target_audience   || null,
      target_industries: target_industries || [],
      avoid_industries:  avoid_industries  || [],
      avoid_topics:      avoid_topics      || [],
      website:           website           || null,
      booking_link:      booking_link      || null,
      lead_magnet:       lead_magnet       || null,
      social_instagram:  social_instagram  || null,
      social_linkedin:   social_linkedin   || null,
      social_twitter:    social_twitter    || null,
      preferred_tone:    preferred_tone    || 'warm-professional',
      min_show_episodes: min_show_episodes ?? 20,
      min_show_age_days: min_show_age_days ?? 0,
      max_show_age_days: max_show_age_days ?? 90,
      geographies:       geographies       || ['US', 'CA', 'UK', 'AU'],
      languages:         languages         || ['English'],
      daily_target:      daily_target      || 10,
      timezone:          timezone          || 'America/New_York',
      is_active:         true,
    };

    // ── Insert into Supabase ──────────────────────────────────
    const { data, error } = await supabase
      .from('clients')
      .insert(clientRecord)
      .select()
      .single();

    if (error) {
      // Handle unique constraint on email
      if (error.code === '23505') {
        return res.status(409).json({
          success: false,
          error:   'A client with this email address already exists.',
        });
      }
      logger.error('Failed to insert client', { email, error: error.message });
      return res.status(500).json({ success: false, error: 'Failed to create client record.' });
    }

    const baseUrl   = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const dashboardUrl = `${baseUrl}/dashboard/${data.dashboard_token}`;
    const gmailAuthUrl = `${baseUrl}/auth/gmail?clientId=${data.id}`;

    logger.info('Client onboarded', { clientId: data.id, email: data.email });

    return res.status(201).json({
      success:      true,
      clientId:     data.id,
      dashboardUrl,
      gmailAuthUrl,
      dashboardToken: data.dashboard_token,
    });
  } catch (err) {
    logger.error('Onboard route error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * PATCH /api/onboard/:clientId
 * Update an existing client's profile fields.
 */
const requireDashboardToken = require('../middleware/requireDashboardToken');

router.patch('/onboard/:clientId', requireDashboardToken, async (req, res) => {
  const clientId = req.clientId; // verified token owner — ignore URL param to prevent IDOR

  const allowed = [
    'name', 'title', 'business_name', 'bio_short', 'bio_long',
    'topics', 'speaking_angles', 'target_audience', 'website',
    'booking_link', 'lead_magnet', 'social_instagram', 'social_linkedin',
    'social_twitter', 'preferred_tone', 'daily_target',
  ];

  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key] || null;
  }
  // Keep array fields as arrays
  if (req.body.topics)           updates.topics           = req.body.topics;
  if (req.body.speaking_angles)  updates.speaking_angles  = req.body.speaking_angles;
  if (req.body.daily_target)     updates.daily_target     = parseInt(req.body.daily_target, 10) || 10;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ success: false, error: 'No valid fields to update.' });
  }

  try {
    const { data, error } = await supabase
      .from('clients')
      .update(updates)
      .eq('id', clientId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to update client profile', { clientId, error: error.message });
      return res.status(500).json({ success: false, error: 'Failed to update profile.' });
    }
    if (!data) return res.status(404).json({ success: false, error: 'Client not found.' });

    logger.info('Client profile updated', { clientId });
    return res.json({ success: true, client: data });
  } catch (err) {
    logger.error('Profile update route error', { clientId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
