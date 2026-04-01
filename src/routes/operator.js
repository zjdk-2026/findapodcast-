'use strict';

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

const router = express.Router();

const OPERATOR_KEY = 'pipeline2026';

/**
 * Middleware: require x-operator-key header
 */
function requireOperatorKey(req, res, next) {
  const key = req.headers['x-operator-key'];
  if (key !== OPERATOR_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }
  next();
}

/**
 * GET /api/operator/clients
 * Returns all clients with aggregated match counts.
 */
router.get('/clients', requireOperatorKey, async (req, res) => {
  try {
    // Fetch all clients
    const { data: clients, error: clientsError } = await supabase
      .from('clients')
      .select('id, name, email, last_run_at, is_active, dashboard_token')
      .order('onboarded_at', { ascending: false });

    if (clientsError) {
      logger.error('Operator: failed to fetch clients', { error: clientsError.message });
      return res.status(500).json({ success: false, error: 'Failed to fetch clients.' });
    }

    // For each client, get match counts
    const enrichedClients = await Promise.all(
      (clients || []).map(async (client) => {
        const { data: matches, error: mErr } = await supabase
          .from('podcast_matches')
          .select('id, status')
          .eq('client_id', client.id);

        if (mErr) {
          logger.warn('Operator: failed to fetch matches for client', {
            clientId: client.id,
            error: mErr.message,
          });
          return {
            ...client,
            total_matches:  0,
            approved_count: 0,
            sent_count:     0,
            booked_count:   0,
          };
        }

        const all = matches || [];
        return {
          ...client,
          total_matches:  all.length,
          approved_count: all.filter((m) => m.status === 'approved').length,
          sent_count:     all.filter((m) => m.status === 'sent').length,
          booked_count:   all.filter((m) => m.status === 'booked').length,
        };
      })
    );

    // Aggregate totals
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekAgo    = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { count: matchesToday } = await supabase
      .from('podcast_matches')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', todayStart);

    const { count: sentThisWeek } = await supabase
      .from('podcast_matches')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'sent')
      .gte('sent_at', weekAgo);

    return res.json({
      success: true,
      clients: enrichedClients,
      totals: {
        total_clients:    enrichedClients.length,
        matches_today:    matchesToday  || 0,
        sent_this_week:   sentThisWeek  || 0,
      },
    });
  } catch (err) {
    logger.error('Operator clients route error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/operator/toggle-active
 * Body: { clientId, is_active }
 */
router.post('/toggle-active', requireOperatorKey, async (req, res) => {
  const { clientId, is_active } = req.body;
  if (!clientId) return res.status(400).json({ success: false, error: 'clientId is required.' });

  try {
    const { data, error } = await supabase
      .from('clients')
      .update({ is_active: !!is_active })
      .eq('id', clientId)
      .select('id, is_active')
      .single();

    if (error) {
      logger.error('Operator: failed to toggle active', { clientId, error: error.message });
      return res.status(500).json({ success: false, error: 'Failed to update client.' });
    }

    logger.info('Operator: toggled client active', { clientId, is_active });
    return res.json({ success: true, client: data });
  } catch (err) {
    logger.error('Operator toggle-active error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
