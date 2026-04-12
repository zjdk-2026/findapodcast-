'use strict';

const express = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const { getClient: getAnthropicClient } = require('../lib/anthropic');
const { scorePodcast } = require('../services/scoring');

const router = express.Router();

/**
 * POST /api/onboard/generate-bio
 * Generates a 3rd-person pitch bio from name, title, and business fields.
 */
router.post('/generate-bio', async (req, res) => {
  const { name, title, business } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    const anthropic = getAnthropicClient();
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Write a 2–3 sentence third-person podcast guest pitch bio for:
Name: ${name}
Role/Title: ${title || 'Expert'}
Business: ${business || ''}

Rules:
- Write in third person (use their name)
- Sound credible, warm, and impressive without being braggy
- Leave placeholders like [X clients] or [mention a result] where specific numbers/achievements would go
- Do NOT mention podcasts in the bio itself
- Return ONLY the bio text, no quotes, no labels`,
      }],
    });
    const bio = msg.content[0]?.text?.trim() || '';
    return res.json({ bio });
  } catch (err) {
    logger.warn('Bio generation failed — returning template', { error: err.message });
    // Return a fill-in-the-blanks template so the user is never blocked
    const fallback = `${name} is ${title ? `a ${title}` : 'an expert'} who helps [describe who you help] achieve [describe the result]. ${business ? `Through ${business}, they` : 'They'} have [mention a key result or credential]. [Add one more sentence about your approach or a notable achievement.]`;
    return res.json({ bio: fallback });
  }
});

/**
 * Send a welcome email to a newly onboarded client.
 */
async function sendWelcomeEmail(client, dashboardUrl, gmailAuthUrl) {
  const apiKey   = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'hi@zacdeane.com';
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
      <p style="margin:0;color:#475569;font-size:12px;">Find A Podcast · findapodcast.io<br>Reply to this email if you need help.</p>
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
 * Seed The Breakthrough Moment as a real, fully-functional match for every new client.
 * Contact email = hi@zacdeane.com so pitches go to Zac for live demos.
 */
async function seedBreakthroughMatch(clientId) {
  try {
    // 0. Fetch client so we can generate personalised scoring
    const { data: client } = await supabase
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .single();

    // 1. Upsert podcast record
    const podcastRecord = {
      external_id:       'breakthrough-moment-zac-deane',
      title:             'The Breakthrough Moment Podcast',
      host_name:         'Zac Deane',
      description:       'The Breakthrough Moment Podcast features conversations with entrepreneurs, leaders, and change-makers sharing the defining moments that transformed their business and life.',
      website:           'https://www.zacdeane.com',
      apple_url:         'https://podcasts.apple.com/au/podcast/the-breakthrough-moment/id1527264956',
      spotify_url:       'https://open.spotify.com/show/7FBW99BOy9CavEse731bK5',
      youtube_url:       'https://www.youtube.com/playlist?list=PLRHjY10LU557fNgJU32VrLGQQnAk8s_LP',
      category:          'Entrepreneurship',
      niche_tags:        ['entrepreneurship', 'business', 'mindset', 'leadership'],
      total_episodes:    488,
      last_episode_date: new Date(Date.now() - 2 * 86400000).toISOString(),
      country:           'AU',
      language:          'English',
      listen_score:      50,
      contact_email:     'hi@zacdeane.com',
      booking_page_url:  'https://api.leadconnectorhq.com/widget/bookings/meeting-with-zac-deane-15-minute',
    };

    const { data: podcast, error: podError } = await supabase
      .from('podcasts')
      .upsert(podcastRecord, { onConflict: 'external_id' })
      .select('id')
      .single();

    if (podError || !podcast) {
      logger.warn('seedBreakthroughMatch: podcast upsert failed', { error: podError?.message });
      return;
    }

    // 2. Check if match already exists for this client
    const { data: existing } = await supabase
      .from('podcast_matches')
      .select('id')
      .eq('client_id', clientId)
      .eq('podcast_id', podcast.id)
      .single();

    if (existing) return; // already seeded

    // 3. Score the podcast against the client's real profile (fire and handle gracefully)
    let scoring = {
      fit_score:            98,
      booking_likelihood:   'high',
      relevance_score:      98,
      audience_score:       95,
      recency_score:        100,
      reach_score:          90,
      contactability_score: 100,
      brand_score:          90,
      seo_score:            75,
      guest_quality_score:  90,
      why_this_client_fits: null,
      best_pitch_angle:     null,
      show_summary:         null,
      episode_to_reference: null,
      red_flags:            null,
    };

    if (client) {
      try {
        const podcastForScoring = { ...podcastRecord, id: podcast.id };
        const scored = await scorePodcast(podcastForScoring, client);
        scoring = { ...scoring, ...scored };
      } catch (err) {
        logger.warn('seedBreakthroughMatch: scoring failed, using defaults', { error: err.message });
      }
    }

    // 4. Insert match
    const { error: matchError } = await supabase
      .from('podcast_matches')
      .insert({
        client_id:            clientId,
        podcast_id:           podcast.id,
        status:               'new',
        fit_score:            scoring.fit_score,
        booking_likelihood:   scoring.booking_likelihood,
        relevance_score:      scoring.relevance_score,
        audience_score:       scoring.audience_score,
        recency_score:        scoring.recency_score,
        reach_score:          scoring.reach_score,
        contactability_score: scoring.contactability_score,
        brand_score:          scoring.brand_score,
        seo_score:            scoring.seo_score,
        guest_quality_score:  scoring.guest_quality_score,
        why_this_client_fits: scoring.why_this_client_fits,
        best_pitch_angle:     scoring.best_pitch_angle,
        show_summary:         scoring.show_summary,
        episode_to_reference: scoring.episode_to_reference,
        red_flags:            scoring.red_flags,
      });

    if (matchError) {
      logger.warn('seedBreakthroughMatch: match insert failed', { error: matchError.message });
    } else {
      logger.info('seedBreakthroughMatch: seeded successfully', { clientId });
    }
  } catch (err) {
    logger.warn('seedBreakthroughMatch: unexpected error', { error: err.message });
  }
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
        customFields: [
          {
            key:   'dashboard_url',
            field_value: `${process.env.BASE_URL || 'https://findapodcast.io'}/dashboard/${client.dashboard_token}`,
          },
        ],
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
        pipelineStageId: process.env.GHL_STAGE_ID || '2023867b-46fe-4f3f-b00c-8e242653974f',
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
      social_facebook,
      preferred_tone,
      min_show_episodes,
      min_show_age_days,
      max_show_age_days,
      geographies,
      languages,
      daily_target,
      timezone,
      pitch_style,
      extra_links,
      photo_url,
      logo_url,
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
      social_facebook:   social_facebook   || null,
      preferred_tone:    preferred_tone    || 'warm-professional',
      min_show_episodes: min_show_episodes ?? 20,
      min_show_age_days: min_show_age_days ?? 0,
      max_show_age_days: max_show_age_days ?? 90,
      geographies:       geographies       || ['US', 'CA', 'UK', 'AU'],
      languages:         languages         || ['English'],
      daily_target:      daily_target      || 10,
      timezone:          timezone          || 'America/New_York',
      pitch_style:       pitch_style       || null,
      extra_links:       extra_links       || null,
      is_active:         true,
      photo_url:         photo_url         || null,
      logo_url:          logo_url          || null,
    };

    // ── Insert into Supabase ──────────────────────────────────
    const { data, error } = await supabase
      .from('clients')
      .insert(clientRecord)
      .select()
      .single();

    if (error) {
      // If email already exists, look up existing client and return their token
      // so going back and re-submitting resumes the flow instead of erroring
      if (error.code === '23505') {
        const { data: existing } = await supabase
          .from('clients')
          .select('id, dashboard_token')
          .eq('email', email)
          .single();
        if (existing) {
          const baseUrl2 = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
          return res.json({
            success:    true,
            clientId:   existing.id,
            dashboardToken: existing.dashboard_token,
            gmailAuthUrl:   `${baseUrl2}/auth/gmail?clientId=${existing.id}`,
          });
        }
        return res.status(409).json({ success: false, error: 'A client with this email address already exists.' });
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

    // Seed Breakthrough Moment demo match (fire-and-forget)
    seedBreakthroughMatch(data.id).catch((err) => {
      logger.warn('Breakthrough match seed failed', { clientId: data.id, error: err.message });
    });

    // Fire and forget vision board generation
    if (data.best_in_world_at || data.life_purpose) {
      const { generateVisionBoard } = require('../services/visionBoard');
      generateVisionBoard(data.id).catch(err => logger.warn('Vision board generation failed', { error: err.message }));
    }

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
    'name', 'title', 'business_name', 'bio_short',
    'topics', 'speaking_angles', 'target_audience', 'website',
    'booking_link', 'lead_magnet', 'social_instagram', 'social_linkedin',
    'social_twitter', 'social_facebook', 'preferred_tone', 'daily_target',
    'pitch_style', 'extra_links', 'email_signature',
    'photo_url', 'logo_url',
    'languages', 'geographies',
  ];

  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key] || null;
  }
  // Keep array fields as arrays
  if (req.body.topics)           updates.topics           = req.body.topics;
  if (req.body.speaking_angles)  updates.speaking_angles  = req.body.speaking_angles;
  if (req.body.daily_target)     updates.daily_target     = parseInt(req.body.daily_target, 10) || 10;
  if (req.body.languages)        updates.languages        = req.body.languages;
  if (req.body.geographies)      updates.geographies      = req.body.geographies;

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
      return res.status(500).json({ success: false, error: `DB error: ${error.message}` });
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
