'use strict';

/**
 * Customer-facing credits routes (NOT points — points are operator-only).
 *
 * GET  /api/credits/balance        — current credit balance + reset date
 * GET  /api/credits/transactions   — last 30 transactions for the customer
 * POST /api/credits/topup-stub     — placeholder for Stripe top-up (returns 501)
 */

const express = require('express');
const supabase = require('../lib/supabase');
const logger = require('../lib/logger');
const { getBalance } = require('../lib/credits');
const requireDashboardToken = require('../middleware/requireDashboardToken');

const router = express.Router();
router.use(requireDashboardToken);

/**
 * GET /api/credits/balance
 * Returns current credit balance, unlimited flag, reset date.
 * Customer dashboard polls this on load to render the counter.
 */
router.get('/credits/balance', async (req, res) => {
  try {
    const balance = await getBalance(req.clientId);
    if (!balance) return res.status(404).json({ ok: false, error: 'client_not_found' });

    // Strip points before returning — customers should NEVER see points
    const { credits, unlimited, resets_at } = balance;
    res.json({ ok: true, credits, unlimited, resets_at });
  } catch (err) {
    logger.error('credits balance error', { error: err.message });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

/**
 * GET /api/credits/transactions
 * Returns the customer's last 30 credit transactions.
 * Used for the "Credits History" panel.
 */
router.get('/credits/transactions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('credit_transactions')
      .select('action, credits_delta, balance_after, metadata, created_at')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) {
      logger.warn('credits transactions fetch failed', { error: error.message });
      return res.status(500).json({ ok: false, error: 'fetch_failed' });
    }

    // Strip points_delta from response so customers can't see point math
    const cleaned = (data || []).map(t => {
      const { points_delta, ...rest } = t;
      return rest;
    });

    res.json({ ok: true, transactions: cleaned });
  } catch (err) {
    logger.error('credits transactions error', { error: err.message });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

/**
 * POST /api/credits/topup-checkout
 * Creates a Stripe Checkout session for a credit top-up pack. The webhook in
 * src/routes/stripe.js detects mode='payment' + metadata.kind='credit_topup'
 * and calls applyTopUp(clientId, credits) when the payment completes.
 *
 * Three packs (inline price_data — no Stripe product setup required):
 *   small  → 50  credits → $25
 *   medium → 200 credits → $80
 *   large  → 500 credits → $175
 */
const TOPUP_PACKS = {
  small:  { credits: 50,  price_aud: 2500,  label: '50 credits'  },
  medium: { credits: 200, price_aud: 8000,  label: '200 credits' },
  large:  { credits: 500, price_aud: 17500, label: '500 credits' },
};
router.post('/credits/topup-checkout', async (req, res) => {
  const pack = (req.body?.pack || '').trim();
  const def  = TOPUP_PACKS[pack];
  if (!def) return res.status(400).json({ ok: false, error: 'invalid_pack' });
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ ok: false, error: 'stripe_not_configured' });
  }
  try {
    const Stripe = require('stripe');
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const baseUrl = process.env.BASE_URL || 'https://findapodcast.io';
    const { data: client } = await supabase.from('clients').select('email, dashboard_token').eq('id', req.clientId).single();
    if (!client) return res.status(404).json({ ok: false, error: 'client_not_found' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'aud',
          unit_amount: def.price_aud,
          product_data: {
            name: `Find A Podcast — ${def.label} top-up`,
            description: `${def.credits} extra pitch credits added to your account immediately on payment.`,
          },
        },
      }],
      customer_email: client.email,
      client_reference_id: req.clientId,
      metadata: {
        kind:       'credit_topup',
        client_id:  req.clientId,
        pack:       pack,
        credits:    String(def.credits),
        token:      client.dashboard_token,
      },
      success_url: `${baseUrl}/dashboard/${client.dashboard_token}?topup=success`,
      cancel_url:  `${baseUrl}/dashboard/${client.dashboard_token}?topup=cancelled`,
    });
    res.json({ ok: true, url: session.url, pack: def });
  } catch (err) {
    logger.error('credits: topup checkout failed', { clientId: req.clientId, pack, error: err.message });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
