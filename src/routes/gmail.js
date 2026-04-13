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
// Legacy redirect — catches any OAuth flows that had the old /auth/google/callback URI baked in
router.get('/auth/google/callback', (req, res) => {
  res.redirect('/auth/gmail/callback?' + new URLSearchParams(req.query).toString());
});

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
    // If no refresh_token returned (re-auth scenario), redirect with error so user can re-auth properly
    if (!tokens.refresh_token) {
      const { data: existingClient } = await supabase.from('clients').select('gmail_refresh_token, dashboard_token').eq('id', clientId).single();
      if (!existingClient?.gmail_refresh_token) {
        // No existing token either — send them back to re-auth with prompt=consent
        const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
        logger.warn('Gmail OAuth: no refresh_token returned and no existing token', { clientId });
        if (existingClient?.dashboard_token) {
          return res.redirect(`${baseUrl}/dashboard/${existingClient.dashboard_token}?gmailError=reauth_required`);
        }
        return res.status(400).send('Gmail connection failed — please disconnect and reconnect to grant full access.');
      }
      // Already have a refresh token — just update the email
    }
    const updateFields = {};
    if (tokens.refresh_token) updateFields.gmail_refresh_token = tokens.refresh_token;
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
 * getThreadMessageCount(refreshToken, threadId)
 * Returns the number of messages in a Gmail thread. Returns 0 on any error.
 */
async function getThreadMessageCount(refreshToken, threadId) {
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const res = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'minimal',
    });
    return (res.data.messages?.length) || 0;
  } catch (err) {
    logger.warn('getThreadMessageCount failed', { threadId, error: err.message });
    return 0;
  }
}

/**
 * POST /api/gmail/check-replies
 * Called on dashboard load and polled every 5 minutes. Checks all sent/followed_up/replied
 * matches for Gmail replies. Auto-moves any replied matches to 'replied' status.
 * Tracks reply_count (thread message count) and last_reply_at for new-reply detection.
 *
 * Detection uses two strategies:
 *  1. Thread message count > stored reply_count (reply came in the same Gmail thread)
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

  // Return gmailConnected flag so the dashboard can show a warning
  if (!client?.gmail_refresh_token) {
    return res.json({ success: true, updated: [], gmailConnected: false });
  }

  // Scan 'sent', 'followed_up', AND 'replied' matches — keep monitoring replied ones for new messages
  // Include reply_count so we can compare against current thread message count
  const { data: matches } = await supabase
    .from('podcast_matches')
    .select('id, gmail_thread_id, email_subject, sent_at, status, reply_count, podcasts(contact_email, title)')
    .eq('client_id', client.id)
    .in('status', ['sent', 'followed_up', 'replied']);

  if (!matches?.length) return res.json({ success: true, updated: [], gmailConnected: true, checked: 0 });

  const updated = [];

  // Process matches serially to avoid Gmail rate limits (not Promise.all)
  for (const m of matches) {
    try {
      let threadId = m.gmail_thread_id;
      const contactEmail = m.podcasts?.contact_email;
      const storedCount = m.reply_count || 0;

      // Fallback: find thread by contact email for older matches missing thread ID
      if (!threadId && contactEmail) {
        threadId = await findThreadByContactEmail(client.gmail_refresh_token, contactEmail, m.email_subject);
        if (threadId) {
          await supabase.from('podcast_matches').update({ gmail_thread_id: threadId }).eq('id', m.id);
          logger.info('Thread ID backfilled', { matchId: m.id, threadId });
        }
      }

      // Strategy 1: compare current thread message count vs stored reply_count
      let hasReply = false;
      let isNewReply = false;
      let currentThreadCount = 0;
      if (threadId) {
        currentThreadCount = await getThreadMessageCount(client.gmail_refresh_token, threadId);
        if (currentThreadCount > 1) hasReply = true;
        // New reply = thread grew since we last checked
        if (currentThreadCount > storedCount) isNewReply = true;
      }

      // Strategy 2: search inbox for any inbound message from that address AFTER the pitch was sent.
      // The after: filter prevents false positives from historic emails.
      if (!hasReply && contactEmail) {
        hasReply = await checkInboxForReplyFromEmail(client.gmail_refresh_token, contactEmail, m.sent_at);
        if (hasReply && storedCount === 0) isNewReply = true;
      }

      if (hasReply && m.status !== 'replied') {
        // First reply for a sent/followed_up match — move to replied and record count
        const replyFields = { status: 'replied', last_reply_at: new Date().toISOString() };
        if (currentThreadCount > 0) replyFields.reply_count = currentThreadCount;
        else replyFields.reply_count = 1;
        try {
          await supabase.from('podcast_matches').update(replyFields).eq('id', m.id);
        } catch (dbErr) {
          // Fallback if new columns don't exist yet
          await supabase.from('podcast_matches').update({ status: 'replied' }).eq('id', m.id);
          logger.warn('reply_count/last_reply_at columns may be missing', { matchId: m.id, error: dbErr.message });
        }
        updated.push(m.id);
        logger.info('Match auto-moved to replied', { matchId: m.id, contactEmail });
      } else if (hasReply && m.status === 'replied' && isNewReply) {
        // Already replied — but there's a NEW message in the thread since last check
        const updateFields = {
          reply_count: currentThreadCount || (storedCount + 1),
          last_reply_at: new Date().toISOString(),
          // Do NOT touch last_reply_seen_at — only the client sets that
        };
        try {
          await supabase.from('podcast_matches').update(updateFields).eq('id', m.id);
          updated.push(m.id);
          logger.info('New reply detected on already-replied match', { matchId: m.id, newCount: updateFields.reply_count });
        } catch (dbErr) {
          logger.warn('Failed to update reply tracking fields', { matchId: m.id, error: dbErr.message });
        }
      }
    } catch (matchErr) {
      logger.warn('Reply check failed for match', { matchId: m.id, error: matchErr.message });
      // Continue checking other matches
    }
  }

  return res.json({ success: true, updated, gmailConnected: true, checked: matches.length });
});

/**
 * POST /api/mark-reply-seen
 * Called when a card with a new reply is expanded by the client.
 * Sets last_reply_seen_at = now so the pulsing badge goes away.
 */
