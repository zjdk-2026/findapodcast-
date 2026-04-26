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
 * POST /api/credits/topup-stub
 * Placeholder for Stripe top-up flow. Returns 501 until Stripe is wired.
 */
router.post('/credits/topup-stub', async (req, res) => {
  res.status(501).json({
    ok: false,
    error: 'stripe_not_configured',
    message: 'Top-up packs coming soon. Email hi@zacdeane.com to add credits manually.',
  });
});

module.exports = router;
