'use strict';

const { google } = require('googleapis');
const crypto = require('crypto');
const logger = require('../lib/logger');

function stateSecret() {
  const s = process.env.GMAIL_STATE_SECRET || process.env.OPERATOR_KEY;
  if (!s) throw new Error('No secret available for Gmail OAuth state signing');
  return s;
}

function signState(clientId) {
  const ts = Date.now();
  const payload = `${clientId}:${ts}`;
  const sig = crypto.createHmac('sha256', stateSecret()).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function verifyState(state) {
  let payload;
  try {
    payload = Buffer.from(state, 'base64url').toString('utf8');
  } catch {
    throw new Error('Invalid OAuth state encoding');
  }
  const parts = payload.split(':');
  if (parts.length !== 3) throw new Error('Invalid OAuth state format');
  const [clientId, ts, sig] = parts;
  const expected = crypto.createHmac('sha256', stateSecret()).update(`${clientId}:${ts}`).digest('hex');
  try {
    const sigBuf = Buffer.from(sig, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new Error('OAuth state signature invalid');
    }
  } catch (e) {
    throw new Error('OAuth state signature invalid');
  }
  const age = Date.now() - parseInt(ts, 10);
  if (age > 10 * 60 * 1000) throw new Error('OAuth state expired');
  return clientId;
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.readonly',
];

/**
 * Build a Google OAuth2 client with app credentials.
 */
function buildOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/**
 * getAuthUrl(clientId)
 * Generates the Google OAuth 2.0 authorisation URL.
 * state is set to clientId so we can identify the user in the callback.
 */
function getAuthUrl(clientId) {
  const oauth2Client = buildOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    state: signState(clientId),
    prompt: 'consent', // force refresh_token to be returned
  });
}

/**
 * exchangeCode(code)
 * Exchanges an authorisation code for access and refresh tokens.
 * Returns { access_token, refresh_token, expiry_date }.
 */
async function exchangeCode(code) {
  const oauth2Client = buildOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

/**
 * getAccessToken(refreshToken)
 * Uses a stored refresh token to get a fresh access token.
 * Returns the access token string.
 */
async function getAccessToken(refreshToken) {
  const oauth2Client = buildOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const { token } = await oauth2Client.getAccessToken();
  return token;
}

/**
 * Encode a string to base64url format (required by Gmail API).
 */
function toBase64Url(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Build an RFC 2822 MIME message string.
 */
function buildRfc2822Message({ to, subject, body, from }) {
  // RFC 2047 encode subject so Unicode chars (em dash etc.) survive email headers
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const headers = [
    `From: ${from || 'me'}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
  ];
  return headers.join('\r\n');
}

/**
 * createDraft(refreshToken, to, subject, body)
 * Creates a Gmail draft via the Gmail API.
 * Returns the draft id string.
 */
async function createDraft(refreshToken, to, subject, body) {
  try {
    const oauth2Client = buildOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Get the sender's email address for the From header
    let fromEmail = 'me';
    try {
      const profile = await gmail.users.getProfile({ userId: 'me' });
      fromEmail = profile.data.emailAddress || 'me';
    } catch {
      // Fall through — Gmail API accepts 'me' as a special value
    }

    const rawMessage = buildRfc2822Message({ to, subject, body, from: fromEmail });
    const encodedMessage = toBase64Url(rawMessage);

    const response = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw: encodedMessage,
        },
      },
    });

    const draftId = response.data.id;
    logger.info('Gmail draft created', { to, subject, draftId });
    return draftId;
  } catch (err) {
    logger.error('Failed to create Gmail draft', { to, subject, error: err.message });
    throw err;
  }
}

/**
 * sendDraft(refreshToken, draftId)
 * Sends an existing Gmail draft by its draft ID.
 * Returns the sent message data.
 */
async function sendDraft(refreshToken, draftId) {
  try {
    const oauth2Client = buildOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const response = await gmail.users.drafts.send({
      userId: 'me',
      requestBody: { id: draftId },
    });

    logger.info('Gmail draft sent', { draftId, messageId: response.data.id });
    return response.data;
  } catch (err) {
    logger.error('Failed to send Gmail draft', { draftId, error: err.message });
    throw err;
  }
}

/**
 * findThreadByContactEmail(refreshToken, contactEmail)
 * Searches Gmail sent mail for a message to contactEmail, returns threadId or null.
 */
async function findThreadByContactEmail(refreshToken, contactEmail, emailSubject) {
  try {
    const oauth2Client = buildOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    // Scope by subject if available to find the right thread when multiple pitches sent to same address
    const subjectClause = emailSubject ? ` subject:"${emailSubject.replace(/"/g, '')}"` : '';
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: `to:${contactEmail} in:sent${subjectClause}`,
      maxResults: 1,
    });
    const msg = res.data.messages?.[0];
    if (!msg) return null;
    // Get full message to extract threadId
    const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'minimal' });
    return full.data.threadId || null;
  } catch (err) {
    logger.warn('findThreadByContactEmail failed', { contactEmail, error: err.message });
    return null;
  }
}

/**
 * checkThreadForReply(refreshToken, threadId)
 * Returns true if the thread has more than 1 message (i.e. someone replied).
 */
async function checkThreadForReply(refreshToken, threadId) {
  try {
    const oauth2Client = buildOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'minimal' });
    const messages = res.data.messages || [];
    return messages.length > 1;
  } catch (err) {
    logger.warn('checkThreadForReply failed', { threadId, error: err.message });
    return false;
  }
}

module.exports = { getAuthUrl, verifyState, exchangeCode, getAccessToken, createDraft, sendDraft, checkThreadForReply, findThreadByContactEmail };
