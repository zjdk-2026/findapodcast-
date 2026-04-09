'use strict';

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const requireDashboardToken = require('../middleware/requireDashboardToken');

const router = express.Router();

const OPERATOR_KEY  = process.env.OPERATOR_KEY || 'pipeline2026';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL    = process.env.RESEND_FROM_EMAIL || 'hi@findapodcast.io';
const BASE_URL      = process.env.BASE_URL || 'https://findapodcast.io';

function requireOperatorKey(req, res, next) {
  const key = req.headers['x-operator-key'] || req.query.key;
  if (key !== OPERATOR_KEY) return res.status(401).json({ success: false, error: 'Unauthorized.' });
  next();
}

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) { logger.warn('RESEND_API_KEY not set — skipping email'); return; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
    });
    const data = await res.json();
    if (!res.ok) logger.warn('Resend email failed', { error: data });
    else logger.info('Content Boost email sent', { to, subject });
  } catch (err) {
    logger.warn('Email send error', { error: err.message });
  }
}

/**
 * POST /api/content-boost/request
 * Called when client clicks "Order Content Boost" for a specific match.
 * Sets content_boost_status = 'requested' so Stripe webhook can link it after payment.
 */
router.post('/content-boost/request', requireDashboardToken, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId required.' });

  try {
    const { error } = await supabase
      .from('podcast_matches')
      .update({
        content_boost_status:     'requested',
        content_boost_ordered_at: new Date().toISOString(),
      })
      .eq('id', matchId)
      .eq('client_id', req.clientId);

    if (error) {
      logger.error('content-boost/request failed', { matchId, error: error.message });
      return res.status(500).json({ success: false, error: 'Failed to record request.' });
    }

    logger.info('Content Boost requested', { matchId, clientId: req.clientId });
    return res.json({ success: true });
  } catch (err) {
    logger.error('content-boost/request error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/content-boost/submit-link
 * Client submits the episode URL so the operator team can download and edit it.
 */
router.post('/content-boost/submit-link', requireDashboardToken, async (req, res) => {
  const { matchId, episodeUrl } = req.body;
  if (!matchId)    return res.status(400).json({ success: false, error: 'matchId required.' });
  if (!episodeUrl) return res.status(400).json({ success: false, error: 'episodeUrl required.' });

  try {
    // Fetch match + client + podcast for the notification email
    const { data: match, error: fetchErr } = await supabase
      .from('podcast_matches')
      .select('id, client_id, podcasts(title), clients(name, email)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (fetchErr || !match) return res.status(404).json({ success: false, error: 'Match not found.' });

    // Save episode URL to DB
    const { error: updateErr } = await supabase
      .from('podcast_matches')
      .update({ content_boost_episode_url: episodeUrl })
      .eq('id', matchId)
      .eq('client_id', req.clientId);

    if (updateErr) {
      logger.error('submit-link update failed', { matchId, error: updateErr.message });
      return res.status(500).json({ success: false, error: 'Failed to save link.' });
    }

    // Notify operator team via email
    const clientName   = match.clients?.name  || 'A client';
    const podcastTitle = match.podcasts?.title || 'their episode';

    const html = `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#1D1D1F;">
        <h2 style="font-size:22px;font-weight:800;margin:0 0 16px;">⚡ Episode link submitted</h2>
        <p style="font-size:15px;color:#555;margin:0 0 8px;"><strong>${clientName}</strong> has submitted their episode link for Content Boost.</p>
        <p style="font-size:15px;color:#555;margin:0 0 8px;"><strong>Podcast:</strong> ${podcastTitle}</p>
        <p style="font-size:15px;color:#555;margin:0 0 24px;"><strong>Episode URL:</strong> <a href="${episodeUrl}" style="color:#6366f1;">${episodeUrl}</a></p>
        <p style="font-size:13px;color:#888;">Download and start editing — then mark as complete in the operator panel.</p>
      </div>`;

    await sendEmail({
      to:      FROM_EMAIL,
      subject: `⚡ Episode link submitted — ${clientName} (${podcastTitle})`,
      html,
    });

    logger.info('Content Boost episode link submitted', { matchId, clientId: req.clientId, episodeUrl });
    return res.json({ success: true });
  } catch (err) {
    logger.error('submit-link error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * GET /api/operator/content-boost
 * Returns all pending and completed content boost orders.
 */
router.get('/operator/content-boost', requireOperatorKey, async (req, res) => {
  try {
    const { data: matches, error } = await supabase
      .from('podcast_matches')
      .select('id, content_boost_status, content_boost_ordered_at, content_boost_completed_at, content_boost_episode_url, client_id, podcast_id, podcasts(title, host_name), clients(name, email, dashboard_token)')
      .in('content_boost_status', ['ordered', 'completed', 'requested'])
      .order('content_boost_ordered_at', { ascending: false });

    if (error) {
      logger.error('Operator: content boost fetch failed', { error: error.message });
      return res.status(500).json({ success: false, error: 'Failed to fetch orders.' });
    }

    return res.json({ success: true, orders: matches || [] });
  } catch (err) {
    logger.error('Operator content boost route error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/operator/content-boost/complete
 * Operator marks a content boost order as complete.
 * Sends email to client and sets notified flag.
 */
router.post('/operator/content-boost/complete', requireOperatorKey, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId required.' });

  try {
    // Fetch match + client + podcast info
    const { data: match, error: fetchErr } = await supabase
      .from('podcast_matches')
      .select('id, client_id, podcasts(title), clients(name, email, dashboard_token)')
      .eq('id', matchId)
      .single();

    if (fetchErr || !match) return res.status(404).json({ success: false, error: 'Match not found.' });

    // Mark complete
    const { error: updateErr } = await supabase
      .from('podcast_matches')
      .update({
        content_boost_status:        'completed',
        content_boost_completed_at:  new Date().toISOString(),
        content_boost_notified:      false, // client hasn't seen it yet
      })
      .eq('id', matchId);

    if (updateErr) {
      logger.error('content-boost complete failed', { matchId, error: updateErr.message });
      return res.status(500).json({ success: false, error: 'Failed to update status.' });
    }

    // Send completion email to client
    const client      = match.clients;
    const podcastName = match.podcasts?.title || 'your episode';
    const dashUrl     = `${BASE_URL}/dashboard/${client.dashboard_token}`;

    const html = `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#1D1D1F;">
        <h2 style="font-size:24px;font-weight:800;margin:0 0 8px;letter-spacing:-0.03em;">Your content is ready. 🎉</h2>
        <p style="font-size:15px;color:#555;margin:0 0 24px;">Hey ${(client.name || 'there').split(' ')[0]},</p>
        <p style="font-size:15px;color:#555;margin:0 0 16px;">Your Content Boost for <strong>${podcastName}</strong> is complete.</p>
        <p style="font-size:15px;color:#555;margin:0 0 24px;">Our team has turned your episode into 30 days of content — ready for you to post, schedule, and share with your audience.</p>
        <p style="font-size:15px;color:#555;margin:0 0 8px;">Everything has been delivered to this email address. Check your inbox for the full content pack.</p>
        <div style="margin:32px 0;">
          <a href="${dashUrl}" style="display:inline-block;background:#6366f1;color:#fff;font-weight:700;font-size:14px;padding:14px 28px;border-radius:999px;text-decoration:none;">
            Go to my dashboard
          </a>
        </div>
        <p style="font-size:13px;color:#888;margin:0;">Questions? Reply to this email — we read every message.</p>
        <p style="font-size:13px;color:#888;margin:8px 0 0;">Zac<br>Find A Podcast</p>
      </div>`;

    await sendEmail({
      to:      client.email,
      subject: `Your Content Boost is ready, ${(client.name || 'there').split(' ')[0]} 🎉`,
      html,
    });

    logger.info('Content Boost marked complete', { matchId, clientEmail: client.email });
    return res.json({ success: true });
  } catch (err) {
    logger.error('content-boost/complete error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
