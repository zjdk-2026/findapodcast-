'use strict';

const express = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

const router = express.Router();

/**
 * Send a welcome email to a newly onboarded client.
 */
async function sendWelcomeEmail(client, dashboardUrl, gmailAuthUrl) {
  const apiKey   = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'hi@findapodcast.club';
  if (!apiKey) return;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px;">
    <div style="text-align:center;margin-bottom:32px;">
      <p style="margin:0 0 8px;color:#6366f1;font-size:13px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;">Find A Podcast</p>
      <h1 style="margin:0 0 12px;color:#f1f5f9;font-size:28px;font-weight:800;">You're in, ${escapeHtml(client.name.split(' ')[0])}.</h1>
      <p style="margin:0;color:#94a3b8;font-size:15px;line-height:1.6;">Your podcast booking pipeline is live. We'll start finding shows that match your topics and send you daily opportunities.</p>
    </div>

    <div style="background:#1e1e2e;border-radius:12px;padding:24px;margin-bottom:24px;border:1px solid #2d2d3f;">
      <h2 style="margin:0 0 8px;color:#e2e8f0;font-size:16px;font-weight:700;">Your Dashboard</h2>
      <p style="margin:0 0 16px;color:#94a3b8;font-size:14px;">Bookmark this link — it's your personal dashboard where all your podcast matches will appear.</p>
      <a href="${dashboardUrl}" style="display:block;background:#6366f1;color:#fff;text-decoration:none;padding:14px 24px;border-radius:8px;font-size:15px;font-weight:700;text-align:center;">Open My Dashboard →</a>
      <p style="margin:12px 0 0;color:#475569;font-size:12px;word-break:break-all;">${dashboardUrl}</p>
    </div>

    <div style="background:#1e1e2e;border-radius:12px;padding:24px;margin-bottom:24px;border:1px solid #2d2d3f;">
      <h2 style="margin:0 0 8px;color:#e2e8f0;font-size:16px;font-weight:700;">Connect Gmail (Optional)</h2>
      <p style="margin:0 0 16px;color:#94a3b8;font-size:14px;">Connect your Gmail so pitches can be sent directly from your inbox. Takes 30 seconds.</p>
      <a href="${gmailAuthUrl}" style="display:block;background:#1e1e2e;color:#6366f1;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;text-align:center;border:1px solid #6366f1;">Connect Gmail →</a>
    </div>

    <div style="background:#1e293b;border-radius:12px;padding:24px;margin-bottom:32px;border:2px solid #6366f1;">
      <h2 style="margin:0 0 8px;color:#e2e8f0;font-size:16px;font-weight:700;">Book Your Free Strategy Session</h2>
      <p style="margin:0 0 16px;color:#94a3b8;font-size:14px;">As a new member, you get a complimentary 60-minute strategy session to optimise your pitch, CTA, and sales funnel. Book your slot below.</p>
      <a href="https://api.leadconnectorhq.com/widget/bookings/60-minute-meeting-with-zac-deane" style="display:block;background:#6366f1;color:#fff;text-decoration:none;padding:14px 24px;border-radius:8px;font-size:15px;font-weight:700;text-align:center;">Book My Strategy Session →</a>
    </div>

    <div style="text-align:center;">
      <p style="margin:0;color:#475569;font-size:12px;">Find A Podcast · findapodcast.club<br>Reply to this email if you need help.</p>
    </div>
  </div>
</body>
</html>`;

  await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    fromEmail,
      to:      [client.email],
      subject: `Welcome to Find A Podcast, ${client.name.split(' ')[0]}! Your dashboard is ready`,
      html,
    }),
  });
}

/**
 * Add a newly onboarded client to GoHighLevel CRM.
 * Creates a contact then adds an opportunity in the Find A Podcast pipeline.
 */
async function addToGHL(client) {
  const apiKey     = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  const pipelineId = process.env.GHL_PIPELINE_ID;

  if (!apiKey || !locationId) {
    logger.warn('GHL not configured — skipping CRM sync');
    return;
  }

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type':  'application/json',
    'Version':       '2021-07-28',
  };

  // 1. Create contact
  let contactRes, contactData;
  try {
    contactRes  = await fetch('https://services.leadconnectorhq.com/contacts/', {
      method:  'POST',
      headers,
      body: JSON.stringify({
        locationId,
        firstName:   client.name.split(' ')[0],
        lastName:    client.name.split(' ').slice(1).join(' ') || '',
        email:       client.email,
        companyName: client.business_name || undefined,
        tags:        ['find-a-podcast', 'new-client'],
        source:      'Find A Podcast Onboarding',
      }),
    });
    contactData = await contactRes.json();
  } catch (fetchErr) {
    logger.error('GHL contact fetch failed', { error: fetchErr.message });
    return;
  }

  logger.info('GHL contact response', { status: contactRes.status, body: JSON.stringify(contactData).slice(0, 300) });

  // GHL v2 returns contact directly or nested under .contact
  const contactId = contactData?.contact?.id || contactData?.id;

  if (!contactId) {
    logger.warn('GHL contact creation failed — no contactId', { status: contactRes.status, response: JSON.stringify(contactData).slice(0, 300) });
    return;
  }

  logger.info('GHL contact created', { contactId, clientId: client.id });

  // 2. Create opportunity in pipeline
  if (!pipelineId) return;

  let oppRes, oppData;
  try {
    oppRes  = await fetch('https://services.leadconnectorhq.com/opportunities/', {
      method:  'POST',
      headers,
      body: JSON.stringify({
        locationId,
        pipelineId,
        name:      `${client.name} — Find A Podcast`,
        contactId,
        status:    'open',
      }),
    });
    oppData = await oppRes.json();
  } catch (oppErr) {
    logger.error('GHL opportunity fetch failed', { error: oppErr.message });
    return;
  }

  logger.info('GHL opportunity response', { status: oppRes.status, body: JSON.stringify(oppData).slice(0, 300) });
  logger.info('GHL opportunity created', { opportunityId: oppData?.opportunity?.id || oppData?.id, clientId: client.id });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

    // Send welcome email (fire-and-forget — don't block the response)
    sendWelcomeEmail(data, dashboardUrl, gmailAuthUrl).catch((err) => {
      logger.warn('Welcome email failed', { clientId: data.id, error: err.message });
    });

    // Add to GHL CRM (fire-and-forget)
    addToGHL(data).catch((err) => {
      logger.warn('GHL sync failed', { clientId: data.id, error: err.message });
    });

    // ── Background discovery — pre-warm matches on signup (fire-and-forget)
    const { discoverPodcasts } = require('../services/discovery');
    setImmediate(async () => {
      try {
        logger.info('Background discovery started for new client', { clientId: data.id });
        const rawPodcasts = await discoverPodcasts(data, { isManual: true });
        logger.info('Background discovery complete', { clientId: data.id, count: rawPodcasts.length });
        // Upsert raw podcasts to the podcasts table so they're cached
        for (const pod of rawPodcasts) {
          await supabase.from('podcasts').upsert({
            external_id: pod.external_id,
            title: pod.title,
            host_name: pod.host_name,
            description: pod.description,
            website: pod.website,
            apple_url: pod.apple_url,
            spotify_url: pod.spotify_url,
            youtube_url: pod.youtube_url,
            category: pod.category,
            niche_tags: pod.niche_tags || [],
            total_episodes: pod.total_episodes,
            last_episode_date: pod.last_episode_date,
            country: pod.country,
            language: pod.language,
            listen_score: pod.listen_score,
            image: pod.image,
            thumbnail: pod.thumbnail,
          }, { onConflict: 'external_id', ignoreDuplicates: true });
        }
        logger.info('Background podcast cache complete', { clientId: data.id, cached: rawPodcasts.length });
      } catch (bgErr) {
        logger.warn('Background discovery failed', { clientId: data.id, error: bgErr.message });
      }
    });

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
