'use strict';

/**
 * LinkedIn OAuth — OpenID Connect (Sign In with LinkedIn)
 * Gives us: name, email, profile photo
 *
 * Required env vars (add in Railway):
 *   LINKEDIN_CLIENT_ID
 *   LINKEDIN_CLIENT_SECRET
 *
 * LinkedIn App setup:
 *   1. Go to https://www.linkedin.com/developers/apps
 *   2. Create app → add product "Sign In with LinkedIn using OpenID Connect"
 *   3. Under Auth tab → add redirect URL: https://findapodcast.io/auth/linkedin/callback
 *   4. Copy Client ID + Client Secret → paste into Railway env vars
 */

const express = require('express');
const crypto  = require('crypto');
const logger  = require('../lib/logger');

const router = express.Router();

const CLIENT_ID     = () => process.env.LINKEDIN_CLIENT_ID     || '';
const CLIENT_SECRET = () => process.env.LINKEDIN_CLIENT_SECRET || '';
const REDIRECT_URI  = () => `${process.env.BASE_URL || 'https://findapodcast.io'}/auth/linkedin/callback`;

const SCOPE = 'openid profile email';

// In-memory state store (single server instance is fine for Railway)
const stateStore = new Map();

/**
 * GET /auth/linkedin
 * Redirect user to LinkedIn OAuth consent screen.
 */
router.get('/auth/linkedin', (req, res) => {
  if (!CLIENT_ID()) {
    return res.redirect('/onboard?linkedin_error=not_configured');
  }

  const state = crypto.randomBytes(16).toString('hex');
  stateStore.set(state, { createdAt: Date.now() });

  // Clean up old states
  for (const [k, v] of stateStore.entries()) {
    if (Date.now() - v.createdAt > 10 * 60 * 1000) stateStore.delete(k);
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CLIENT_ID(),
    redirect_uri:  REDIRECT_URI(),
    state,
    scope:         SCOPE,
  });

  return res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
});

/**
 * GET /auth/linkedin/callback
 * LinkedIn redirects here after user authorises.
 * Exchanges code for token, fetches profile, returns to onboarding with data in query params.
 */
router.get('/auth/linkedin/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    logger.warn('LinkedIn OAuth error', { error });
    return res.redirect('/onboard?linkedin_error=denied');
  }

  if (!state || !stateStore.has(state)) {
    return res.redirect('/onboard?linkedin_error=invalid_state');
  }
  stateStore.delete(state);

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT_URI(),
        client_id:     CLIENT_ID(),
        client_secret: CLIENT_SECRET(),
      }),
    });

    if (!tokenRes.ok) {
      logger.warn('LinkedIn token exchange failed', { status: tokenRes.status });
      return res.redirect('/onboard?linkedin_error=token_failed');
    }

    const { access_token } = await tokenRes.json();

    // Fetch profile via OpenID Connect userinfo endpoint
    const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    if (!profileRes.ok) {
      logger.warn('LinkedIn userinfo fetch failed', { status: profileRes.status });
      return res.redirect('/onboard?linkedin_error=profile_failed');
    }

    const profile = await profileRes.json();

    // profile fields: sub, name, given_name, family_name, email, picture
    const name    = profile.name || `${profile.given_name || ''} ${profile.family_name || ''}`.trim();
    const email   = profile.email || '';
    const picture = profile.picture || '';

    logger.info('LinkedIn import successful', { name, email });

    // Redirect back to onboarding with profile data as query params
    const params = new URLSearchParams();
    if (name)    params.set('li_name',    name);
    if (email)   params.set('li_email',   email);
    if (picture) params.set('li_picture', picture);

    return res.redirect(`/onboard?${params}`);
  } catch (err) {
    logger.error('LinkedIn callback error', { error: err.message });
    return res.redirect('/onboard?linkedin_error=server_error');
  }
});

module.exports = router;
