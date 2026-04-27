'use strict';

/**
 * Credits + Points System
 *
 * Self-Managed customers: 500 credits/month
 * Tour customers (unlimited_credits=true): never deducted, but still earn points
 *
 * Action cost map (single source of truth — change here, applies everywhere):
 *   pitch_send           -1 credit, +1 point
 *   followup_send        -1 credit, +1 point
 *   thankyou_send        -1 credit, +1 point
 *   ai_generate_pitch    -1 credit, +0 point   (iterating, not new outbound)
 *   ai_generate_followup -1 credit, +0 point
 *   ai_generate_dm       -1 credit, +0 point
 *   ai_generate_thankyou -1 credit, +0 point
 *   interview_prep       -1 credit, +1 point
 *   unlock               -1 credit, +1 point
 *   search_batch         -10 credit (10 podcasts returned), +10 point
 *   stage_search_batch   -5 credit, +5 point
 *   voice_intro_attached  0 credit, +2 point   (free, but rewards effort)
 *   reply_received        0 credit, +10 point  (outcome — no charge, leaderboard signal)
 *   booking_confirmed     0 credit, +50 point  (outcome)
 *   episode_aired         0 credit, +200 point (outcome — biggest weight)
 *   refer_signup          0 credit, +50 point
 *   monthly_reset        +500 credit (reset to 500), 0 point
 *   topup                +N credit, 0 point
 *   leader_bonus         +50 credit, 0 point
 *
 * Points are operator-visible only (leaderboard at /operator/leaderboard).
 * Customers see their credit balance only, never points.
 */

const supabase = require('./supabase');
const logger   = require('./logger');

// ── Action cost map (the single source of truth) ─────────────────────────
const ACTIONS = {
  pitch_send:           { credits: -1,  points: 1  },
  followup_send:        { credits: -1,  points: 1  },
  thankyou_send:        { credits: -1,  points: 1  },
  ai_generate_pitch:    { credits: -1,  points: 0  },
  ai_generate_followup: { credits: -1,  points: 0  },
  ai_generate_dm:       { credits: -1,  points: 0  },
  ai_generate_thankyou: { credits: -1,  points: 0  },
  ai_draft_reply:       { credits: -1,  points: 0  },
  interview_prep:       { credits: -1,  points: 1  },
  unlock:               { credits: -1,  points: 1  },
  search_batch:         { credits: -10, points: 10 },
  stage_search_batch:   { credits: -5,  points: 5  },
  voice_intro_attached: { credits: 0,   points: 2  },
  reply_received:       { credits: 0,   points: 10 },
  booking_confirmed:    { credits: 0,   points: 50 },
  episode_aired:        { credits: 0,   points: 200 },
  refer_signup:         { credits: 0,   points: 50 },
};

/**
 * Charge credits + award points for an action.
 * - If action is a SPEND (negative credits), checks balance first; rejects if insufficient.
 * - Tour customers (unlimited_credits=true) skip the deduction but still log + earn points.
 * - On success, returns { ok: true, balance, points_awarded }.
 * - On insufficient credits, returns { ok: false, error: 'insufficient_credits', needed, balance }.
 *
 * @param {string} clientId  UUID of the client
 * @param {string} action    Key from ACTIONS map
 * @param {object} metadata  Optional JSON to log alongside the transaction
 */
