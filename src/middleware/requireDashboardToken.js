'use strict';

const supabase = require('../lib/supabase');

/**
 * Middleware: require a valid dashboard token.
 * Accepts either:
 *   1. x-dashboard-token header (existing — API/operator access)
 *   2. pp_session cookie (new — browser sessions via magic link)
 * Attaches req.clientId if the token is valid.
 */
async function requireDashboardToken(req, res, next) {
  const token = req.headers['x-dashboard-token'] || req.cookies?.pp_session;

  if (!token || token.trim().length < 8) {
    return res.status(401).json({ success: false, error: 'Unauthorised.' });
  }

  const { data: client, error } = await supabase
    .from('clients')
    .select('id')
    .eq('dashboard_token', token)
    .single();

  if (error || !client) {
    return res.status(401).json({ success: false, error: 'Unauthorised.' });
  }

  req.clientId = client.id;
  next();
}

module.exports = requireDashboardToken;
