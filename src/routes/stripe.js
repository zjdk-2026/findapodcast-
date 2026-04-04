'use strict';

const express  = require('express');
const Stripe   = require('stripe');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

const router = express.Router();

const stripe    = Stripe(process.env.STRIPE_SECRET_KEY);
const PRICE_ID  = process.env.STRIPE_CONTENT_BOOST_PRICE_ID;
const BASE_URL  = process.env.BASE_URL || 'https://findapodcast.club';

// ── Auth helper ───────────────────────────────────────────────────────
async function getClientByToken(token) {
  if (!token) return null;
  const { data } = await supabase
    .from('clients')
    .select('id, name, email, dashboard_token')
    .eq('dashboard_token', token)
    .single();
  return data || null;
}

// ── POST /api/stripe/checkout ─────────────────────────────────────────
// Creates a Stripe Checkout session and returns the URL
router.post('/stripe/checkout', async (req, res) => {
  const token   = req.headers['x-dashboard-token'] || req.body.token;
  const matchId = req.body.matchId || null;

  if (!PRICE_ID) {
    return res.status(500).json({ success: false, error: 'Stripe not configured.' });
  }

  const client = await getClientByToken(token);
  if (!client) {
    return res.status(401).json({ success: false, error: 'Unauthorised.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode:               'payment',
      line_items: [{
        price:    PRICE_ID,
        quantity: 1,
      }],
      customer_email: client.email,
      metadata: {
        client_id:  client.id,
        match_id:   matchId || '',
        token:      token,
      },
      success_url: `${BASE_URL}/dashboard/${token}?boost=success`,
      cancel_url:  `${BASE_URL}/dashboard/${token}?boost=cancelled`,
    });

    logger.info('Stripe checkout session created', { clientId: client.id, sessionId: session.id });
    return res.json({ success: true, url: session.url });
  } catch (err) {
    logger.error('Stripe checkout error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to create checkout session.' });
  }
});

module.exports = router;
