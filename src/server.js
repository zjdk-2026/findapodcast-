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
const authRouter      = require('./routes/auth');
const onboardRouter   = require('./routes/onboard');
const pipelineRouter  = require('./routes/pipeline');
const dashboardRouter = require('./routes/dashboard');
const actionsRouter   = require('./routes/actions');
const gmailRouter     = require('./routes/gmail');
const operatorRouter  = require('./routes/operator');
const followupRouter  = require('./routes/followup');

// Scheduler
const { initScheduler } = require('./scheduler');

// ── App setup ────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Stripe webhook (raw body — must be before express.json) ──────────
app.use('/api/stripe/webhook', require('./routes/stripe'));

// ── Middleware ───────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(require('cookie-parser')()); // npm install cookie-parser (if not already installed)

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
// Always returns 200 so Railway healthcheck passes as long as Node is running.
// DB status is reported informatively but never blocks the response.
app.get('/health', async (req, res) => {
  let dbStatus = 'unchecked';
  try {
    const supabase = require('./lib/supabase');
    const dbCheck  = supabase.from('clients').select('id').limit(1);
    const timeout  = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000));
    const { error } = await Promise.race([dbCheck, timeout]);
    dbStatus = error ? `error: ${error.message}` : 'ok';
  } catch (err) {
    dbStatus = `error: ${err.message}`;
  }
  // Always 200 — app is alive regardless of DB latency
  res.json({ status: 'ok', db: dbStatus, uptime: Math.floor(process.uptime()) });
});

// ── API Routes ───────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api', onboardRouter);
app.use('/api', pipelineRouter);
app.use('/api', dashboardRouter);
app.use('/api/operator', operatorRouter);
app.use('/api',          require('./routes/manual-podcast')); // add-podcast + re-enrich for both operator and client dashboard
app.use('/api', followupRouter);
app.use('/api', require('./routes/lead-scraper'));
app.use('/api', require('./routes/pitch'));
app.use('/api', require('./routes/stripe'));
app.use('/api', require('./routes/contentBoost'));
app.use('/api/operator', require('./routes/contentBoost'));
app.use('/api', actionsRouter);
app.use('/api', require('./routes/vision-board'));
app.use('/api', require('./routes/leaderboard'));
app.use(require('./routes/upload'));

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

// Login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/login.html'));
});

// Dashboard (no token in URL — auth via cookie)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/index.html'));
});

// Onboard page
app.get('/onboard', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'onboard.html'));
});

// Privacy policy
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'privacy.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'terms.html'));
});

app.get('/admin/review', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'admin-review.html'));
});

app.get('/pitch-deck', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'pitch-deck.html'));
});

// Operator page
app.get('/operator', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'operator.html'));
});

// Root — landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'landing.html'));
});

app.get('/book-demo', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'book-demo.html'));
});

app.get('/demo-confirmed', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'demo-confirmed.html'));
});

app.get('/welcome', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'welcome.html'));
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
