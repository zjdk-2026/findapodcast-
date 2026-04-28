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
      <h2 style="margin:0 0 8px;color:#e2e8f0;font-size:16px;font-weight:700;">Step 2: Connect Gmail to send your first pitch</h2>
      <p style="margin:0 0 16px;color:#94a3b8;font-size:14px;">Pitches go from your own inbox so hosts reply to you. Takes 30 seconds. Without this you can't send.</p>
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
 * Send a "your matches are ready" email after the first-run pipeline finishes.
 * Drives the customer back to the dashboard so they pitch within the first hour.
 */
async function sendMatchesReadyEmail(client, count) {
  const apiKey   = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'hi@zacdeane.com';
  const baseUrl  = process.env.BASE_URL || 'https://findapodcast.io';
  if (!apiKey || !client?.email) return;
  const dashUrl  = `${baseUrl}/dashboard/${client.dashboard_token}`;
  const firstName = (client.name || 'there').split(' ')[0];
  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111827;line-height:1.55;">
  <h1 style="font-size:22px;font-weight:800;margin:0 0 14px;">Your first matches are ready, ${escapeHtml(firstName)}.</h1>
  <p style="font-size:15px;margin:0 0 20px;color:#374151;">${count > 0 ? `${count} podcasts scored for fit.` : 'Your podcasts are scored.'} Each card has a personalised pitch drafted and ready to send. Open your dashboard, hit Send, get booked.</p>
  <a href="${dashUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:13px 24px;border-radius:10px;font-weight:700;font-size:15px;">Open dashboard</a>
  <p style="font-size:13px;margin:28px 0 0;color:#6b7280;">Tip: pitch your top 5 in the next hour. Customers who pitch in their first day get booked 3x faster.</p>
  <p style="font-size:12px;margin:24px 0 0;color:#9ca3af;">— Find A Podcast</p>
</div>`;
  await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    fromEmail,
      to:      [client.email],
      subject: `${count > 0 ? count + ' podcasts' : 'Your podcasts'} ready to pitch — Find A Podcast`,
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
      contact_email:     null,
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
      email_signature,
      credential,
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
    // The `credential` field is not a column on `clients` — fold it into bio_long
    // (with a "Notable: …" prefix) so the AI pitch-writer still sees it. Adding
    // a real column would require running a migration; keeping it in bio_long
    // ships immediately and the pitch-writer reads from bio_long anyway.
    const bioLongMerged = credential && credential.trim()
      ? `${bio_long ? bio_long.trim() + '\n\n' : ''}Notable: ${credential.trim()}`
      : (bio_long || null);

    // Every new self-serve signup starts in DEMO MODE for 14 days.
    // Dashboard renders redacted matches, action endpoints (send, unlock,
    // add-podcast, book) return 402 demo_locked. Prospect upgrades via the
    // $997 Stripe link, webhook flips demo_mode=false. Existing paying
    // customers are unaffected (they already have rows from before this).
    const DEMO_DURATION_DAYS = 14;
    const demoStart   = new Date();
    const demoExpires = new Date(demoStart.getTime() + DEMO_DURATION_DAYS * 24 * 60 * 60 * 1000);

    const clientRecord = {
      name:              name.trim(),
      email:             email.trim().toLowerCase(),
      business_name:     business_name     || null,
      title:             title             || null,
      bio_short:         bio_short         || null,
      bio_long:          bioLongMerged,
      demo_mode:         true,
      demo_started_at:   demoStart.toISOString(),
      demo_expires_at:   demoExpires.toISOString(),
      // Demo accounts get 50 credits = 5 Find A Podcast clicks (10 podcasts each).
      // Caps the discovery cost while still giving the prospect a real wow moment.
      credits_remaining: 50,
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
      email_signature:   email_signature   || null,
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
      logger.error('Failed to insert client', { email, error: error.message, code: error.code, details: error.details, hint: error.hint });
      return res.status(500).json({
        success: false,
        error: 'Failed to create client record.',
        debug: { message: error.message, code: error.code, hint: error.hint || null },
      });
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

    // ── First-run pipeline ──────────────────────────────────────────────────
    // Demo accounts (the default for /onboard self-serve signups) DO NOT
    // auto-run the pipeline — the prospect clicks "Find a Podcast" themselves
    // during the demo call. That reveal IS the wow moment.
    //
    // Paid/upgraded accounts (created via operator or post-Stripe-unlock)
    // would benefit from the auto-pipeline so they don't wait. For now every
    // self-serve signup is demo, so we skip. Re-enable inside the
    // demo_mode === false branch if/when we add direct-paid signup.
    if (!clientRecord.demo_mode) {
      const { runPipelineForClient } = require('../scheduler');
      setImmediate(async () => {
        try {
          logger.info('First-run pipeline started for new client', { clientId: data.id });
          await runPipelineForClient(data);
          logger.info('First-run pipeline complete', { clientId: data.id });
        } catch (bgErr) {
          logger.warn('First-run pipeline failed', { clientId: data.id, error: bgErr.message });
        }
      });
    }

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
    'social_twitter', 'social_facebook', 'social_youtube', 'preferred_tone', 'daily_target',
    'pitch_style', 'extra_links', 'email_signature',
    'photo_url', 'logo_url',
    'languages', 'geographies',
    'share_with_community',
  ];

  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key] || null;
  }
  // `credential` is not a column on clients — fold into bio_long if provided
  if (req.body.credential && req.body.credential.trim()) {
    const cred = req.body.credential.trim();
    const existing = (req.body.bio_long || updates.bio_long || '').trim();
    updates.bio_long = existing ? `${existing}\n\nNotable: ${cred}` : `Notable: ${cred}`;
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

/**
 * POST /api/detect-socials
 * Scrapes a website URL and returns detected social links + handles.
 * Used by the onboarding form to auto-fill social fields.
 */
router.post('/detect-socials', async (req, res) => {
  const { website } = req.body || {};
  if (!website || typeof website !== 'string') {
    return res.status(400).json({ success: false, error: 'website required' });
  }

  // Normalise URL
  let url = website.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const SOCIAL_PATTERNS = {
    instagram: /instagram\.com\/([a-z0-9_.]{1,30})\/?(?:\?|$|#)/i,
    twitter:   /(?:twitter|x)\.com\/([a-z0-9_]{1,15})\/?(?:\?|$|#)/i,
    linkedin:  /linkedin\.com\/((?:company|in)\/[a-z0-9\-_.%]{2,})\/?(?:\?|$|#)/i,
    facebook:  /facebook\.com\/([a-zA-Z0-9.]{5,})\/?(?:\?|$|#)/i,
  };

  const BLOCKED_HANDLES = new Set([
    'p','reel','reels','share','sharer','intent','home','explore','discover',
    'search','hashtag','accounts','privacy','terms','help','about','login','signup',
  ]);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    let html = '';
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FindAPodcast/1.0)' },
      });
      html = await response.text();
    } finally {
      clearTimeout(timeout);
    }

    const found = {};

    // Extract all href values
    const hrefRegex = /href=["']([^"']+)["']/gi;
    let match;
    while ((match = hrefRegex.exec(html)) !== null) {
      const href = match[1];
      for (const [platform, pattern] of Object.entries(SOCIAL_PATTERNS)) {
        if (found[platform]) continue;
        const m = href.match(pattern);
        if (!m) continue;
        const handle = m[1].split('?')[0].replace(/\/$/, '');
        if (BLOCKED_HANDLES.has(handle.toLowerCase())) continue;
        if (platform === 'instagram' || platform === 'twitter') {
          found[platform] = '@' + handle;
        } else if (platform === 'linkedin') {
          found[platform] = 'https://linkedin.com/' + handle;
        } else {
          found[platform] = 'https://facebook.com/' + handle;
        }
      }
    }

    logger.debug('detect-socials result', { url, found });
    return res.json({ success: true, socials: found });
  } catch (err) {
    // Don't error — just return empty so frontend degrades gracefully
    logger.warn('detect-socials fetch failed', { url, error: err.message });
    return res.json({ success: true, socials: {} });
  }
});

/**
 * POST /api/onboard/prefill
 * Body: { url: 'https://yoursite.com' }
 *
 * Fetches the website, extracts visible text + social links, then asks
 * Claude haiku-4.5 to extract a structured profile. Returns whatever
 * could be confidently determined; missing fields come back as null.
 *
 * Zero hallucination: every field returned must be derivable from the
 * page text. Claude is explicitly instructed not to invent data.
 */
router.post('/onboard/prefill', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: 'invalid_url' });
  }

  // Each phase is wrapped in its own try/catch so a partial failure still
  // returns whatever could be extracted (e.g. socials parsed even if the
  // Claude call fails). Helps pinpoint where prefill is breaking from logs.
  let html = '';
  let text = '';
  const socials = { instagram: null, linkedin: null, twitter: null, facebook: null };

  // ── Phase 1: fetch the page ────────────────────────────────────────────
  try {
    const fetchRes = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FindAPodcastBot/1.0; +https://findapodcast.io)' },
    });
    if (!fetchRes.ok) {
      logger.warn('prefill: fetch returned non-OK', { url, status: fetchRes.status });
      return res.json({ ok: false, error: 'fetch_failed', status: fetchRes.status });
    }
    html = await fetchRes.text();
  } catch (fetchErr) {
    logger.warn('prefill: fetch threw', { url, error: fetchErr.message });
    return res.json({ ok: false, error: 'fetch_failed', message: fetchErr.message });
  }

  // ── Phase 2: strip + truncate ──────────────────────────────────────────
  try {
    text = (html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
  } catch (stripErr) {
    logger.warn('prefill: html strip failed', { url, error: stripErr.message });
    text = '';
  }

  // ── Phase 3: regex-extract social links (always attempted, never fails) ─
  try {
    const findLink = (re) => {
      const m = html.match(re);
      return m ? m[0].split(/['"<>]/)[0] : null;
    };
    socials.instagram = findLink(/https?:\/\/(?:www\.)?instagram\.com\/[a-z0-9_.]{2,30}\/?/i);
    socials.linkedin  = findLink(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|company)\/[a-z0-9\-_.]{2,}\/?/i);
    socials.twitter   = findLink(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[a-z0-9_]{1,15}\/?/i);
    socials.facebook  = findLink(/https?:\/\/(?:www\.)?facebook\.com\/[a-z0-9.\-]{3,}\/?/i);
  } catch (regexErr) {
    logger.warn('prefill: socials regex threw', { url, error: regexErr.message });
  }

  // ── Phase 4: Claude profile extraction ─────────────────────────────────
  // If Claude fails, we still return the socials so the form auto-fills SOMETHING.
  // Better partial than total failure for the customer experience.
  try {
    const anthropic = getAnthropicClient();
    const prompt = `You are extracting a public-speaker profile from a website. Reply with ONLY a JSON object.

Page text (truncated):
${text}

Return:
{
  "name":        "Full name of the person, or null if not clearly stated",
  "title":       "Their professional title (e.g. 'Business Coach & Author'), or null",
  "business":    "Business / brand name, or null",
  "bio_short":   "A one-sentence elevator description of what they do, in their own framing if possible. Under 25 words. Or null.",
  "credential":  "Their single biggest result, accomplishment, or credential as stated on the page. Specific and verifiable. Or null.",
  "bio_long":    "Their full About paragraph (2-4 sentences) lifted from the page if available. Or null.",
  "audience":    "Who they typically work with (their ideal client), if stated. Or null.",
  "topics":      ["array", "of", "topics"]  // up to 6 lowercase topic strings they speak about, e.g. ["leadership","mindset"]. Empty array if unclear.
}

Strict rules:
- Every non-null field MUST be derivable from the page text. Do NOT guess or invent.
- If a field is uncertain or missing, return null (or [] for topics).
- Keep bio_short and credential under 200 characters each.
- Topic strings must be SHORT (1-3 words), lowercase, common terms like 'entrepreneurship' or 'mental health'.`;

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = msg.content?.[0]?.text || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) {
      logger.warn('prefill: claude did not return JSON', { url });
      return res.json({ ok: true, profile: { ...socials } });
    }

    let parsed = {};
    try { parsed = JSON.parse(m[0]); } catch { parsed = {}; }

    const profile = {
      name:       parsed.name        || null,
      title:      parsed.title       || null,
      business:   parsed.business    || null,
      bio_short:  parsed.bio_short   || null,
      credential: parsed.credential  || null,
      bio_long:   parsed.bio_long    || null,
      audience:   parsed.audience    || null,
      topics:     Array.isArray(parsed.topics) ? parsed.topics.slice(0, 6) : [],
      // Socials from anchor parsing (zero-hallucination)
      instagram:  socials.instagram,
      linkedin:   socials.linkedin,
      twitter:    socials.twitter,
      facebook:   socials.facebook,
    };

    logger.info('onboard prefill success', { url, hasProfile: !!profile.name });
    return res.json({ ok: true, profile });
  } catch (claudeErr) {
    // Claude call failed (auth, rate limit, model deprecation, etc.) — log
    // detail to server logs but degrade gracefully: return whatever socials
    // we already extracted so the form still gets some auto-fill.
    logger.warn('prefill: claude extraction failed', {
      url,
      error: claudeErr.message,
      status: claudeErr.status,
      type: claudeErr.constructor?.name,
    });
    return res.json({
      ok: true,
      profile: { ...socials },
      claude_error: claudeErr.message?.slice(0, 200) || 'unknown',
      degraded: true,
    });
  }
});

/**
 * POST /api/onboard/suggest-field
 * Body: { field: 'audience' | 'angles', bio: string, business?: string, title?: string }
 *
 * Generates a draft for the requested field based on the customer's bio.
 * Used by the inline ✨ Suggest from bio buttons in the onboarding form.
 * No credit charge — onboarding flow.
 */
router.post('/onboard/suggest-field', async (req, res) => {
  const { field, bio, business, title } = req.body || {};
  if (!field || !bio || bio.length < 30) {
    return res.status(400).json({ ok: false, error: 'field_and_bio_required (min 30 chars)' });
  }
  if (!['audience', 'angles'].includes(field)) {
    return res.status(400).json({ ok: false, error: 'invalid_field' });
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompts = {
      audience: `Based on this bio, write a single sentence describing this person's IDEAL LISTENER (their target client). Be specific about demographics, psychographics, and the moment they'd seek out this person.

Bio: ${bio.slice(0, 600)}
${title ? `Title: ${title}` : ''}
${business ? `Business: ${business}` : ''}

Output ONE sentence, 15-30 words. No preamble. No em-dashes (use commas, periods, hyphens). Example format: "Female entrepreneurs aged 30-50 struggling with burnout while scaling their business past $250K to $1M."`,

      angles: `Based on this bio, write 2-3 sentences capturing this person's SIGNATURE TALKING POINT — the hot take or contrarian view they'd lead a podcast with.

Bio: ${bio.slice(0, 600)}
${title ? `Title: ${title}` : ''}
${business ? `Business: ${business}` : ''}

Output 2-3 sentences, 60-90 words total. Lead with the hot take, then mention any framework names or signature stories you can infer. No preamble. No em-dashes (use commas, periods, hyphens). Plain text only.`,
    };

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompts[field] }],
    });
    const text = (msg.content?.[0]?.text || '').trim();
    res.json({ ok: true, suggestion: text });
  } catch (err) {
    logger.warn('suggest-field failed', { field, error: err.message });
    res.status(500).json({ ok: false, error: 'suggest_failed' });
  }
});

module.exports = router;