router.post('/api/mark-reply-seen', async (req, res) => {
  const token = req.headers['x-dashboard-token'] || req.body?.token;
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorised.' });

  const { matchId } = req.body || {};
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId required.' });

  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('dashboard_token', token)
    .single();

  if (!client) return res.status(401).json({ success: false, error: 'Invalid token.' });

  try {
    await supabase
      .from('podcast_matches')
      .update({ last_reply_seen_at: new Date().toISOString() })
      .eq('id', matchId)
      .eq('client_id', client.id);
  } catch (dbErr) {
    logger.warn('mark-reply-seen: last_reply_seen_at column may be missing', { matchId, error: dbErr.message });
  }

  return res.json({ success: true });
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

    // Search all mail (not just inbox) — replies can land in Spam, archived folders, or custom labels.
    // The after: epoch filter already prevents false positives from pre-pitch emails.
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: `from:${fromEmail}${afterClause}`,
      maxResults: 1,
    });
    return (res.data.messages?.length || 0) > 0;
  } catch (err) {
    logger.warn('checkInboxForReplyFromEmail failed', { fromEmail, error: err.message });
    return false;
  }
}

/**
 * POST /api/gmail/disconnect
 * Clears gmail credentials for the client.
 */
router.post('/api/gmail/disconnect', async (req, res) => {
  const token = req.headers['x-dashboard-token'] || req.body?.token;
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized.' });

  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('dashboard_token', token)
    .single();

  if (!client) return res.status(401).json({ success: false, error: 'Invalid token.' });

  await supabase.from('clients').update({
    gmail_refresh_token: null,
    gmail_email: null,
  }).eq('id', client.id);

  logger.info('Gmail disconnected', { clientId: client.id });
  return res.json({ success: true });
});

module.exports = router;
