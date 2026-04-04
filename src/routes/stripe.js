'use strict';

const express  = require('express');
const Stripe   = require('stripe');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

const router = express.Router();

const stripe         = Stripe(process.env.STRIPE_SECRET_KEY);
const PRICE_ID       = process.env.STRIPE_CONTENT_BOOST_PRICE_ID;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const BASE_URL       = process.env.BASE_URL || 'https://findapodcast.club';
const GHL_API_KEY    = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

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

// ── Tag contact in GHL ────────────────────────────────────────────────
async function tagContactInGHL(email, tag) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) return;
  try {
    // Find contact by email
    const searchRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' } }
    );
    const searchData = await searchRes.json();
    const contact = searchData?.contacts?.[0];
    if (!contact) {
      logger.warn('GHL tag: contact not found', { email });
      return;
    }

    // Add tag to contact
    const existingTags = contact.tags || [];
    if (existingTags.includes(tag)) return; // already tagged

    await fetch(`https://services.leadconnectorhq.com/contacts/${contact.id}`, {
      method:  'PUT',
      headers: {
        Authorization:  `Bearer ${GHL_API_KEY}`,
        Version:        '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tags: [...existingTags, tag] }),
    });

    logger.info('GHL contact tagged', { email, tag, contactId: contact.id });
  } catch (err) {
    logger.warn('GHL tag failed', { email, error: err.message });
  }
}

// ── POST /api/stripe/checkout ─────────────────────────────────────────
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
      mode:           'payment',
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      customer_email: client.email,
      metadata: {
        client_id: client.id,
        match_id:  matchId || '',
        token:     token,
        name:      client.name,
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

// ── POST /api/stripe/webhook ──────────────────────────────────────────
// Raw body required — registered before express.json() in server.js
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  if (!WEBHOOK_SECRET) {
    logger.warn('Stripe webhook received but STRIPE_WEBHOOK_SECRET not set');
    return res.status(400).send('Webhook secret not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    logger.warn('Stripe webhook signature verification failed', { error: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── Handle checkout.session.completed ─────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object;
    const clientId = session.metadata?.client_id;
    const email    = session.customer_email || session.customer_details?.email;
    const name     = session.metadata?.name || '';
    const amount   = (session.amount_total / 100).toFixed(2);

    logger.info('Stripe payment completed', { clientId, email, amount });

    // 1. Mark client as content boost purchased in DB
    if (clientId) {
      await supabase
        .from('clients')
        .update({ content_boost_purchased: true })
        .eq('id', clientId);
    }

    // 2. Tag contact in GHL → triggers your GHL workflow/email
    if (email) {
      await tagContactInGHL(email, 'content-boost-purchased');
    }

    logger.info('Content Boost post-payment actions complete', { clientId, email });
  }

  res.json({ received: true });
});

module.exports = router;
