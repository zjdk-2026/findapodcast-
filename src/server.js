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
const enrichAIRouter  = require('./routes/enrich-ai');
const artworkRouter   = require('./routes/artwork');
const appleEnrichRouter = require('./routes/apple-enrich');

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
// Mount NON-auth-requiring routers FIRST so they handle their own paths
// before actionsRouter's requireDashboardToken middleware blanket-401s them.
app.use('/', require('./routes/agency'));
app.use('/', require('./routes/stages'));
app.use('/', require('./routes/referral'));
app.use('/api', require('./routes/inbound-email')); // Resend webhook — no auth, must be first

app.use('/api/auth', authRouter);
app.use('/api', onboardRouter);
app.use('/api', pipelineRouter);
app.use('/api', dashboardRouter);
app.use('/api/operator', operatorRouter);
app.use('/api',          require('./routes/manual-podcast')); // add-podcast + re-enrich for both operator and client dashboard
app.use('/api', followupRouter);
app.use('/api', require('./routes/pitchBrief'));
app.use('/api', require('./routes/lead-scraper'));
app.use('/api', require('./routes/pitch'));
app.use('/api', require('./routes/credits'));
app.use('/api', require('./routes/thread'));
app.use('/api', require('./routes/templates'));
app.use('/api', require('./routes/stripe'));
app.use('/api', require('./routes/contentBoost'));
app.use('/api/operator', require('./routes/contentBoost'));
app.use('/api', actionsRouter);
app.use('/api', require('./routes/vision-board'));
app.use('/api', require('./routes/leaderboard'));
app.use('/api', require('./routes/push'));
app.use('/api', require('./routes/unlock'));
app.use('/api', enrichAIRouter);
app.use('/api', artworkRouter);
app.use('/api', appleEnrichRouter);
app.use(require('./routes/upload'));

// ── ElevenLabs TTS — cached per server lifecycle ─────────────────────
let _ttsCache = null;
app.get('/api/tts', async (req, res) => {
  try {
    if (_ttsCache) {
      res.set('Content-Type', 'audio/mpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(_ttsCache);
    }
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return res.status(503).json({ error: 'TTS not configured' });

    const script = `
      Your Zoom demo is confirmed and this page is your prep before we meet.
      Most people who try podcast guesting hit the same wall.
      They find a few shows, send a pitch, forget to follow up, lose track of who replied,
      and three months later have nothing to show for it.
      It is not a talent problem. It is an organisation problem. One system fixes it.
      We run everything. Research, outreach, follow up, scheduling. You show up and record. That is your only job.
      We have three ways to work together.
      Option one: Self-Managed. You get the full Find A Podcast system.
      We find the shows, write the pitches, and queue everything up. You approve before anything goes out. Cancel anytime.
      Option two: Podcast Tour. We do everything for you. Twenty booked podcast appearances in your niche.
      Includes a custom media kit, story session, episode topics built around your offer, a branded sales funnel and lead magnet to share on every show.
      If we do not hit twenty bookings in ninety days, we keep working at no extra charge.
      Option three: Podcast Tour plus Content Engine. Everything in the tour, plus fifteen to thirty pieces of content per episode.
      Short videos, quote cards, threads, and articles. All written in your brand voice, not generic templates. Built for every platform you are on, not just one.
      Three hundred to six hundred pieces of content across the full tour.
      Every client gets a dedicated strategist who works with them before and after every recording
      to make sure they walk away with maximum impact and turn every appearance into real business results.
      The guarantees: Self-Managed, book four shows in month one or your next month is free.
      Podcast Tour, twenty bookings in ninety days or we keep working at no extra charge. The final payment only lands when booking twenty is confirmed.
      Why this works: podcast guesting is the highest trust marketing channel available today.
      The host has already built credibility with the audience. When they bring you on, that trust transfers instantly. You are not advertising. You are being endorsed.
      We will cover which option fits best on the Zoom. Come ready to talk about your niche and your goal. See you there.
    `.trim();

    const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM', {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: script,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
    if (!r.ok) return res.status(502).json({ error: `ElevenLabs error ${r.status}` });
    _ttsCache = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(_ttsCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Public static files (served before catch-alls) ───────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── LinkedIn OAuth Routes ────────────────────────────────────────────
// LinkedIn import route removed Apr 26 2026 — replaced with website auto-fill via Claude.

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

app.get('/podcast-tour-overview', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'pitch-deck.html'));
});

app.get('/self-managed-overview', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'self-managed-overview.html'));
});

app.get('/proposal', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'proposal.html'));
});

// Operator page
app.get('/operator', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'operator.html'));
});

// Root — host-aware landing
// thepodcasttour.com -> premium tour landing
// everything else (findapodcast.io etc) -> existing landing
app.get('/', (req, res) => {
  const host = (req.headers.host || '').toLowerCase();
  if (host.includes('thepodcasttour.com')) {
    return res.sendFile(path.join(dashboardDir, 'the-podcast-tour.html'));
  }
  res.sendFile(path.join(dashboardDir, 'landing.html'));
});

// Direct route for testing / share-links before DNS cuts over
app.get('/tour', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'the-podcast-tour.html'));
});

// Preview — redesigned landing page (review before going live)
app.get('/preview-landing', (req, res) => {
  res.sendFile(path.join(dashboardDir, 'preview-landing.html'));
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
