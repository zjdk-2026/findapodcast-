'use strict';

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const { getAuthUrl, verifyState, exchangeCode, checkThreadForReply, findThreadByContactEmail } = require('../services/gmailService');
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
 * Called on dashboard load and polled every 5 minutes. Checks all sent/followed_up
 * matches for Gmail replies. Auto-moves any replied matches to 'replied' status.
 *
 * Detection uses two strategies:
 *  1. Thread message count > 1 (reply came in the same Gmail thread)
 *  2. Inbox search for a message from: the contact email (handles out-of-thread replies)
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

  // Scan both 'sent' AND 'followed_up' matches — a reply can arrive after either
  // Include sent_at so we can scope Gmail search to after the pitch was sent
  const { data: matches } = await supabase
    .from('podcast_matches')
    .select('id, gmail_thread_id, sent_at, podcasts(contact_email)')
    .eq('client_id', client.id)
    .in('status', ['sent', 'followed_up']);

  if (!matches?.length) return res.json({ success: true, updated: [] });

  const updated = [];
  await Promise.all(matches.map(async (m) => {
    let threadId = m.gmail_thread_id;
    const contactEmail = m.podcasts?.contact_email;

    // Fallback: find thread by contact email for older matches missing thread ID
    if (!threadId) {
      if (!contactEmail) return;
      threadId = await findThreadByContactEmail(client.gmail_refresh_token, contactEmail);
      if (threadId) {
        await supabase.from('podcast_matches').update({ gmail_thread_id: threadId }).eq('id', m.id);
        logger.info('Thread ID backfilled', { matchId: m.id, threadId });
      }
    }

    // Strategy 1: check if the known Gmail thread has > 1 message
    let hasReply = false;
    if (threadId) {
      hasReply = await checkThreadForReply(client.gmail_refresh_token, threadId);
    }

    // Strategy 2: if still no reply detected and we have a contact email,
    // search the inbox for any inbound message from that address AFTER the pitch was sent.
    // The after: filter is critical — without it, any historic email from that address
    // would falsely trigger a reply (e.g. your own email address in a test match).
    if (!hasReply && contactEmail) {
      hasReply = await checkInboxForReplyFromEmail(client.gmail_refresh_token, contactEmail, m.sent_at);
    }

    if (hasReply) {
      await supabase.from('podcast_matches').update({ status: 'replied' }).eq('id', m.id);
      updated.push(m.id);
      logger.info('Match auto-moved to replied', { matchId: m.id, contactEmail });
    }
  }));

  return res.json({ success: true, updated });
});

/**
 * checkInboxForReplyFromEmail(refreshToken, fromEmail)
 * Searches Gmail inbox for any message received from fromEmail.
 * Returns true if at least one such message exists.
 */
async function checkInboxForReplyFromEmail(refreshToken, fromEmail, sentAt) {
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Build after: filter from sent_at so we only match replies AFTER the pitch was sent.
    // This prevents false positives from historic emails or self-addressed test matches.
    let afterClause = '';
    if (sentAt) {
      const epochSeconds = Math.floor(new Date(sentAt).getTime() / 1000);
      afterClause = ` after:${epochSeconds}`;
    }

    const res = await gmail.users.messages.list({
      userId: 'me',
      q: `from:${fromEmail} in:inbox${afterClause}`,
      maxResults: 1,
    });
    return (res.data.messages?.length || 0) > 0;
  } catch (err) {
    logger.warn('checkInboxForReplyFromEmail failed', { fromEmail, error: err.message });
    return false;
  }
}

module.exports = router;
