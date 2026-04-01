'use strict';

const { google } = require('googleapis');
const logger = require('../lib/logger');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.labels',
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
    state: clientId,
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
  const headers = [
    `From: ${from || 'me'}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    body,
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

module.exports = { getAuthUrl, exchangeCode, getAccessToken, createDraft, sendDraft };
