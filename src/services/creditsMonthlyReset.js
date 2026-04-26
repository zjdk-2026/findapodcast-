'use strict';

/**
 * Monthly credits reset + leaderboard snapshot.
 * Fires on the 1st of every month at 00:05 UTC.
 *
 * Steps:
 * 1. Snapshot the current monthly_points leaderboard (ranked).
 * 2. Award +50 bonus credits to ALL clients tied at rank #1 (with monthly_points > 0).
 * 3. Reset every Self-Managed client's credits_remaining to 500 (Tour customers stay unlimited).
 * 4. Zero out monthly_points (lifetime_points stays cumulative).
 * 5. Set credits_reset_at to first of next month.
 */

const supabase = require('../lib/supabase');
const logger = require('../lib/logger');

const MONTHLY_BUDGET = 500;
const LEADER_BONUS = 50;

async function runMonthlyReset() {
  logger.info('Monthly credits reset: starting');

  const now = new Date();
  // The month being snapshotted is the PREVIOUS month (the one that just ended)
  const snapshotDate = new Date(now);
  snapshotDate.setDate(0); // last day of previous month
  const monthYear = `${snapshotDate.getFullYear()}-${String(snapshotDate.getMonth() + 1).padStart(2, '0')}`;

  // 1. Fetch all clients with their monthly_points
  const { data: clients, error: cErr } = await supabase
    .from('clients')
    .select('id, name, email, monthly_points, unlimited_credits, credits_remaining')
    .order('monthly_points', { ascending: false });

  if (cErr) {
    logger.error('Monthly reset: client fetch failed', { error: cErr.message });
    return;
  }

  // 2. Compute ranks (ties share rank)
  let lastPoints = null;
  let lastRank = 0;
  const ranked = (clients || []).map((c, idx) => {
    if (c.monthly_points !== lastPoints) {
      lastRank = idx + 1;
      lastPoints = c.monthly_points;
    }
    return { ...c, rank: lastRank };
  });

  // 3. Identify leaders (rank 1 with monthly_points > 0). All ties get the bonus.
  const leaders = ranked.filter(c => c.rank === 1 && (c.monthly_points || 0) > 0);
  logger.info('Monthly reset: leaders identified', { count: leaders.length, monthYear });

  // 4. Insert leaderboard snapshot rows
  const snapshotRows = ranked.map(c => ({
    month_year:     monthYear,
    client_id:      c.id,
    client_name:    c.name,
    monthly_points: c.monthly_points || 0,
    rank:           c.rank,
    bonus_awarded:  leaders.find(l => l.id === c.id) ? LEADER_BONUS : 0,
  }));

  if (snapshotRows.length > 0) {
    const { error: snapErr } = await supabase.from('monthly_leaderboard').upsert(snapshotRows, { onConflict: 'month_year,client_id' });
    if (snapErr) logger.warn('Monthly reset: snapshot insert had errors', { error: snapErr.message });
  }

  // 5. Apply leader bonus credits + log transaction (only for non-unlimited clients — unlimited customers don't need credits)
  for (const leader of leaders) {
    if (leader.unlimited_credits) {
      logger.info('Monthly reset: leader is unlimited, no bonus credits awarded', { clientId: leader.id });
      continue;
    }
    const newBalance = (leader.credits_remaining || 0) + LEADER_BONUS;
    await supabase.from('clients').update({ credits_remaining: newBalance }).eq('id', leader.id);
    await supabase.from('credit_transactions').insert({
      client_id:     leader.id,
      action:        'leader_bonus',
      credits_delta: LEADER_BONUS,
      points_delta:  0,
      balance_after: newBalance,
      metadata:      { month_year: monthYear, rank: 1, monthly_points: leader.monthly_points },
    });
    logger.info('Monthly reset: leader bonus awarded', { clientId: leader.id, monthYear, balance: newBalance });
  }

  // 6. Reset every client's monthly_points to 0
  // For non-unlimited clients also reset credits_remaining = MONTHLY_BUDGET (500), set credits_reset_at = next month
  const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

  // Non-unlimited reset
  await supabase.from('clients')
    .update({
      credits_remaining: MONTHLY_BUDGET,
      monthly_points:    0,
      credits_reset_at:  nextReset,
    })
    .eq('unlimited_credits', false);

  // Unlimited reset (just zero monthly_points + bump reset date)
  await supabase.from('clients')
    .update({
      monthly_points:    0,
      credits_reset_at:  nextReset,
    })
    .eq('unlimited_credits', true);

  // Log a "monthly_reset" transaction per non-unlimited client for audit trail
  // (kept lightweight — single row per client with the reset event)
  for (const c of ranked) {
    if (c.unlimited_credits) continue;
    await supabase.from('credit_transactions').insert({
      client_id:     c.id,
      action:        'monthly_reset',
      credits_delta: 0,                    // reset is a SET not a DELTA, but we log for audit
      points_delta:  0,
      balance_after: MONTHLY_BUDGET,
      metadata:      { month_year: monthYear, prior_points: c.monthly_points || 0 },
    }).then(() => {}, () => {});
  }

  logger.info('Monthly credits reset: complete', { monthYear, leaders: leaders.length, totalClients: ranked.length });
}

module.exports = { runMonthlyReset };
