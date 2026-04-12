'use strict';

const crypto = require('crypto');
const logger = require('../lib/logger');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_URL  = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const AUTH_URL   = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';

const SCOPES = [
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
].join(' ');

// ── State signing (same pattern as gmailService) ─────────────────

function stateSecret() {
  const s = process.env.GMAIL_STATE_SECRET || process.env.OPERATOR_KEY;
  if (!s) throw new Error('No secret available for Outlook OAuth state signing');
  return s;
}

function signState(clientId) {
  const ts      = Date.now();
  const payload = `${clientId}:${ts}`;
  const sig     = crypto.createHmac('sha256', stateSecret()).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function verifyState(state) {
  let payload;
  try { payload = Buffer.from(state, 'base64url').toString('utf8'); }
  catch { throw new Error('Invalid OAuth state encoding'); }
  const parts = payload.split(':');
  if (parts.length !== 3) throw new Error('Invalid OAuth state format');
  const [clientId, ts, sig] = parts;
  const expected = crypto.createHmac('sha256', stateSecret()).update(`${clientId}:${ts}`).digest('hex');
  try {
    const sigBuf = Buffer.from(sig, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) throw new Error('sig mismatch');
  } catch { throw new Error('OAuth state signature invalid'); }
  if (Date.now() - parseInt(ts, 10) > 10 * 60 * 1000) throw new Error('OAuth state expired');
  return clientId;
}

// ── OAuth helpers ─────────────────────────────────────────────────

function getAuthUrl(clientId) {
  const redirectUri = process.env.OUTLOOK_REDIRECT_URI;
  if (!process.env.MICROSOFT_CLIENT_ID) throw new Error('MICROSOFT_CLIENT_ID not set');
  if (!redirectUri) throw new Error('OUTLOOK_REDIRECT_URI not set');
  const params = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri:  redirectUri,
    scope:         SCOPES,
    state:         signState(clientId),
    response_mode: 'query',
    prompt:        'select_account',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCode(code) {
  const redirectUri = process.env.OUTLOOK_REDIRECT_URI;
  const body = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    code,
    redirect_uri:  redirectUri,
    grant_type:    'authorization_code',
    scope:         SCOPES,
  });
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Outlook token exchange failed: ${data.error_description || data.error}`);
  return data; // { access_token, refresh_token, expires_in, ... }
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_id:     process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
    scope:         SCOPES,
  });
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Outlook token refresh failed: ${data.error_description || data.error}`);
  return data.access_token;
}

async function getUserEmail(accessToken) {
  const res = await fetch(`${GRAPH_BASE}/me?$select=mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  return data.mail || data.userPrincipalName || null;
}

// ── Send email via Microsoft Graph ───────────────────────────────

async function sendEmail(refreshToken, to, subject, body, linkRow = null) {
  const accessToken = await refreshAccessToken(refreshToken);

  // Build HTML body (same multipart approach as Gmail)
  const htmlBody = body
    .split('\n\n')
    .map(p => `<p style="margin:0 0 14px;line-height:1.7;font-family:sans-serif;font-size:14px;color:#1e293b;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('') +
    (linkRow ? `<p style="margin:18px 0 0;font-size:12px;color:#64748b;font-family:sans-serif;">${linkRow}</p>` : '');

  const message = {
    subject,
    body: {
      contentType: 'HTML',
      content:     htmlBody,
    },
    toRecipients: [{ emailAddress: { address: to } }],
  };

  const res = await fetch(`${GRAPH_BASE}/me/sendMail`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    logger.error('Outlook sendMail failed', { to, status: res.status, error: err?.error?.message });
    throw new Error(`Outlook send failed: ${err?.error?.message || res.status}`);
  }

  logger.info('Email sent via Outlook', { to, subject });
  return { success: true };
}

module.exports = { getAuthUrl, verifyState, exchangeCode, getUserEmail, sendEmail };
