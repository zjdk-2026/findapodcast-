'use strict';

// Load env vars first, before any other imports
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

if (!process.env.BASE_URL) process.env.BASE_URL = 'http://localhost:3000';
if (!process.env.GOOGLE_REDIRECT_URI) process.env.GOOGLE_REDIRECT_URI = `${process.env.BASE_URL}/auth/gmail/callback`;

// ── Validate required env vars ───────────────────────────────────────
const REQUIRED_ENV = [
  'ANTHROPIC_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`[FATAL] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const express  = require('express');
const path     = require('path');
const logger   = require('./lib/logger');

// Routes
const onboardRouter   = require('./routes/onboard');
const pipelineRouter  = require('./routes/pipeline');
const dashboardRouter = require('./routes/dashboard');
const actionsRouter   = require('./routes/actions');
const gmailRouter     = require('./routes/gmail');
const operatorRouter  = require('./routes/operator');

// Scheduler
const { initScheduler } = require('./scheduler');

// ── App setup ────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('HTTP', {
      method:   req.method,
      path:     req.path,
      status:   res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
});

// ── Health check ─────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const supabase = require('./lib/supabase');
    const { error } = await supabase.from('clients').select('id').limit(1);
    if (error) throw error;
    res.json({ status: 'ok', db: 'ok', uptime: Math.floor(process.uptime()) });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'unreachable', error: err.message });
  }
});

// ── API Routes ───────────────────────────────────────────────────────
app.use('/api', onboardRouter);
app.use('/api', pipelineRouter);
app.use('/api', dashboardRouter);
app.use('/api', actionsRouter);
app.use('/api/operator', operatorRouter);

// ── Gmail OAuth Routes ───────────────────────────────────────────────
app.use('/', gmailRouter);

// ── Static dashboard ─────────────────────────────────────────────────
// Serve the dashboard/ directory at /dashboard
// The frontend SPA is served for /dashboard/* paths
const dashboardDir = path.join(__dirname, '..', 'dashboard');

app.use('/dashboard', express.static(dashboardDir));

// Catch-all for /dashboard/* — serve index.html for client-side routing
app.get('/dashboard/*', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'index.html'));
});

// Onboard page
app.get('/onboard', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'onboard.html'));
});

// Operator page
app.get('/operator', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'operator.html'));
});

// Root — redirect to onboarding page
app.get('/', (req, res) => {
  res.redirect('/onboard');
});

// ── 404 Handler ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found.' });
});

// ── Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error('Unhandled express error', {
    error: err.message,
    stack: err.stack,
    path:  req.path,
  });
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

// ── Start ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info('Server started', { port: PORT, env: process.env.NODE_ENV || 'development' });

  // Initialise the cron scheduler
  initScheduler();
});

module.exports = app; // for testing
