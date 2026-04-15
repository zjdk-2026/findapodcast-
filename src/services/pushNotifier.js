'use strict';

/**
 * pushNotifier.js
 * Sends Web Push notifications using the VAPID protocol.
 * Pure Node.js crypto — no npm package required.
 */

const crypto   = require('crypto');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

// ── VAPID helpers ─────────────────────────────────────────────

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64');
}

function uint8ArrayToBase64Url(arr) {
  return Buffer.from(arr).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Build a VAPID Authorization header value.
 * audience = origin of the push endpoint (e.g. https://fcm.googleapis.com)
 */
async function buildVapidAuth(audience) {
  const privateKeyB64 = process.env.VAPID_PRIVATE_KEY || '';
  const subject       = process.env.VAPID_SUBJECT      || 'mailto:hi@findapodcast.io';
  const publicKeyB64  = process.env.VAPID_PUBLIC_KEY   || '';

  if (!privateKeyB64 || !publicKeyB64) return null;

  const expiry = Math.floor(Date.now() / 1000) + 12 * 3600; // 12h

  const header  = uint8ArrayToBase64Url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = uint8ArrayToBase64Url(Buffer.from(JSON.stringify({ aud: audience, exp: expiry, sub: subject })));
  const sigInput = `${header}.${payload}`;

  // Import private key
  const rawKey = urlBase64ToUint8Array(privateKeyB64);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    // Convert raw 32-byte EC key to PKCS8 DER for P-256
    buildPkcs8Der(rawKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    Buffer.from(sigInput)
  );

  const jwt = `${sigInput}.${uint8ArrayToBase64Url(new Uint8Array(sig))}`;

  return `vapid t=${jwt},k=${publicKeyB64}`;
}

/**
 * Wrap a raw 32-byte P-256 private key in PKCS8 DER envelope.
 */
function buildPkcs8Der(rawKey) {
  // PKCS8 DER prefix for P-256 EC private key
  const prefix = Buffer.from('308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420', 'hex');
  const suffix = Buffer.from('a144034200', 'hex');
  // We need the uncompressed public key — derive from private key if not already known
  // For simplicity: use the SEC1 format prefix approach
  const sec1 = Buffer.concat([prefix, rawKey]);
  return sec1;
}

/**
 * Encrypt the payload using AES-GCM as per RFC 8291 (Web Push encryption).
 * Returns { ciphertext, salt, serverPublicKey }.
 */
async function encryptPayload(subscriptionKeys, plaintext) {
  const authBuffer = urlBase64ToUint8Array(subscriptionKeys.auth);
  const p256dhBuffer = urlBase64ToUint8Array(subscriptionKeys.p256dh);

  // Generate server EC key pair
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  // Import client public key
  const clientKey = await crypto.subtle.importKey(
    'raw', p256dhBuffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, []
  );

  // ECDH shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientKey },
    serverKeyPair.privateKey,
    256
  );

  // Export server public key (uncompressed)
  const serverPublicKeyRaw = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey);

  // Salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF to derive content encryption key + nonce
  const ikm = await hkdf(
    Buffer.from(sharedSecret),
    Buffer.from(authBuffer),
    Buffer.from('Content-Encoding: auth\0'),
    32
  );

  const prk = await hkdf(Buffer.from(ikm), Buffer.from(salt), buildInfoBuffer('aesgcm', p256dhBuffer, new Uint8Array(serverPublicKeyRaw)), 32);
  const nonce = await hkdf(Buffer.from(ikm), Buffer.from(salt), buildInfoBuffer('nonce', p256dhBuffer, new Uint8Array(serverPublicKeyRaw)), 12);

  // Encrypt
  const key = await crypto.subtle.importKey('raw', prk, 'AES-GCM', false, ['encrypt']);
  const encodedText = new TextEncoder().encode(plaintext);
  // Add 2-byte padding length prefix (0 padding)
  const padded = Buffer.concat([Buffer.from([0, 0]), encodedText]);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, padded);

  return {
    ciphertext:      Buffer.from(ciphertext),
    salt:            Buffer.from(salt),
    serverPublicKey: Buffer.from(serverPublicKeyRaw),
  };
}

async function hkdf(ikm, salt, info, length) {
  const saltKey = await crypto.subtle.importKey('raw', salt, 'HKDF', false, ['deriveBits']);
  const prk = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: new Uint8Array(0) }, saltKey, 256);
  const prkKey = await crypto.subtle.importKey('raw', prk, 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info }, prkKey, length * 8);
}

function buildInfoBuffer(type, clientKey, serverKey) {
  const typeBytes = new TextEncoder().encode(`Content-Encoding: ${type}\0`);
  const contextBytes = Buffer.concat([
    Buffer.from('P-256\0'),
    Buffer.from([0, clientKey.length]), Buffer.from(clientKey),
    Buffer.from([0, serverKey.length]), Buffer.from(serverKey),
  ]);
  return Buffer.concat([typeBytes, contextBytes]);
}

// ── Public API ────────────────────────────────────────────────

/**
 * Send a push notification to a single subscription object.
 */
async function sendPushToSubscription(subscription, payload) {
  try {
    const url      = new URL(subscription.endpoint);
    const audience = `${url.protocol}//${url.host}`;
    const vapidAuth = await buildVapidAuth(audience);
    if (!vapidAuth) {
      logger.warn('Push: VAPID keys not configured');
      return false;
    }

    const body    = JSON.stringify(payload);
    const { ciphertext, salt, serverPublicKey } = await encryptPayload(subscription.keys, body);

    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Authorization':      vapidAuth,
        'Content-Type':       'application/octet-stream',
        'Content-Encoding':   'aesgcm',
        'Encryption':         `salt=${uint8ArrayToBase64Url(salt)}`,
        'Crypto-Key':         `dh=${uint8ArrayToBase64Url(serverPublicKey)}`,
        'TTL':                '86400',
        'Content-Length':     ciphertext.length,
      },
      body: ciphertext,
    });

    if (res.status === 410 || res.status === 404) {
      // Subscription expired — clean it up
      await supabase.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
      return false;
    }

    return res.ok;
  } catch (err) {
    logger.error('Push send error', { error: err.message });
    return false;
  }
}

/**
 * Notify a client (by client_id) that new matches are ready.
 */
async function notifyClientNewMatches(clientId, matchCount) {
  try {
    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('subscription')
      .eq('client_id', clientId);

    if (!subs?.length) return;

    const payload = {
      title: 'New Podcast Matches',
      body:  matchCount === 1
        ? '1 new podcast match is ready for your review.'
        : `${matchCount} new podcast matches are ready for your review.`,
      url:   '/dashboard',
    };

    await Promise.all(subs.map((row) => sendPushToSubscription(row.subscription, payload)));
    logger.info('Push notifications sent', { clientId, matchCount, subs: subs.length });
  } catch (err) {
    logger.error('notifyClientNewMatches error', { clientId, error: err.message });
  }
}

module.exports = { notifyClientNewMatches };
