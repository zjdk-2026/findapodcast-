'use strict';

// Run in Supabase SQL editor:
// CREATE TABLE magic_links (
//   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
//   client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
//   token text UNIQUE NOT NULL,
//   expires_at timestamptz NOT NULL,
//   used boolean DEFAULT false,
//   created_at timestamptz DEFAULT now()
// );
// CREATE INDEX ON magic_links(token);

const express  = require('express');
const crypto   = require('crypto');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

const router = express.Router();

const MAGIC_LINK_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

/**
 * POST /api/auth/magic-link
 * Generates a one-time magic link token and emails it to the client.
 */
router.post('/magic-link', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ success: false, error: 'Email is required.' });

  try {
    // Look up client by email
    const { data: client, error } = await supabase
      .from('clients')
      .select('id, name, email')
      .eq('email', email.toLowerCase().trim())
      .single();

    // Always return success to avoid email enumeration
    if (error || !client) {
      logger.info('Magic link requested for unknown email', { email });
      return res.json({ success: true });
    }

    // Generate token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MS).toISOString();

    // Store in magic_links table
    await supabase.from('magic_links').insert({
      client_id:  client.id,
      token,
      expires_at: expiresAt,
      used:       false,
    });

    // Send email
    const baseUrl = process.env.BASE_URL || 'https://findapodcast.io';
    const link = `${baseUrl}/api/auth/verify?token=${token}`;
    await sendMagicLinkEmail(client, link);

    logger.info('Magic link sent', { clientId: client.id });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Magic link error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to send link.' });
  }
});

/**
 * GET /api/auth/verify?token=xxx
 * Validates the magic link token and sets a session cookie.
 */
router.get('/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/login?error=invalid');

  try {
    const { data: magicLink, error } = await supabase
      .from('magic_links')
      .select('*, clients(id, dashboard_token)')
      .eq('token', token)
      .eq('used', false)
      .single();

    if (error || !magicLink) return res.redirect('/login?error=invalid');
    if (new Date(magicLink.expires_at) < new Date()) return res.redirect('/login?error=expired');

    // Mark token as used
    await supabase.from('magic_links').update({ used: true }).eq('token', token);

    // Set session cookie (uses dashboard_token as session value — existing auth middleware still works)
    const dashboardToken = magicLink.clients?.dashboard_token;
    if (!dashboardToken) return res.redirect('/login?error=invalid');

    res.cookie('pp_session', dashboardToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
    });

    return res.redirect('/dashboard');
  } catch (err) {
    logger.error('Magic link verify error', { error: err.message });
    return res.redirect('/login?error=invalid');
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
  res.clearCookie('pp_session');
  res.redirect('/login');
});

async function sendMagicLinkEmail(client, link) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'hi@findapodcast.club';
  if (!apiKey) return;

  const firstName = client.name.split(' ')[0];
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px;">
    <div style="text-align:center;margin-bottom:32px;">
      <p style="margin:0 0 8px;color:#6366f1;font-size:13px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;">Find A Podcast</p>
      <h1 style="margin:0 0 8px;color:#0f172a;font-size:24px;font-weight:700;">Your sign-in link</h1>
      <p style="margin:0;color:#64748b;font-size:14px;">Hi ${firstName}, click below to access your dashboard. This link expires in 15 minutes.</p>
    </div>
    <a href="${link}" style="display:block;background:#6366f1;color:#fff;text-decoration:none;padding:16px 24px;border-radius:10px;font-size:16px;font-weight:700;text-align:center;margin-bottom:20px;">Sign in to my dashboard &rarr;</a>
    <p style="color:#94a3b8;font-size:12px;text-align:center;">If you didn't request this, ignore it. Your account is safe.</p>
    <p style="color:#94a3b8;font-size:11px;text-align:center;word-break:break-all;margin-top:8px;">${link}</p>
  </div>
</body>
</html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    fromEmail,
      to:      [client.email],
      subject: 'Your Find A Podcast sign-in link',
      html,
    }),
  });
}

module.exports = router;
