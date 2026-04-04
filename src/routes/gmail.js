'use strict';

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const { getAuthUrl, verifyState, exchangeCode, checkThreadForReply } = require('../services/gmailService');
const { google } = require('googleapis');

const router = express.Router();

/**
 * GET /auth/gmail?clientId=XXX
 * Redirects the user to Google's OAuth 2.0 consent screen.
 * The clientId is passed as the OAuth state parameter so we
 * can identify which client is completing the flow in the callback.
 */
router.get('/auth/gmail', (req, res) => {
  const { clientId } = req.query;

  if (!clientId) {
    return res.status(400).send('Missing clientId parameter.');
  }

  try {
    const authUrl = getAuthUrl(clientId);
    logger.info('Redirecting to Google OAuth', { clientId });
    return res.redirect(authUrl);
  } catch (err) {
    logger.error('Failed to generate Google auth URL', { clientId, error: err.message });
    return res.status(500).send('Failed to generate Google auth URL. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }
});

/**
 * GET /auth/gmail/callback
 * Google redirects here after the user grants/denies consent.
 * We exchange the code for tokens, save the refresh token to the client record,
 * then redirect to the client's dashboard.
 */
router.get('/auth/gmail/callback', async (req, res) => {
  const { code, state: rawState, error: oauthError } = req.query;

  if (oauthError) {
    logger.warn('Google OAuth denied by user', { oauthError });
    return res.status(400).send(`Google OAuth failed: ${oauthError}`);
  }

  if (!code || !rawState) {
    return res.status(400).send('Missing code or state in callback.');
  }

  let clientId;
  try {
    clientId = verifyState(rawState);
  } catch (err) {
    logger.warn('Gmail OAuth state verification failed', { error: err.message });
    return res.status(400).send('Invalid or expired OAuth state. Please start the Gmail connection again.');
  }

  try {
    // Exchange code for tokens
    const tokens = await exchangeCode(code);

    if (!tokens.refresh_token) {
      logger.warn('No refresh_token returned from Google — user may have already granted access', {
        clientId,
      });
      // Access token only — we may still proceed but without long-lived access
    }

    // Retrieve the Gmail email address from the access token
    let gmailEmail = null;
    if (tokens.access_token) {
      try {
        const oauth2Client = new (require('googleapis').google.auth.OAuth2)(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          process.env.GOOGLE_REDIRECT_URI
        );
        oauth2Client.setCredentials(tokens);
        const oauth2 = require('googleapis').google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        gmailEmail = userInfo.data.email || null;
      } catch (emailErr) {
        logger.warn('Could not fetch Gmail email address', { clientId, error: emailErr.message });
      }
    }

    // Save refresh token and email to client record
    const updateFields = {};
    if (tokens.refresh_token) updateFields.gmail_refresh_token = tokens.refresh_token;
    // Always mark gmail as connected — use actual email or a fallback so the
    // frontend can detect connection even if userInfo call failed
    updateFields.gmail_email = gmailEmail || 'connected';

    if (Object.keys(updateFields).length > 0) {
      const { error: updateError } = await supabase
        .from('clients')
        .update(updateFields)
        .eq('id', clientId);

      if (updateError) {
        logger.error('Failed to save Gmail tokens to client', {
          clientId,
          error: updateError.message,
        });
        return res.status(500).send('Failed to save Gmail credentials. Please try again.');
      }
    }

    logger.info('Gmail OAuth complete', { clientId, gmailEmail });

    // Fetch dashboard token for redirect
    const { data: client } = await supabase
      .from('clients')
      .select('dashboard_token')
      .eq('id', clientId)
      .single();

    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

    if (client?.dashboard_token) {
      return res.redirect(`${baseUrl}/dashboard/${client.dashboard_token}?gmailConnected=true`);
    }

    return res.send('Gmail connected successfully! You can close this window.');
  } catch (err) {
    logger.error('Gmail OAuth callback error', { clientId, error: err.message, stack: err.stack });
    return res.status(500).send('Gmail OAuth failed. Please try again.');
  }
});

/**
 * POST /api/gmail/check-replies
 * Called on dashboard load. Checks all sent matches for Gmail replies.
 * Auto-moves any replied matches to 'replied' status.
 */
router.post('/api/gmail/check-replies', async (req, res) => {
  const token = req.headers['x-dashboard-token'] || req.body.token;
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorised.' });

  const { data: client } = await supabase
    .from('clients')
    .select('id, gmail_refresh_token')
    .eq('dashboard_token', token)
    .single();

  if (!client?.gmail_refresh_token) return res.json({ success: true, updated: [] });

  // Get all sent matches with a thread ID that haven't already moved on
  const { data: matches } = await supabase
    .from('podcast_matches')
    .select('id, gmail_thread_id')
    .eq('client_id', client.id)
    .eq('status', 'sent')
    .not('gmail_thread_id', 'is', null);

  if (!matches?.length) return res.json({ success: true, updated: [] });

  const updated = [];
  await Promise.all(matches.map(async (m) => {
    const hasReply = await checkThreadForReply(client.gmail_refresh_token, m.gmail_thread_id);
    if (hasReply) {
      await supabase.from('podcast_matches').update({ status: 'replied' }).eq('id', m.id);
      updated.push(m.id);
      logger.info('Match auto-moved to replied', { matchId: m.id });
    }
  }));

  return res.json({ success: true, updated });
});

module.exports = router;
