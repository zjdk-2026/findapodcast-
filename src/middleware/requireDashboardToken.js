'use strict';

const supabase = require('../lib/supabase');

/**
 * Middleware: require a valid x-dashboard-token header.
 * Attaches req.clientId if the token is valid.
 */
async function requireDashboardToken(req, res, next) {
  const token = req.headers['x-dashboard-token'];
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
