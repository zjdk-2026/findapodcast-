'use strict';

/**
 * Web Push Notifications
 *
 * Required env vars (generate with: npx web-push generate-vapid-keys):
 *   VAPID_PUBLIC_KEY
 *   VAPID_PRIVATE_KEY
 *   VAPID_SUBJECT  (e.g. mailto:hi@findapodcast.io)
 *
 * Supabase table needed:
 *   push_subscriptions (id uuid pk, client_id uuid fk, endpoint text unique, subscription jsonb, created_at timestamptz)
 */

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

const router = express.Router();

// ── Subscribe ─────────────────────────────────────────────────
router.post('/push/subscribe', async (req, res) => {
  try {
    const token = req.headers['x-dashboard-token'] || '';
    if (!token) return res.status(400).json({ success: false, error: 'Missing token.' });

    const { subscription } = req.body || {};
    if (!subscription?.endpoint) return res.status(400).json({ success: false, error: 'Missing subscription.' });

    const { data: client } = await supabase
      .from('clients')
      .select('id')
      .eq('dashboard_token', token)
      .single();
    if (!client) return res.status(401).json({ success: false, error: 'Invalid token.' });

    // Upsert by endpoint (user may re-subscribe on same browser)
    await supabase.from('push_subscriptions').upsert({
      client_id:    client.id,
      endpoint:     subscription.endpoint,
      subscription: subscription,
    }, { onConflict: 'endpoint' });

    logger.info('Push subscription saved', { clientId: client.id });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Push subscribe error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to save subscription.' });
  }
});

// ── Unsubscribe ───────────────────────────────────────────────
router.post('/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (endpoint) await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
    return res.json({ success: true });
  } catch (err) {
    logger.error('Push unsubscribe error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed.' });
  }
});

// ── VAPID public key (frontend needs it to subscribe) ────────
router.get('/push/vapid-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY || '';
  if (!key) return res.status(503).json({ success: false, error: 'Push not configured.' });
  return res.json({ success: true, publicKey: key });
});

module.exports = router;
