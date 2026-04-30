'use strict';

/**
 * Demo mode redaction.
 *
 * When client.demo_mode === true, every match returned to the dashboard runs
 * through redactForDemo() before leaving the server. Frontend never sees the
 * real podcast title, host name, contact email, social URLs, website, or
 * exact download numbers — so even savvy prospects opening DevTools can't
 * bypass the gate.
 *
 * What stays VISIBLE (the value proof):
 *   - fit_score and the per-dimension breakdown
 *   - why_this_client_fits (the AI's reasoning)
 *   - best_pitch_angle
 *   - episode_to_reference
 *   - email_subject + email_body (the AI-drafted pitch — hero proof)
 *   - audience size in BUCKET form, not exact
 *   - topic tags, country, language, frequency
 *
 * What gets REDACTED:
 *   - podcasts.title          (replaced with █ block of similar length)
 *   - podcasts.host_name      (null)
 *   - podcasts.contact_email  (null)
 *   - podcasts.website        (null)
 *   - all social URLs         (null)
 *   - apple_url, spotify_url, youtube_url
 *   - exact download / subscriber counts
 *
 * Adds match._locked = true so the frontend renders black-bar + lock-icon UI.
 */

const STRIPE_UNLOCK_URL = 'https://buy.stripe.com/dRm9AT7Dq7W5aJf4V18IU0O';

// Showcase podcast — Zac's "Breakthrough Moment" row. Bypasses redaction in
// demo mode so every prospect sees one fully-unlocked card with real host info,
// real email, and a working pitch button. Drives the wow on sales calls.
const SHOWCASE_PODCAST_ID = 'fa9303fd-3567-4535-9c6f-b918723d8c68';

function redactString(str, minLen = 8, maxLen = 22) {
  if (!str) return '████████';
  // Keep length proportional to the original so the UI doesn't all redact identically.
  const len = Math.max(minLen, Math.min(maxLen, Math.round(str.length * 0.7)));
  return '█'.repeat(len);
}

function bucketAudience(n) {
  if (!n || n < 1000) return 'small';
  if (n < 10000)   return '1k-10k';
  if (n < 50000)   return '10k-50k';
  if (n < 100000)  return '50k-100k';
  if (n < 500000)  return '100k-500k';
  if (n < 1000000) return '500k-1M';
  return '1M+';
}

function redactForDemo(match) {
  if (!match) return match;
  const p = match.podcasts || {};

  // Showcase card — never redact. Prospects see Zac's real podcast, real email,
  // working pitch button. The "this is what you'll be looking at" proof.
  if (p.id === SHOWCASE_PODCAST_ID || match.podcast_id === SHOWCASE_PODCAST_ID) {
    return { ...match, _locked: false, _showcase: true };
  }

  // Build a redacted podcast clone — null out every identity/contact field,
  // keep score-relevant fields and bucketed numbers.
  const redactedPodcast = {
    id:                 p.id,
    external_id:        null,
    title:              redactString(p.title),
    host_name:          null,
    description:        null,
    website:            null,
    contact_email:      null,
    contact_form_url:   null,
    apple_url:          null,
    spotify_url:        null,
    youtube_url:        null,
    instagram_url:      null,
    linkedin_url:       null,
    facebook_url:       null,
    twitter_url:        null,
    tiktok_url:         null,
    linkedin_page_url:  null,
    booking_page_url:   null,
    guest_application_url: null,
    host_instagram_url: null,
    host_linkedin_url:  null,
    host_twitter_url:   null,
    // Keep these — they're score-relevant and don't reveal identity
    category:           p.category || null,
    niche_tags:         p.niche_tags || [],
    total_episodes:     p.total_episodes || null,
    publish_frequency:  p.publish_frequency || null,
    avg_episode_duration_mins: p.avg_episode_duration_mins || null,
    has_guest_history:  p.has_guest_history || null,
    last_episode_date:  p.last_episode_date || null,
    country:            p.country || null,
    language:           p.language || null,
    listen_score:       p.listen_score || null,
    // Buckets instead of exact numbers
    audience_bucket:        bucketAudience(p.youtube_subscribers || p.instagram_followers),
    youtube_subscribers:    null,
    instagram_followers:    null,
    enriched_at:        p.enriched_at || null,
    contact_unlocked_at: null,    // never reveal whether we have contact data
    contact_confidence: null,
    contact_sources:    null,
    unlock_count:       0,
  };

  return {
    ...match,
    podcasts: redactedPodcast,
    _locked: true,
  };
}

function isDemoLocked(client) {
  if (!client?.demo_mode) return false;
  if (client.demo_unlocked_at) return false;
  return true;
}

function isDemoExpired(client) {
  if (!isDemoLocked(client)) return false;
  if (!client.demo_expires_at) return false;
  return new Date(client.demo_expires_at).getTime() < Date.now();
}

function buildUnlockUrl(client) {
  if (!client?.id) return STRIPE_UNLOCK_URL;
  const sep = STRIPE_UNLOCK_URL.includes('?') ? '&' : '?';
  // prefilled_email for cleaner Stripe checkout, client_reference_id for webhook lookup
  const params = new URLSearchParams({ client_reference_id: client.id });
  if (client.email) params.set('prefilled_email', client.email);
  return `${STRIPE_UNLOCK_URL}${sep}${params.toString()}`;
}

/**
 * requireNotDemo(clientId) — server-side gate for action endpoints.
 *
 * Looks up the client and returns { allowed, response } where response is
 * the body to send with status 402 if the client is in demo mode.
 *
 * Usage in a route:
 *   const { allowed, status, body } = await requireNotDemo(req.clientId);
 *   if (!allowed) return res.status(status).json(body);
 */
async function requireNotDemo(clientId) {
  if (!clientId) return { allowed: true };
  const supabase = require('./supabase');
  const { data: client } = await supabase
    .from('clients')
    .select('id, email, demo_mode, demo_unlocked_at, demo_expires_at')
    .eq('id', clientId)
    .single();
  if (!client) return { allowed: true };
  if (!isDemoLocked(client)) return { allowed: true };

  return {
    allowed: false,
    status: 402,
    body: {
      ok:           false,
      success:      false,
      error:        'demo_locked',
      demo_locked:  true,
      message:      'This action requires a paid account. Unlock the platform to use it.',
      unlock_url:   buildUnlockUrl(client),
    },
  };
}

module.exports = {
  redactForDemo,
  isDemoLocked,
  isDemoExpired,
  buildUnlockUrl,
  requireNotDemo,
  STRIPE_UNLOCK_URL,
};