async function chargeCredits(clientId, action, metadata = {}) {
  if (!clientId || !ACTIONS[action]) {
    logger.warn('credits: invalid input', { clientId, action });
    return { ok: false, error: 'invalid_action' };
  }

  const cost = ACTIONS[action];

  try {
    const { data: client, error: fetchErr } = await supabase
      .from('clients')
      .select('id, credits_remaining, unlimited_credits, monthly_points, lifetime_points')
      .eq('id', clientId)
      .single();

    if (fetchErr || !client) {
      logger.error('credits: client not found', { clientId, error: fetchErr?.message });
      return { ok: false, error: 'client_not_found' };
    }

    const isSpend  = cost.credits < 0;
    const isUnlim  = !!client.unlimited_credits;
    const balance  = client.credits_remaining ?? 0;
    const needed   = Math.abs(cost.credits);

    // Spend gate: only check balance if it's a real deduction and customer isn't unlimited
    if (isSpend && !isUnlim && balance < needed) {
      logger.info('credits: insufficient', { clientId, action, needed, balance });
      return { ok: false, error: 'insufficient_credits', needed, balance };
    }

    // Compute new balances
    const newCredits = isUnlim
      ? balance                                  // unlimited customers don't change credit balance
      : balance + cost.credits;                  // negative on spend, positive on top-up
    const newMonthly  = (client.monthly_points  ?? 0) + cost.points;
    const newLifetime = (client.lifetime_points ?? 0) + cost.points;

    // Update client row + log transaction (parallel, both must succeed)
    const [updateRes, logRes] = await Promise.all([
      supabase.from('clients').update({
        credits_remaining: newCredits,
        monthly_points:    newMonthly,
        lifetime_points:   newLifetime,
        last_action_at:    new Date().toISOString(),
      }).eq('id', clientId),
      supabase.from('credit_transactions').insert({
        client_id:     clientId,
        action,
        credits_delta: isUnlim ? 0 : cost.credits,
        points_delta:  cost.points,
        balance_after: newCredits,
        metadata,
      }),
    ]);

    if (updateRes.error) {
      logger.error('credits: client update failed', { clientId, action, error: updateRes.error.message });
      return { ok: false, error: 'update_failed' };
    }
    if (logRes.error) {
      logger.warn('credits: transaction log failed (action proceeded)', { clientId, action, error: logRes.error.message });
    }

    return {
      ok: true,
      balance: newCredits,
      points_awarded: cost.points,
      unlimited: isUnlim,
    };
  } catch (err) {
    logger.error('credits: unexpected error', { clientId, action, error: err.message });
    return { ok: false, error: 'internal_error' };
  }
}

/**
 * Convenience: award only outcome points (no credit change). Used for reply/booking/aired events.
 * Internally calls chargeCredits with the same action key.
 */
async function awardPoints(clientId, action, metadata = {}) {
  return chargeCredits(clientId, action, metadata);
}

/**
 * Get current balance and points for a client.
 */
async function getBalance(clientId) {
  if (!clientId) return null;
  const { data, error } = await supabase
    .from('clients')
    .select('credits_remaining, unlimited_credits, monthly_points, lifetime_points, credits_reset_at')
    .eq('id', clientId)
    .single();
  if (error || !data) return null;
  return {
    credits:        data.credits_remaining ?? 0,
    unlimited:      !!data.unlimited_credits,
    monthly_points: data.monthly_points ?? 0,
    lifetime_points: data.lifetime_points ?? 0,
    resets_at:      data.credits_reset_at,
  };
}

/**
 * Apply a top-up credit pack (Stripe webhook calls this).
 * @param {string} clientId
 * @param {number} amount  Number of credits to add (positive)
 * @param {object} metadata Eg. { stripe_session_id, pack_size, dollars }
 */
async function applyTopUp(clientId, amount, metadata = {}) {
  if (!clientId || !amount || amount <= 0) {
    return { ok: false, error: 'invalid_topup' };
  }

  try {
    const { data: client } = await supabase
      .from('clients').select('credits_remaining, credit_pack_addon').eq('id', clientId).single();
    if (!client) return { ok: false, error: 'client_not_found' };

    const newCredits = (client.credits_remaining ?? 0) + amount;
    const newAddon   = (client.credit_pack_addon ?? 0) + amount;

    await supabase.from('clients').update({
      credits_remaining: newCredits,
      credit_pack_addon: newAddon,
    }).eq('id', clientId);

    await supabase.from('credit_transactions').insert({
      client_id:     clientId,
      action:        'topup',
      credits_delta: amount,
      points_delta:  0,
      balance_after: newCredits,
      metadata,
    });

    logger.info('credits: topup applied', { clientId, amount, newBalance: newCredits });
    return { ok: true, balance: newCredits };
  } catch (err) {
    logger.error('credits: topup error', { clientId, error: err.message });
    return { ok: false, error: 'internal_error' };
  }
}

module.exports = {
  ACTIONS,
  chargeCredits,
  awardPoints,
  getBalance,
  applyTopUp,
};
