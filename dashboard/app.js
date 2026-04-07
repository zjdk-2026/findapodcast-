/* ═══════════════════════════════════════════════════════════════
   Podcast Pipeline — Dashboard App
   Vanilla JS SPA. No framework, no build step.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

// ── State ────────────────────────────────────────────────────────────
const state = {
  token:          null,
  client:         null,
  matches:        [],
  stats:          {},
  filter:         'new',
  sortBy:         'fit_score',
  modalMatchId:   null,
  minScore:       0,
  hasEmailOnly:   false,
  hasContactOnly: false,
  contactModalId: null,
};

// ── DOM helpers ───────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── Strip HTML tags ───────────────────────────────────────────────────
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function applyThemePreference() {
  const saved = localStorage.getItem('pp-theme');
  // Default is light mode; only go dark if explicitly saved as dark
  if (saved === 'dark') {
    document.documentElement.classList.remove('light-mode');
  } else {
    document.documentElement.classList.add('light-mode');
  }
}

applyThemePreference();

// ── Toast ─────────────────────────────────────────────────────────────
let toastTimer = null;

function showToast(message, type = 'info') {
  clearTimeout(toastTimer);
  const container = $('toast-container');
  if (!container) return;

  // Remove existing toast if any
  const existing = container.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  // Trigger animation on next frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('toast-show'));
  });

  toastTimer = setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

// ── API helpers ───────────────────────────────────────────────────────
async function apiPost(url, body) {
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':     'application/json',
      'x-dashboard-token': state.token || '',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiPatch(url, body) {
  const res = await fetch(url, {
    method:  'PATCH',
    headers: {
      'Content-Type':     'application/json',
      'x-dashboard-token': state.token || '',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Token extraction ──────────────────────────────────────────────────
function extractToken() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  // /dashboard/TOKEN
  if (parts.length >= 2 && parts[0] === 'dashboard') return parts[1];
  return null;
}

// ── Score helpers ─────────────────────────────────────────────────────
function scoreTier(score) {
  if (score >= 80) return 'high';
  if (score >= 60) return 'mid';
  return 'low';
}

function scoreColorClass(score) {
  if (score >= 80) return 'high';
  if (score >= 60) return 'mid';
  return 'low';
}

function scoreColorVar(score) {
  if (score >= 80) return 'var(--success)';
  if (score >= 60) return 'var(--warning)';
  return 'var(--danger)';
}

function likelihoodClass(likelihood) {
  if (likelihood === 'high')   return 'likelihood-high';
  if (likelihood === 'medium') return 'likelihood-medium';
  return 'likelihood-low';
}

function statusBadgeHtml(status) {
  const labels = {
    new:       'New',
    approved:  'Approved',
    sent:      'Sent',
    replied:   'Replied',
    booked:    'Booked',
    dismissed: 'Not a Fit',
    dream:     'Wish List',
    appeared:  'Aired',
  };
  return `<span class="status-badge status-${esc(status)}">${labels[status] || esc(status)}</span>`;
}

// ── HTML escape ───────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function copyEmail(e, email) {
  e.preventDefault();
  e.stopPropagation();
  const el = e.currentTarget || e.target;
  navigator.clipboard.writeText(email).then(() => {
    const orig = el.innerHTML;
    el.innerHTML = '✓ Copied!';
    el.style.cssText += ';background:rgba(34,197,94,0.15)!important;border-color:rgba(34,197,94,0.4)!important;color:#22c55e!important;';
    showToast(`Copied: ${email}`, 'success');
    setTimeout(() => { el.innerHTML = orig; el.style.cssText = ''; }, 1800);
  }).catch(() => {
    // Fallback for browsers that block clipboard API
    const ta = document.createElement('textarea');
    ta.value = email;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(`Copied: ${email}`, 'success');
  });
}

// ── Hero section (replaces stats strip) ──────────────────────────────
function renderHeroSection() {
  const heroEl = $('hero-section');
  if (!heroEl) return;

  const name = state.client?.name || 'there';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const bookedCount  = state.matches.filter((m) => m.status === 'booked').length;
  const newCount     = state.matches.filter((m) => m.status === 'new').length;
  const pitchedCount = state.matches.filter((m) => ['sent','followed_up'].includes(m.status)).length;
  const seenKey = `seen_replied_${state.token}`;
  const seenIds = new Set(JSON.parse(localStorage.getItem(seenKey) || '[]'));
  const unseenRepliedCount = state.matches.filter((m) => m.status === 'replied' && !seenIds.has(m.id)).length;

  // Motivational subtitle based on what's happening in pipeline
  let subtitle = 'Your podcast booking pipeline is ready.';
  if (bookedCount > 0) subtitle = `${bookedCount} booking${bookedCount > 1 ? 's' : ''} confirmed. Keep the momentum going.`;
  else if (unseenRepliedCount > 0) subtitle = `${unseenRepliedCount} host${unseenRepliedCount > 1 ? 's' : ''} replied. Time to lock in a recording.`;
  else if (pitchedCount > 0) subtitle = `${pitchedCount} pitch${pitchedCount > 1 ? 'es' : ''} out in the world. Check back for replies.`;
  else if (newCount > 0) subtitle = `${newCount} new show${newCount > 1 ? 's' : ''} ready to review. Start pitching today.`;

  const chips = [];
  if (unseenRepliedCount > 0) {
    chips.push(`<span class="stat-chip stat-chip-blue" style="background:#FF3B30;color:#fff;">${unseenRepliedCount} new repl${unseenRepliedCount === 1 ? 'y' : 'ies'}</span>`);
  }

  const airedMatches   = state.matches.filter((m) => m.status === 'appeared');
  const lifetimeTotal  = airedMatches.reduce((t, m) => t + (estimateAudience(m.podcasts?.listen_score).low), 0);

  heroEl.innerHTML = `
    <div class="hero-greeting">
      <div class="hero-greeting-name">${greeting}, ${esc(name.split(' ')[0])} 👋</div>
      <div class="hero-greeting-sub">${subtitle}</div>
      ${lifetimeTotal > 0 ? `
        <div class="hero-lifetime-reach">
          <span class="hero-lifetime-icon">🎙️</span>
          Your voice has reached an estimated <strong>${formatNumber(lifetimeTotal)} people</strong> across ${airedMatches.length} episode${airedMatches.length !== 1 ? 's' : ''}
        </div>` : ''}
      ${chips.length > 0 ? `<div class="hero-chips">${chips.join('')}</div>` : ''}
    </div>`;
}

// ── Onboarding checklist (first-time users) ───────────────────────────
function renderOnboardingChecklist() {
  const el = $('onboarding-checklist');
  if (!el) return;

  const key = `pp-onboarding-done-${state.token}`;
  if (localStorage.getItem(key)) { el.style.display = 'none'; return; }

  const hasProfile  = !!(state.client?.bio_short && state.client.bio_short.trim().length > 20);
  const hasMatches  = state.matches.length > 0;
  const hasActed    = state.matches.some((m) => !['new', 'dismissed', 'dream'].includes(m.status));
  const allDone     = hasProfile && hasMatches && hasActed;

  if (allDone) {
    // Show celebration briefly then hide forever
    el.style.display = 'block';
    el.innerHTML = `<div class="onboarding-card"><div class="onboarding-inner" style="justify-content:center;"><div class="onboarding-complete">🎉 You're all set. Your pipeline is live — keep pitching!</div></div></div>`;
    setTimeout(() => {
      el.style.transition = 'opacity 600ms ease';
      el.style.opacity = '0';
      setTimeout(() => { el.style.display = 'none'; }, 600);
    }, 2500);
    localStorage.setItem(key, '1');
    return;
  }

  el.style.display = 'block';

  const step = (done, title, sub, action) => `
    <div class="onboarding-step ${done ? 'done' : ''}" ${!done && action ? `onclick="${action}"` : ''}>
      <div class="onboarding-check">${done ? '✓' : ''}</div>
      <div>
        <div class="onboarding-step-text">${title}</div>
        <div class="onboarding-step-sub">${sub}</div>
      </div>
    </div>`;

  el.innerHTML = `
    <div class="onboarding-card">
      <div class="onboarding-inner">
        <div>
          <div class="onboarding-label">Getting Started</div>
          <div class="onboarding-title">3 steps to your first booking</div>
        </div>
        <div class="onboarding-steps">
          ${step(hasProfile,  'Complete your profile',      'Paste your LinkedIn bio',        'openProfileModal()')}
          ${step(hasMatches,  'Find your first matches',    'Click Find a Podcast above',     'runPipeline()')}
          ${step(hasActed,    'Send your first pitch',      'Approve a match and hit send',   hasMatches ? "switchToFilter('new')" : 'runPipeline()')}
        </div>
        <button class="onboarding-dismiss" onclick="dismissOnboarding()" title="Dismiss">&#x2715;</button>
      </div>
    </div>`;
}

function dismissOnboarding() {
  const el = $('onboarding-checklist');
  localStorage.setItem(`pp-onboarding-done-${state.token}`, '1');
  if (el) { el.style.transition = 'opacity 400ms ease'; el.style.opacity = '0'; setTimeout(() => { el.style.display = 'none'; }, 400); }
}
window.dismissOnboarding = dismissOnboarding;

// ── Stats strip (this month) — legacy kept for bookMatch calls ────────
function renderStatsStrip() {
  renderHeroSection();
}

// ── Booking celebration modal ─────────────────────────────────────────
function showBookingCelebration(matchId) {
  const modal = $('booking-celebration-modal');
  const body  = $('booking-celebration-body');
  if (!modal || !body) return;

  const match   = state.matches.find((m) => m.id === matchId);
  const podcast = match?.podcasts || match;
  const title   = podcast?.title || 'the show';
  const host    = podcast?.host  || null;

  // Estimate audience from listen_score (ListenNotes scale 0-100 maps roughly to listener tiers)
  const ls = podcast?.listen_score || 0;
  let audienceEst = '';
  if      (ls >= 80) audienceEst = 'an estimated 500,000+ listeners';
  else if (ls >= 65) audienceEst = 'an estimated 100,000+ listeners';
  else if (ls >= 50) audienceEst = 'an estimated 20,000+ listeners';
  else if (ls >= 35) audienceEst = 'an estimated 5,000+ listeners';
  else if (ls >= 20) audienceEst = 'an estimated 1,000+ listeners';
  else               audienceEst = 'a growing audience';

  const linkedInText = encodeURIComponent(`Just booked a guest spot on ${title}. Can't wait to share my thoughts on [your topic] with their audience.\n\nIf you want to grow through podcasting — highly recommend @FindAPodcast 🎙️\n\nhttps://findapodcast.club`);
  const linkedInUrl  = `https://www.linkedin.com/sharing/share-offsite/?url=https://findapodcast.club&summary=${linkedInText}`;

  body.innerHTML = `
    <div style="font-size:52px;margin-bottom:12px;line-height:1;">🎉</div>
    <h2 style="font-size:24px;font-weight:800;color:var(--text-primary);letter-spacing:-0.03em;margin-bottom:8px;">You're booked.</h2>
    <p style="font-size:15px;color:var(--text-secondary);margin-bottom:4px;font-weight:500;">${esc(title)}</p>
    ${host ? `<p style="font-size:13px;color:var(--text-tertiary);margin-bottom:0;">Hosted by ${esc(host)}</p>` : ''}
    <div style="background:rgba(48,209,88,0.08);border:1px solid rgba(48,209,88,0.2);border-radius:12px;padding:14px 20px;margin:20px 0;text-align:center;">
      <div style="font-size:13px;font-weight:700;color:var(--success);">Your voice is about to reach ${audienceEst}</div>
    </div>
    <div style="text-align:left;background:var(--bg-tertiary);border-radius:12px;padding:16px 20px;margin-bottom:24px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:10px;">What happens next</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-primary);">
          <span style="font-size:16px;">📅</span> Confirm your recording date with the host
        </div>
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-primary);">
          <span style="font-size:16px;">🎙️</span> Prep your best stories and talking points
        </div>
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-primary);">
          <span style="font-size:16px;">✨</span> After it airs, mark it as Aired to unlock Content Boost
        </div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <a href="${linkedInUrl}" target="_blank" rel="noopener" class="btn btn-primary" style="width:100%;justify-content:center;gap:8px;text-decoration:none;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
        Share on LinkedIn
      </a>
      <button class="btn btn-secondary" onclick="closeBookingCelebration();showContentBoostModal();" style="width:100%;">
        Turn this into 30 days of content
      </button>
      <button class="btn btn-ghost" onclick="closeBookingCelebration();" style="width:100%;color:var(--text-tertiary);">
        Close
      </button>
    </div>`;

  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeBookingCelebration() {
  const modal = $('booking-celebration-modal');
  if (!modal) return;
  modal.style.display = 'none';
  document.body.style.overflow = '';
}
window.closeBookingCelebration = closeBookingCelebration;

// ── Content boost modal ───────────────────────────────────────────────
function showContentBoostModal() {
  const modal = $('content-boost-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeContentBoostModal() {
  const modal = $('content-boost-modal');
  if (!modal) return;
  modal.style.display = 'none';
  document.body.style.overflow = '';
}
window.closeContentBoostModal = closeContentBoostModal;

// Track which match the content boost is being ordered for
let _contentBoostMatchId = null;

function showContentBoostModal(matchId) {
  _contentBoostMatchId = matchId || state.modalMatchId || null;
  const modal = $('content-boost-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

async function startContentBoostCheckout() {
  closeContentBoostModal();
  // Tag the match as 'requested' before sending to Stripe so we can link it after payment
  if (_contentBoostMatchId) {
    try {
      await apiPost('/api/content-boost/request', { matchId: _contentBoostMatchId });
      updateMatchInState(_contentBoostMatchId, { content_boost_status: 'requested' });
      updateContentBoostTab();
    } catch { /* non-fatal */ }
  }
  window.open('https://buy.stripe.com/00waEX7Dqekt8B70EL8IU0L', '_blank');
}
window.startContentBoostCheckout = startContentBoostCheckout;
window.closeContentBoostModal = closeContentBoostModal;

// ── Content Boost tab visibility + notification ───────────────────────
function updateContentBoostTab() {
  const tab  = $('content-boost-tab');
  const boostMatches = state.matches.filter((m) => m.content_boost_status);
  if (tab) tab.style.display = boostMatches.length > 0 ? '' : 'none';

  // Show notification if any completed but not yet notified
  const newlyComplete = state.matches.filter(
    (m) => m.content_boost_status === 'completed' && !m.content_boost_notified
  );
  if (newlyComplete.length > 0) {
    const banner = $('notification-banner');
    if (banner) {
      banner.innerHTML = `⚡ Your Content Boost is ready! <button onclick="switchToFilter('content_boost');dismissBoostNotification()" style="margin-left:10px;background:var(--accent);color:#fff;border:none;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700;cursor:pointer;">View now</button>`;
      banner.style.display = 'block';
    }
  }
}

async function dismissBoostNotification() {
  const banner = $('notification-banner');
  if (banner) banner.style.display = 'none';
  // Mark notified on server for each completed unnotified boost
  const toNotify = state.matches.filter(
    (m) => m.content_boost_status === 'completed' && !m.content_boost_notified
  );
  for (const m of toNotify) {
    updateMatchInState(m.id, { content_boost_notified: true });
    try { await apiPost('/api/save-pitch', { matchId: m.id }); } catch { /* non-fatal */ }
  }
}
window.dismissBoostNotification = dismissBoostNotification;

// ── Submit episode link for Content Boost ─────────────────────────────
async function submitEpisodeLink(matchId) {
  const input = document.getElementById(`boost-url-${matchId}`);
  const btn   = document.getElementById(`boost-link-btn-${matchId}`);
  const url   = input?.value.trim();

  if (!url) { showToast('Paste your episode link first.', 'error'); return; }
  if (!url.startsWith('http')) { showToast('Please enter a valid URL starting with http.', 'error'); return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    const data = await apiPost('/api/content-boost/submit-link', { matchId, episodeUrl: url });
    if (data.success) {
      showToast('✅ Episode link sent to our team! We\'ll start editing shortly.', 'success');
      updateMatchInState(matchId, { content_boost_episode_url: url });
      // Refresh card so the submission section hides
      const card = document.getElementById(`card-${matchId}`);
      if (card) {
        const section = document.getElementById(`boost-link-section-${matchId}`);
        if (section) {
          section.innerHTML = `<p style="font-size:13px;font-weight:700;color:#6366f1;margin:0;">✅ Episode link received — our team is on it!</p>`;
        }
      }
    } else {
      showToast(data.error || 'Failed to send link.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Send to Team'; }
    }
  } catch {
    showToast('Network error. Please try again.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Send to Team'; }
  }
}
window.submitEpisodeLink = submitEpisodeLink;

// ── Render stats ──────────────────────────────────────────────────────
function renderStats(stats) {
  const set = (id, val) => { const el = $(id); if (el) el.textContent = val ?? '0'; };
  set('stat-total',    stats.total);
  set('stat-high',     stats.high);
  set('stat-avg',      stats.avgScore ?? '—');
  set('stat-sent',     stats.approved ?? 0);
  set('stat-booked',   stats.booked);
}

// ── Score tooltips ────────────────────────────────────────────────────
const SCORE_TOOLTIPS = {
  'Relevance':   'How closely this show\'s topics match your niche and speaking angles.',
  'Audience':    'The estimated size and quality of the show\'s listener base.',
  'Recency':     'How recently the show published new episodes.',
  'Reach':       'The show\'s overall footprint across platforms — YouTube subscribers, social following, listen score.',
  'Contact':     'How easy it is to actually reach the host — email found, booking page, guest application form.',
  'Brand Fit':   'How well your personal brand aligns with the show\'s tone and guest history.',
  'Guest Qual.': 'The typical calibre of previous guests on this show.',
};

// ── Score bar HTML ────────────────────────────────────────────────────
function scoreBarHtml(label, value) {
  const v   = Math.round(value || 0);
  const tip = SCORE_TOOLTIPS[label] || '';
  const cls = v >= 70 ? 'high' : v >= 40 ? 'mid' : 'low';
  return `
    <div class="score-row"${tip ? ` title="${esc(tip)}" style="cursor:help;"` : ''}>
      <div class="score-row-header">
        <span class="score-row-label">${esc(label)}</span>
        <span class="score-row-value" style="color:${v >= 70 ? 'var(--success)' : v >= 40 ? 'var(--warning)' : 'var(--danger)'}">${v}</span>
      </div>
      <div class="score-bar-track">
        <div class="score-bar-fill ${cls}" style="width:${v}%"></div>
      </div>
    </div>`;
}

// ── Contact chips HTML ────────────────────────────────────────────────
function isValidUrl(url) {
  if (!url) return false;
  try { new URL(url); return true; } catch { return false; }
}

function contactChipsHtml(podcast) {
  const chips = [];

  // Email (always first if present)
  if (podcast.contact_email) {
    chips.push(`<a class="contact-chip contact-chip-primary" href="#" onclick="copyEmail(event,'${esc(podcast.contact_email)}')" title="Click to copy email"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> ${esc(podcast.contact_email)}</a>`);
  }

  // Single Website button (best available URL)
  const siteUrl = podcast.website || podcast.youtube_url || podcast.apple_url || podcast.spotify_url;
  if (isValidUrl(siteUrl)) {
    chips.push(`<a class="contact-chip" href="${esc(siteUrl)}" target="_blank" rel="noopener">🌐 Website</a>`);
  }

  // Social links — validated only
  if (isValidUrl(podcast.instagram_url))     chips.push(`<a class="contact-chip" href="${esc(podcast.instagram_url)}" target="_blank" rel="noopener">Instagram</a>`);
  if (isValidUrl(podcast.twitter_url))       chips.push(`<a class="contact-chip" href="${esc(podcast.twitter_url)}" target="_blank" rel="noopener">Twitter/X</a>`);
  if (isValidUrl(podcast.linkedin_page_url)) chips.push(`<a class="contact-chip" href="${esc(podcast.linkedin_page_url)}" target="_blank" rel="noopener">LinkedIn</a>`);
  else if (isValidUrl(podcast.linkedin_url)) chips.push(`<a class="contact-chip" href="${esc(podcast.linkedin_url)}" target="_blank" rel="noopener">LinkedIn</a>`);
  if (isValidUrl(podcast.facebook_url))      chips.push(`<a class="contact-chip" href="${esc(podcast.facebook_url)}" target="_blank" rel="noopener">Facebook</a>`);
  if (isValidUrl(podcast.tiktok_url))        chips.push(`<a class="contact-chip" href="${esc(podcast.tiktok_url)}" target="_blank" rel="noopener">TikTok</a>`);
  if (isValidUrl(podcast.youtube_url) && podcast.website) chips.push(`<a class="contact-chip" href="${esc(podcast.youtube_url)}" target="_blank" rel="noopener">YouTube</a>`);

  return chips.length > 0
    ? `<div class="contact-section"><div class="contact-chips">${chips.join('')}</div></div>`
    : `<div class="contact-section"><span style="font-size:12px;color:var(--text-tertiary);">No contact info found yet.</span></div>`;
}

// ── Social chips HTML (legacy, kept for compatibility) ─────────────────
function socialChipsHtml(podcast) { return []; }

// ── Listener count estimate from listen_score (0-100) ────────────────
function listenersLabel(listenScore) {
  if (!listenScore) return null;
  const s = parseInt(listenScore, 10);
  if (s >= 90) return '1M+ listeners';
  if (s >= 80) return '~500k listeners';
  if (s >= 70) return '~100k listeners';
  if (s >= 60) return '~50k listeners';
  if (s >= 50) return '~20k listeners';
  if (s >= 40) return '~10k listeners';
  if (s >= 30) return '~5k listeners';
  if (s >= 20) return '~2k listeners';
  return '~1k listeners';
}

// ── Meta tags HTML ────────────────────────────────────────────────────
function metaTagsHtml(podcast) {
  const tags = [];
  // eps + recency shown inline on title row — not repeated here
  if (podcast.language && podcast.language !== 'English') tags.push(podcast.language);
  if (podcast.youtube_subscribers) {
    const subs = podcast.youtube_subscribers >= 1000
      ? `${(podcast.youtube_subscribers / 1000).toFixed(0)}K YT`
      : `${podcast.youtube_subscribers} YT`;
    tags.push(subs);
  }
  return tags.length > 0
    ? `<div class="card-meta">${tags.map((t) => `<span class="meta-tag">${esc(t)}</span>`).join('')}</div>`
    : '';
}

// ── Action buttons HTML ───────────────────────────────────────────────
function actionButtonsHtml(match) {
  const status   = match.status;
  const id       = match.id;
  const hasEmail = (match.email_subject_edited || match.email_subject) && (match.email_body_edited || match.email_body);
  const buttons  = [];

  if (status === 'new') {
    buttons.push(`<button class="btn btn-action-book btn-xs" onclick="bookMatch('${id}')">🎉 It's Booked!</button>`);
    buttons.push(`<button class="btn btn-xs" style="background:#f0ebff;color:#6366f1;border:1.5px solid #c4b5fd;font-weight:600;" onclick="dreamMatch('${id}')">⭐ Wish List</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="dismissMatch('${id}')">Not a Fit</button>`);
  } else if (status === 'approved') {
    if (!hasEmail) {
      buttons.push(`<span style="font-size:12px;color:var(--text-tertiary);font-style:italic;">✍️ Writing your pitch…</span>`);
    } else {
      buttons.push(`<button class="btn btn-action-followup btn-xs" onclick="showFollowUpModal('${id}')">📩 Send Follow Up</button>`);
    }
    buttons.push(`<button class="btn btn-action-book btn-xs btn-action-primary" onclick="bookMatch('${id}')">🎉 It's Booked!</button>`);
    buttons.push(`<button class="btn btn-xs" style="background:#f0ebff;color:#6366f1;border:1.5px solid #c4b5fd;font-weight:600;" onclick="dreamMatch('${id}')">⭐ Wish List</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="dismissMatch('${id}')">Not a Fit</button>`);
  } else if (status === 'dream') {
    buttons.push(`<button class="btn btn-action-book btn-xs btn-action-primary" onclick="bookMatch('${id}')">🎉 It's Booked!</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="dismissMatch('${id}')">Not a Fit</button>`);
  } else if (status === 'sent') {
    buttons.push(`<button class="btn btn-action-book btn-xs btn-action-primary" onclick="bookMatch('${id}')">🎉 It's Booked!</button>`);
  } else if (status === 'replied') {
    buttons.push(`<button class="btn btn-action-book btn-xs btn-action-primary" onclick="bookMatch('${id}')">🎉 It's Booked!</button>`);
  } else if (status === 'booked') {
    buttons.push(`<button class="btn btn-action-appeared btn-xs" onclick="markAppeared('${id}')">✅ Episode Aired</button>`);
    buttons.push(`<button class="btn btn-action-share btn-xs" onclick="showShareModal('${id}')">🏆 Share Win</button>`);
    buttons.push(`<button class="btn btn-action-send btn-xs btn-action-primary" onclick="showContentBoostModal('${id}')">🚀 Content Boost</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="dismissMatch('${id}')">❌ Not Booked</button>`);
  } else if (status === 'appeared') {
    buttons.push(`<button class="btn btn-action-send btn-xs btn-action-primary" onclick="showContentBoostModal('${id}')">🚀 Content Boost</button>`);
  } else if (status === 'dismissed') {
    buttons.push(`<button class="btn btn-restore btn-xs" onclick="restoreMatch('${id}')">↩ Restore to New</button>`);
  }

  return buttons.join('');
}

// ── Toggle card expand ────────────────────────────────────────────────
// On first expand: if all sub-scores are the neutral fallback (50), auto re-enrich + re-score.
const _reenrichedMatches = new Set(); // prevent firing more than once per session

function toggleCardExpand(matchId) {
  const card = $(`card-${matchId}`);
  if (!card) return;
  const isExpanded = card.getAttribute('data-expanded') === 'true';
  card.setAttribute('data-expanded', isExpanded ? 'false' : 'true');

  // Auto re-enrich on first open if scores are all neutral fallback (50)
  if (!isExpanded && !_reenrichedMatches.has(matchId)) {
    const match = state.matches.find((m) => m.id === matchId);
    if (match && isNeutralFallback(match)) {
      _reenrichedMatches.add(matchId);
      triggerReEnrich(matchId);
    }
  }
}
window.toggleCardExpand = toggleCardExpand;

function isNeutralFallback(match) {
  const r = match.relevance_score;
  const a = match.audience_score;
  const rc = match.reach_score;
  // All-50 = neutral fallback from failed scoring
  // All-0  = scoring never ran (inserted as placeholder)
  const allFifty = r === 50 && a === 50 && rc === 50;
  const allZero  = (r === 0 || r == null) && (a === 0 || a == null) && (rc === 0 || rc == null);
  return allFifty || allZero;
}

async function triggerReEnrich(matchId) {
  // Show subtle "refreshing" indicator in the score section
  const scoreEl = document.querySelector(`#card-${matchId} .fit-score-value`);
  const origText = scoreEl?.textContent;
  if (scoreEl) scoreEl.textContent = '…';

  const barFill = document.querySelector(`#card-${matchId} .fit-score-bar-fill`);
  if (barFill) barFill.style.opacity = '0.4';

  try {
    const data = await apiPost(`/api/re-enrich/${matchId}`, {});
    if (data.success && data.scores) {
      const s = data.scores;
      // Update state
      updateMatchInState(matchId, {
        fit_score:            s.fit_score,
        relevance_score:      s.relevance_score,
        audience_score:       s.audience_score,
        recency_score:        s.recency_score,
        reach_score:          s.reach_score,
        contactability_score: s.contactability_score,
        booking_likelihood:   s.booking_likelihood,
        why_this_client_fits: s.why_this_client_fits,
        best_pitch_angle:     s.best_pitch_angle,
        episode_to_reference: s.episode_to_reference,
        red_flags:            s.red_flags,
      });
      // Re-render just this card (preserves expanded state)
      updateCard(matchId);
      // Re-open it since updateCard resets expansion
      const card = $(`card-${matchId}`);
      if (card) card.setAttribute('data-expanded', 'true');
      updateStatBadges();
      if (s.fit_score && s.fit_score !== 50) {
        showToast(`✅ Score updated: ${s.fit_score}/100`, 'success');
      }
    } else {
      // Restore original display if nothing changed
      if (scoreEl) scoreEl.textContent = origText;
      if (barFill) barFill.style.opacity = '1';
    }
  } catch {
    if (scoreEl) scoreEl.textContent = origText;
    if (barFill) barFill.style.opacity = '1';
  }
}
window.triggerReEnrich = triggerReEnrich;

// ── Leaderboard ───────────────────────────────────────────────────────
let _leaderboardVisible = true;

async function loadLeaderboard() {
  const card = $('leaderboard-card');
  const body = $('leaderboard-body');
  if (!card || !body) return;

  try {
    const res  = await apiFetch(`/api/leaderboard`);
    if (!res?.success || !res.rows?.length) return;

    const rows = res.rows;
    const myRank = rows.find(r => r.is_me)?.rank;

    // Only show top 10, but always include the user's own row if outside top 10
    const top10  = rows.slice(0, 10);
    const hasMe  = top10.some(r => r.is_me);
    const meRow  = !hasMe ? rows.find(r => r.is_me) : null;

    const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

    const renderRow = (r, divider = false) => {
      const isMe   = r.is_me;
      const medal  = MEDALS[r.rank] || '';
      const rankDisp = medal || `#${r.rank}`;
      return `
        ${divider ? `<div style="border-top:1px dashed var(--border-subtle,#eee);margin:4px 20px;"></div>` : ''}
        <div style="display:grid;grid-template-columns:44px 1fr 64px 64px 64px;align-items:center;padding:9px 20px;gap:4px;
          ${isMe ? 'background:linear-gradient(90deg,#f5f3ff,#ede9fe);border-left:3px solid #6366f1;' : 'border-left:3px solid transparent;'}
          transition:background 0.15s;">
          <div style="font-size:${medal ? '18px' : '13px'};font-weight:700;color:${isMe ? '#6366f1' : 'var(--text-secondary,#888)'};">${rankDisp}</div>
          <div style="font-size:13px;font-weight:${isMe ? '700' : '500'};color:${isMe ? '#6366f1' : 'var(--text-primary,#1a1a1a)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${esc(r.display_name)}${isMe ? ' <span style="font-size:10px;font-weight:700;color:#6366f1;background:#ede9fe;border-radius:999px;padding:1px 7px;margin-left:4px;">YOU</span>' : ''}
          </div>
          <div style="text-align:center;">
            ${r.sent > 0 ? `<span style="font-size:13px;font-weight:600;color:#6366f1;">${r.sent}</span>` : `<span style="font-size:12px;color:var(--text-tertiary,#bbb);">—</span>`}
          </div>
          <div style="text-align:center;">
            ${r.booked > 0 ? `<span style="font-size:13px;font-weight:700;color:#f59e0b;">🎉 ${r.booked}</span>` : `<span style="font-size:12px;color:var(--text-tertiary,#bbb);">—</span>`}
          </div>
          <div style="text-align:center;">
            ${r.appeared > 0 ? `<span style="font-size:13px;font-weight:600;color:#22c55e;">${r.appeared}</span>` : `<span style="font-size:12px;color:var(--text-tertiary,#bbb);">—</span>`}
          </div>
        </div>`;
    };

    // Header row
    const headerHtml = `
      <div style="display:grid;grid-template-columns:44px 1fr 64px 64px 64px;align-items:center;padding:6px 20px;gap:4px;margin-top:2px;">
        <div style="font-size:10px;font-weight:700;color:var(--text-tertiary,#bbb);letter-spacing:0.06em;text-transform:uppercase;">Rank</div>
        <div style="font-size:10px;font-weight:700;color:var(--text-tertiary,#bbb);letter-spacing:0.06em;text-transform:uppercase;">Member</div>
        <div style="font-size:10px;font-weight:700;color:#6366f1;letter-spacing:0.06em;text-transform:uppercase;text-align:center;">Pitched</div>
        <div style="font-size:10px;font-weight:700;color:#f59e0b;letter-spacing:0.06em;text-transform:uppercase;text-align:center;">Booked</div>
        <div style="font-size:10px;font-weight:700;color:#22c55e;letter-spacing:0.06em;text-transform:uppercase;text-align:center;">Aired</div>
      </div>`;

    body.innerHTML = headerHtml
      + top10.map(r => renderRow(r)).join('')
      + (meRow ? renderRow(meRow, true) : '');

    card.style.display = '';
  } catch {
    // Silently fail — leaderboard is non-critical
  }
}

function toggleLeaderboard() {
  const body   = $('leaderboard-body');
  const toggle = $('leaderboard-toggle');
  if (!body) return;
  _leaderboardVisible = !_leaderboardVisible;
  body.style.display   = _leaderboardVisible ? '' : 'none';
  if (toggle) toggle.textContent = _leaderboardVisible ? 'Hide ▴' : 'Show ▾';
}
window.toggleLeaderboard = toggleLeaderboard;

// ── Render a single match card ────────────────────────────────────────
function renderMatchCard(match) {
  const podcast    = match.podcasts || {};
  const fitScore   = match.fit_score || 0;
  const tier       = scoreTier(fitScore);
  const tierClass  = `score-tier-${tier}`;
  const likeCls    = likelihoodClass(match.booking_likelihood);
  const isBooked   = match.status === 'booked';
  const bookedClass = isBooked ? 'card-booked-highlight' : '';

  const redFlagsClean = match.red_flags && match.red_flags !== 'none' && !match.red_flags.startsWith('API error') && !match.red_flags.startsWith('Scoring');
  const redFlagsHtml = redFlagsClean
    ? `<div class="why-fits-box">
        <p class="why-fits-label">Red Flags</p>
        <p class="red-flags-text">${esc(match.red_flags)}</p>
       </div>`
    : '';

  const episodeHtml = (match.episode_to_reference && match.episode_to_reference !== 'none identified')
    ? `<div class="why-fits-box">
        <p class="why-fits-label">Reference Episode</p>
        <p class="analysis-text">"${esc(match.episode_to_reference)}"</p>
       </div>`
    : '';

  const socialHtml = '';

  return `
  <article class="match-card status-${esc(match.status)} ${tierClass} ${bookedClass}" id="card-${esc(match.id)}" data-status="${esc(match.status)}" data-score="${fitScore}" data-expanded="false">

    <!-- Collapsed row — click to expand -->
    <div class="card-row" onclick="toggleCardExpand('${esc(match.id)}')">
      <div class="card-row-left">
        <div class="card-row-title">
          ${isBooked ? '🎉 ' : ''}${esc(podcast.title) || 'Unknown Show'}
          ${(() => {
            const pills = [];
            if (podcast.total_episodes) pills.push(`<span class="inline-pill">${podcast.total_episodes} eps</span>`);
            if (podcast.last_episode_date) {
              const days = Math.round((Date.now() - new Date(podcast.last_episode_date).getTime()) / 86400000);
              pills.push(`<span class="inline-pill">${days}d ago</span>`);
            }
            if (podcast.country) pills.push(`<span class="inline-pill">${esc(podcast.country)}</span>`);
            return pills.join('');
          })()}
        </div>
        ${podcast.host_name ? `<div class="card-row-host">Hosted by ${esc(podcast.host_name)}</div>` : ''}
        <div class="card-row-links" onclick="event.stopPropagation()">
          ${podcast.contact_email ? `<a class="card-link-chip" href="#" onclick="copyEmail(event,'${esc(podcast.contact_email)}')" title="Click to copy email"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> ${esc(podcast.contact_email)}</a>` : ''}
          ${(podcast.website || podcast.youtube_url || podcast.apple_url || podcast.spotify_url) ? `<a class="card-link-chip" href="${esc(podcast.website || podcast.youtube_url || podcast.apple_url || podcast.spotify_url)}" target="_blank" rel="noopener"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Website</a>` : ''}
          ${isValidUrl(podcast.instagram_url) ? `<a class="card-link-chip" href="${esc(podcast.instagram_url)}" target="_blank" rel="noopener">Instagram</a>` : ''}
          ${isValidUrl(podcast.twitter_url) ? `<a class="card-link-chip" href="${esc(podcast.twitter_url)}" target="_blank" rel="noopener">Twitter/X</a>` : ''}
          ${isValidUrl(podcast.linkedin_page_url || podcast.linkedin_url) ? `<a class="card-link-chip" href="${esc(podcast.linkedin_page_url || podcast.linkedin_url)}" target="_blank" rel="noopener">LinkedIn</a>` : ''}
          ${isValidUrl(podcast.youtube_url) && podcast.website ? `<a class="card-link-chip" href="${esc(podcast.youtube_url)}" target="_blank" rel="noopener">YouTube</a>` : ''}
          ${(podcast.booking_page_url && podcast.booking_page_url.includes('facebook.com')) ? `<a class="card-link-chip" href="${esc(podcast.booking_page_url)}" target="_blank" rel="noopener">Facebook</a>` : ''}
        </div>
      </div>
      <div class="card-row-right">
        <span class="score-pill ${tier}">${fitScore}</span>
        ${statusBadgeHtml(match.status)}
        <span class="card-chevron">▸</span>
      </div>
    </div>

    <!-- Expanded content -->
    <div class="card-expanded">
      <div class="card-expanded-inner">

        <!-- Compatibility score + bar -->
        <div class="fit-score-section">
          <div class="fit-score-header">
            <span class="fit-score-label">Compatibility Score</span>
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="${likeCls} likelihood-badge">${esc(match.booking_likelihood || '')}</span>
              <span class="fit-score-value" style="color:${scoreColorVar(fitScore)}">${fitScore}</span>
            </div>
          </div>
          <div class="fit-score-bar-track">
            <div class="fit-score-bar-fill score-bar-fill ${fitScore >= 70 ? 'high' : fitScore >= 40 ? 'mid' : 'low'}" style="width:${fitScore}%"></div>
          </div>
        </div>

        <!-- Sub-scores -->
        <div class="score-bars">
          ${scoreBarHtml('Relevance',  match.relevance_score)}
          ${scoreBarHtml('Audience',   match.audience_score)}
          ${scoreBarHtml('Recency',    match.recency_score)}
          ${scoreBarHtml('Reach',      match.reach_score)}
          ${scoreBarHtml('Contact',    match.contactability_score)}
        </div>

        <!-- Why fits -->
        ${match.why_this_client_fits ? `
        <div class="why-fits-box">
          <p class="why-fits-label">Why You Fit</p>
          <p class="why-fits-text">${esc(match.why_this_client_fits)}</p>
        </div>` : ''}

        <!-- Analysis -->
        <div class="card-analysis">
          ${match.best_pitch_angle ? `
          <div class="why-fits-box">
            <p class="why-fits-label">Best Pitch Angle</p>
            <p class="pitch-text">${esc(match.best_pitch_angle)}</p>
          </div>` : ''}
      ${episodeHtml}
      ${redFlagsHtml}
    </div>

    <!-- Meta tags -->
    ${metaTagsHtml(podcast)}

    <!-- Social chips -->
    ${socialHtml}

    <!-- Pitch + Notes buttons row -->
    <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;">

    <!-- Pitch / Thank You section -->
    <div class="card-pitch-section" id="pitch-area-${esc(match.id)}" style="flex-shrink:0;${(match.status === 'replied' || match.status === 'dismissed') ? 'display:none;' : ''}">
      <button class="pitch-toggle-btn ${match.status !== 'appeared' && match.email_subject ? 'pitch-toggle-btn-saved' : ''}" onclick="togglePitchArea('${esc(match.id)}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        ${match.status === 'appeared' ? '✉️ Send a Thank You' : (match.email_subject ? '✉️ Send Pitch Email' : '✉️ Write Pitch Email')}
        ${match.status !== 'appeared' ? (match.email_subject ? '<span class="pitch-saved-badge">Saved</span>' : '<span class="pitch-ai-badge">Draft Ready</span>') : ''}
      </button>
      <div class="note-editor" id="pitch-editor-${esc(match.id)}" style="display:none;">
        ${match.status === 'appeared' ? `
        <label class="pitch-field-label">Subject Line</label>
        <select class="subject-preset-select" id="pitch-subject-select-${esc(match.id)}" onchange="applySubjectPreset('${esc(match.id)}')" style="margin-bottom:6px;">
          <option value="">Choose a subject line</option>
          <option value="Thank you for having me on ${esc(podcast.title || 'your show')}">Thank you for having me on ${esc(podcast.title || 'your show')}</option>
          <option value="Really enjoyed our conversation">Really enjoyed our conversation</option>
          <option value="Thanks for the episode">Thanks for the episode</option>
          <option value="__custom__">✏️ Write my own…</option>
        </select>
        <input type="text" class="note-textarea" id="pitch-subject-custom-${esc(match.id)}" placeholder="Type your subject line…" style="display:none;margin-bottom:6px;padding:8px 10px;" value="" />
        <label class="pitch-field-label">Thank You Email</label>
        <textarea class="note-textarea" id="pitch-body-${esc(match.id)}" rows="7" placeholder="Write a short thank you to the host. Mention something specific from the episode, share that you are promoting it to your audience, and leave the door open for a future connection."></textarea>
        ` : `
        <label class="pitch-field-label">Subject Line</label>
        <select class="subject-preset-select" id="pitch-subject-select-${esc(match.id)}" onchange="applySubjectPreset('${esc(match.id)}')" style="margin-bottom:6px;">
          <option value="">Choose a subject line</option>
          <option value="Guest inquiry for ${esc(podcast.title || 'your show')}">Guest inquiry for ${esc(podcast.title || 'your show')}</option>
          <option value="I'd love to be a guest on ${esc(podcast.title || 'your show')}">I'd love to be a guest on ${esc(podcast.title || 'your show')}</option>
          <option value="Quick guest pitch for ${esc(podcast.title || 'your show')}">Quick guest pitch for ${esc(podcast.title || 'your show')}</option>
          <option value="Would love to join you on ${esc(podcast.title || 'your show')}">Would love to join you on ${esc(podcast.title || 'your show')}</option>
          <option value="Guest feature idea for ${esc(podcast.title || 'your show')}">Guest feature idea for ${esc(podcast.title || 'your show')}</option>
          <option value="Reaching out about a guest spot on ${esc(podcast.title || 'your show')}">Reaching out about a guest spot on ${esc(podcast.title || 'your show')}</option>
          <option value="__custom__">✏️ Write my own…</option>
        </select>
        <input type="text" class="note-textarea" id="pitch-subject-custom-${esc(match.id)}" placeholder="Type your custom subject line…" style="display:none;margin-bottom:6px;padding:8px 10px;" value="${esc(match.email_subject || '')}" />
        <label class="pitch-field-label">Pitch Email Body</label>
        ${match.email_body && match.email_body.includes('[Write your pitch here') ? `<div style="background:#FFF7ED;border:1px solid rgba(255,159,10,0.25);border-radius:8px;padding:10px 14px;margin-bottom:8px;font-size:12px;color:#C2710C;font-weight:500;">Our team is finalising your personalised pitch. In the meantime, feel free to write your own below or click Rewrite Pitch to generate it now.</div>` : ''}
        <textarea class="note-textarea" id="pitch-body-${esc(match.id)}" rows="7" placeholder="Your pitch email…">${esc(match.email_body && match.email_body.includes('[Write your pitch here') ? '' : (match.email_body || ''))}</textarea>
        `}
        <div class="note-actions" style="gap:8px;flex-wrap:wrap;margin-top:10px;">
          ${(match.status !== 'sent' && match.status !== 'approved' && match.status !== 'appeared' && match.status !== 'dream') ? `<button class="btn btn-action-send btn-xs" onclick="sendMatch('${esc(match.id)}')">🚀 Send Pitch</button>` : ''}
          <button class="btn btn-primary btn-xs" onclick="savePitch('${esc(match.id)}')">Save</button>
          <button class="btn btn-secondary btn-xs" onclick="copyPitch('${esc(match.id)}')">Copy</button>
          ${match.status !== 'appeared' ? `<button class="btn btn-outline btn-xs" onclick="regeneratePitch('${esc(match.id)}')">✦ Rewrite Pitch</button>` : ''}
          <button class="btn btn-ghost btn-xs" onclick="togglePitchArea('${esc(match.id)}')">Close</button>
        </div>
      </div>
    </div>

    ${match.status === 'replied' ? `<button class="btn btn-action-followup btn-xs" onclick="openEmailModal('${esc(match.id)}')">✉️ Email</button>` : ''}


    </div><!-- /.pitch-notes-row -->

        <!-- Footer: action buttons -->
        <div class="card-footer">
          ${actionButtonsHtml(match)}
        </div>

      </div><!-- /.card-expanded-inner -->
    </div><!-- /.card-expanded -->

    <!-- Content Boost episode link submission -->
    ${match.content_boost_status === 'ordered' ? `
    <div class="boost-link-section" id="boost-link-section-${esc(match.id)}" style="border-top:1px solid var(--border-subtle,#f0f0f0);padding:16px 20px;background:linear-gradient(135deg,#f5f3ff 0%,#ede9fe 100%);">
      <p style="font-size:13px;font-weight:700;color:#6366f1;margin:0 0 6px;">⚡ Content Boost — Submit Your Episode</p>
      <p style="font-size:12px;color:#555;margin:0 0 12px;">Paste the link to your episode (Spotify, Apple, YouTube, etc.) so our team can download and start editing.</p>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="url" id="boost-url-${esc(match.id)}" class="form-input" placeholder="https://open.spotify.com/episode/..." style="flex:1;height:36px;padding:0 10px;border-radius:8px;border:1px solid #c4b5fd;font-size:13px;background:#fff;" />
        <button class="btn btn-primary btn-sm" onclick="submitEpisodeLink('${esc(match.id)}')" id="boost-link-btn-${esc(match.id)}" style="height:36px;white-space:nowrap;background:linear-gradient(135deg,#6366f1,#8b5cf6);">Send to Team</button>
      </div>
    </div>` : match.content_boost_status === 'completed' ? `
    <div style="border-top:1px solid var(--border-subtle,#f0f0f0);padding:12px 20px;background:linear-gradient(135deg,#f0fdf4 0%,#dcfce7 100%);">
      <p style="font-size:13px;font-weight:700;color:#16a34a;margin:0;">✅ Content Boost complete — check your inbox for your 30 days of content!</p>
    </div>` : match.content_boost_status === 'requested' ? `
    <div style="border-top:1px solid var(--border-subtle,#f0f0f0);padding:12px 20px;background:#fffbeb;">
      <p style="font-size:13px;color:#92400e;margin:0;">⏳ Payment processing — once confirmed you'll be able to submit your episode link.</p>
    </div>` : ''}

  </article>`;
}

// ── Filter & sort ─────────────────────────────────────────────────────
function getFilteredSorted() {
  // Deduplicate by title (primary) — keep the match with most data / highest score
  const byTitle = new Map();
  for (const m of state.matches) {
    const title = (m.podcasts?.title || '').toLowerCase().trim();
    const key   = title || m.podcast_id || m.id;
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, m);
    } else {
      // Prefer: higher fit_score, or more podcast data (has title), or booked status
      const mScore = m.fit_score || 0;
      const eScore = existing.fit_score || 0;
      const mHasData = !!(m.podcasts?.total_episodes || m.podcasts?.contact_email);
      const eHasData = !!(existing.podcasts?.total_episodes || existing.podcasts?.contact_email);
      const mBooked = m.status === 'booked';
      const eBooked = existing.status === 'booked';
      if (mBooked && !eBooked) {
        byTitle.set(key, m);
      } else if (!eBooked && (mScore > eScore || (mScore === eScore && mHasData && !eHasData))) {
        byTitle.set(key, m);
      }
    }
  }
  let matches = [...byTitle.values()];

  if (state.filter === 'content_boost') {
    matches = matches.filter((m) => !!m.content_boost_status);
  } else if (state.filter !== 'all') {
    matches = matches.filter((m) => m.status === state.filter);
  }
  if (state.minScore > 0) {
    matches = matches.filter((m) => (m.fit_score || 0) >= state.minScore);
  }
  if (state.hasEmailOnly) {
    matches = matches.filter((m) => m.podcasts?.contact_email);
  }
  if (state.hasContactOnly) {
    matches = matches.filter((m) => {
      const p = m.podcasts || {};
      return p.contact_email || p.booking_page_url || p.guest_application_url;
    });
  }

  if (state.sortBy === 'fit_score') {
    matches.sort((a, b) => (b.fit_score || 0) - (a.fit_score || 0));
  } else if (state.sortBy === 'discovered_at') {
    matches.sort((a, b) => new Date(b.discovered_at) - new Date(a.discovered_at));
  } else if (state.sortBy === 'booking_likelihood') {
    const order = { high: 3, medium: 2, low: 1 };
    matches.sort((a, b) => (order[b.booking_likelihood] || 0) - (order[a.booking_likelihood] || 0));
  }

  // Restored cards always float to the top of New tab
  if (state.filter === 'new') {
    matches.sort((a, b) => {
      if (a.restored_at && !b.restored_at) return -1;
      if (!a.restored_at && b.restored_at) return 1;
      if (a.restored_at && b.restored_at) return new Date(b.restored_at) - new Date(a.restored_at);
      return 0;
    });
  }

  return matches;
}

// ── Render grid ───────────────────────────────────────────────────────
function renderGrid() {
  const grid      = $('cards-grid');
  const noResults = $('no-results');
  if (!grid) return;

  const filtered = getFilteredSorted();

  if (filtered.length === 0) {
    grid.innerHTML = '';
    if (noResults) noResults.style.display = 'block';
  } else {
    if (noResults) noResults.style.display = 'none';
    grid.innerHTML = filtered.map(renderMatchCard).join('');
  }
}

// ── Render full dashboard ─────────────────────────────────────────────
function renderDashboard(data) {
  const { client, matches, stats } = data;
  state.client  = client;
  state.matches = matches || [];
  state.stats   = stats  || {};

  // Show reply badge — only for replied matches not yet seen by user
  const seenKey = `seen_replied_${state.token}`;
  const seenIds = new Set(JSON.parse(localStorage.getItem(seenKey) || '[]'));
  const unseenReplied = (matches || []).filter(m => m.status === 'replied' && !seenIds.has(m.id));
  const badge = document.getElementById('reply-badge');
  if (badge) {
    if (unseenReplied.length > 0) { badge.textContent = unseenReplied.length; badge.style.display = 'inline-flex'; }
    else { badge.style.display = 'none'; }
  }

  // Client header
  const clientNameEl = $('client-name');
  const clientSubEl  = $('client-subtitle');
  if (clientNameEl) clientNameEl.textContent = client.name || 'Your Pipeline';
  if (clientSubEl) {
    clientSubEl.style.display = 'none';
  }
  // Hide START HERE if already clicked before
  const startHereEl = $('start-here-label');
  if (startHereEl && localStorage.getItem(`pp-start-here-gone-${state.token}`)) {
    startHereEl.style.display = 'none';
  }

  const lastRunBadge = $('last-run-badge');
  if (lastRunBadge) {
    lastRunBadge.textContent = client.last_run_at
      ? (() => { const d = new Date(client.last_run_at.endsWith('Z') ? client.last_run_at : client.last_run_at + 'Z'); return isNaN(d) ? '' : `Last updated ${d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`; })()
      : '';
  }

  // Navbar right: profile dropdown trigger
  const navbarRight = $('navbar-right');
  if (navbarRight) {
    navbarRight.innerHTML = `
      <button class="profile-trigger" id="profile-trigger" onclick="toggleProfileDropdown()">
        Settings <span style="opacity:0.5;font-size:11px;">▾</span>
      </button>`;
  }

  // Populate dropdown
  const dropdownInfo = $('dropdown-client-info');
  if (dropdownInfo) {
    dropdownInfo.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:var(--text-primary);">${esc(client.name || '')}</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${esc(client.email || '')}</div>`;
  }

  const gmailItem = $('dropdown-gmail-item');
  if (gmailItem) {
    if (client.gmail_email) {
      const gmailLabel = client.gmail_email === 'connected' ? 'Gmail Connected' : `Gmail: ${client.gmail_email}`;
      gmailItem.innerHTML = `<span style="color:var(--success);font-size:13px;">${gmailLabel}</span>`;
      gmailItem.style.cursor = 'default';
    } else {
      gmailItem.innerHTML = `<a href="/auth/gmail?clientId=${esc(client.id)}" style="color:var(--accent);text-decoration:none;font-size:13px;">Connect Gmail</a>`;
    }
  }

  // Populate saved templates section in dropdown
  const templatesSection = $('dropdown-templates-section');
  if (templatesSection) {
    const templates = client.email_templates || [];
    if (templates.length > 0) {
      templatesSection.innerHTML = `
        <div class="dropdown-divider"></div>
        <div style="padding:8px 16px 4px;font-size:11px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.05em;">Saved Templates</div>
        ${templates.map((t) => `
          <button class="dropdown-item" style="font-size:13px;" onclick="loadTemplate('${esc(t.id)}')">${esc(t.name)}</button>
        `).join('')}`;
    } else {
      templatesSection.innerHTML = '';
    }
  }

  // Gmail connect is handled via the profile dropdown only

  // Set theme toggle label
  const themeLabel = $('theme-toggle-label');
  if (themeLabel) {
    const isLight = document.documentElement.classList.contains('light-mode');
    themeLabel.textContent = isLight ? 'Dark Mode' : 'Light Mode';
  }

  // Close dropdown when clicking outside (attach once only)
  if (!window._dropdownListenerAdded) {
    window._dropdownListenerAdded = true;
    document.addEventListener('click', (e) => {
      const trigger = $('profile-trigger');
      const dropdown = $('profile-dropdown');
      if (dropdown && trigger && !trigger.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    }, true);
  }

  // Stats
  const highCount = state.matches.filter((m) => (m.fit_score || 0) >= 60).length;
  const avgScore  = state.matches.length > 0
    ? Math.round(state.matches.reduce((s, m) => s + (m.fit_score || 0), 0) / state.matches.length)
    : 0;
  renderStats({
    total:    state.matches.length,
    high:     highCount,
    avgScore,
    approved: state.matches.filter((m) => m.status === 'approved').length,
    sent:     state.matches.filter((m) => m.status === 'sent').length,
    booked:   state.matches.filter((m) => m.status === 'booked').length,
  });

  // Gmail connected URL param notification
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('gmailConnected') === 'true') {
    const banner = $('notification-banner');
    if (banner) {
      banner.textContent = 'Gmail connected successfully! Pitch drafts will now be created directly in your inbox.';
      banner.style.display = 'block';
      setTimeout(() => { banner.style.display = 'none'; }, 6000);
    }
    window.history.replaceState({}, '', window.location.pathname);
  }

  // Profile photo
  const headerAvatar   = document.getElementById('header-avatar');
  const dropdownAvatar = document.getElementById('dropdown-avatar');
  if (client.photo_url) {
    if (headerAvatar)   { headerAvatar.src = client.photo_url;   headerAvatar.style.display = 'block'; }
    if (dropdownAvatar) { dropdownAvatar.src = client.photo_url; dropdownAvatar.style.display = 'block'; }
  } else {
    if (headerAvatar)   headerAvatar.style.display = 'none';
    if (dropdownAvatar) dropdownAvatar.style.display = 'none';
  }

  renderVisionBoard(client);
  renderGrid();
  updateStatBadges(); // renders hero section + tab counts + stat numbers

  $('loading-state').style.display   = 'none';
  $('dashboard-content').style.display = 'block';
}

// ── Load dashboard data ───────────────────────────────────────────────
async function loadDashboard() {
  state.token = extractToken();

  if (!state.token) {
    $('loading-state').style.display = 'none';
    $('empty-state').style.display   = 'flex';
    return;
  }

  try {
    const res  = await fetch(`/api/dashboard/${state.token}`);
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
    renderDashboard(data);
    // Check for host replies in the background — auto-moves cards to Replied tab
    checkForReplies();
  } catch (err) {
    $('loading-state').style.display = 'none';
    $('error-state').style.display   = 'flex';
    const msgEl = $('error-message-text');
    if (msgEl) msgEl.textContent = err.message || 'Unknown error. Check your dashboard URL.';
  }
}

// ── Update match in state ─────────────────────────────────────────────
function updateMatchInState(matchId, updates) {
  const idx = state.matches.findIndex((m) => m.id === matchId);
  if (idx !== -1) state.matches[idx] = { ...state.matches[idx], ...updates };
}

// ── Update a card in-place ────────────────────────────────────────────
function updateCard(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;
  const card = $(`card-${matchId}`);
  if (!card) { renderGrid(); return; }
  if (state.filter !== 'all' && match.status !== state.filter) { renderGrid(); return; }
  const tmp = document.createElement('div');
  tmp.innerHTML = renderMatchCard(match);
  card.replaceWith(tmp.firstElementChild);
}

// ── Switch active filter tab programmatically ─────────────────────────
function switchToFilter(status) {
  const tabs = $('filter-tabs');
  if (!tabs) return;
  tabs.querySelectorAll('.filter-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.status === status);
  });
  state.filter = status;
  renderGrid();
}

// ── Update stat badges live ───────────────────────────────────────────
function updateStatBadges() {
  const m = state.matches;
  renderStats({
    total:    m.length,
    high:     m.filter((x) => (x.fit_score || 0) >= 60).length,
    avgScore: m.length > 0
      ? Math.round(m.reduce((s, x) => s + (x.fit_score || 0), 0) / m.length)
      : 0,
    approved: m.filter((x) => x.status === 'approved').length,
    sent:     m.filter((x) => x.status === 'sent').length,
    booked:   m.filter((x) => x.status === 'booked').length,
  });

  // Refresh hero subtitle, onboarding checklist, content boost tab
  renderHeroSection();
  renderOnboardingChecklist();
  updateContentBoostTab();

  // Update tab count badges
  const tabCounts = {};
  m.forEach((x) => { tabCounts[x.status] = (tabCounts[x.status] || 0) + 1; });
  const tabs = $('filter-tabs');
  if (tabs) {
    tabs.querySelectorAll('.filter-tab').forEach((t) => {
      const st = t.dataset.status;
      // Remove old count badge (not the reply badge)
      t.querySelectorAll('.tab-count').forEach((el) => el.remove());
      const cnt = tabCounts[st] || 0;
      if (cnt > 0) {
        const badge = document.createElement('span');
        badge.className = 'tab-count';
        badge.textContent = cnt;
        t.appendChild(badge);
      }
    });
  }
}

// ── Card loading state helper ─────────────────────────────────────────
function setCardLoading(matchId, loading) {
  const card = $(`card-${matchId}`);
  if (!card) return;
  card.querySelectorAll('.btn').forEach((b) => (b.disabled = loading));
}

// ── Actions ───────────────────────────────────────────────────────────
async function approveMatch(matchId) {
  setCardLoading(matchId, true);
  try {
    const data = await apiPost('/api/approve', { matchId });
    if (data.success) {
      updateMatchInState(matchId, { status: 'approved', approved_at: data.match?.approved_at });
      updateCard(matchId);
      updateStatBadges();
      showToast('Approved — writing your pitch email now…', 'success');
      // Poll for email content (written async on server)
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const res = await fetch(`/api/dashboard/${state.token}`);
          const d = await res.json();
          if (d.success) {
            const updated = (d.matches || []).find((m) => m.id === matchId);
            if (updated?.email_subject) {
              updateMatchInState(matchId, { email_subject: updated.email_subject, email_body: updated.email_body, gmail_draft_id: updated.gmail_draft_id });
              updateCard(matchId);
              clearInterval(poll);
            }
          }
        } catch (_) {}
        if (attempts >= 12) clearInterval(poll); // stop after 60s
      }, 5000);
    } else {
      showToast(data.error || 'Approve failed.', 'error');
    }
  } catch { showToast('Network error. Please try again.', 'error'); }
  finally  { setCardLoading(matchId, false); }
}

async function dismissMatch(matchId) {
  setCardLoading(matchId, true);
  try {
    const data = await apiPost('/api/dismiss', { matchId });
    if (data.success) {
      updateMatchInState(matchId, { status: 'dismissed' });
      updateCard(matchId);
      updateStatBadges();
      showToast('Match ignored.', 'info');
    } else {
      showToast(data.error || 'Dismiss failed.', 'error');
    }
  } catch { showToast('Network error. Please try again.', 'error'); }
  finally  { setCardLoading(matchId, false); }
}

async function restoreMatch(matchId) {
  setCardLoading(matchId, true);
  try {
    const data = await apiPost('/api/restore', { matchId });
    if (data.success) {
      updateMatchInState(matchId, { status: 'new', restored_at: new Date().toISOString() });
      updateCard(matchId);
      updateStatBadges();
      showToast('↩ Restored to New!', 'success');
    } else {
      showToast(data.error || 'Restore failed.', 'error');
    }
  } catch { showToast('Network error. Please try again.', 'error'); }
  finally  { setCardLoading(matchId, false); }
}

async function dreamMatch(matchId) {
  setCardLoading(matchId, true);
  try {
    const data = await apiPost('/api/dream', { matchId });
    if (data.success) {
      updateMatchInState(matchId, { status: 'dream' });
      updateCard(matchId);
      updateStatBadges();
      showToast('Added to your Dream list.', 'success');
    } else {
      showToast(data.error || 'Failed.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
  finally { setCardLoading(matchId, false); }
}
window.dreamMatch = dreamMatch;

async function doSendMatch(matchId) {
  // Auto-save whatever is in the pitch editor before sending
  const bodyEl    = $(`pitch-body-${matchId}`);
  const subjectEl = $(`pitch-subject-select-${matchId}`);
  if (bodyEl?.value.trim()) {
    try {
      await apiPost('/api/save-pitch', {
        matchId,
        subject: getSubjectValue(matchId),
        body:    bodyEl.value.trim(),
      });
      updateMatchInState(matchId, { email_subject: getSubjectValue(matchId), email_body: bodyEl.value.trim() });
    } catch { /* non-fatal — proceed to send anyway */ }
  }
  setCardLoading(matchId, true);
  try {
    const data = await apiPost('/api/send', { matchId });
    if (data.success) {
      updateMatchInState(matchId, { status: 'sent', sent_at: data.match?.sent_at });
      updateStatBadges();
      showToast('Email sent successfully!', 'success');
      switchToFilter('sent');
    } else {
      showToast(data.error || 'Send failed.', 'error');
    }
  } catch { showToast('Network error. Please try again.', 'error'); }
  finally  { setCardLoading(matchId, false); }
}

async function sendMatch(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;

  // If card is new (not yet approved), approve first to trigger email generation
  if (match.status === 'new' || match.status === 'dream') {
    setCardLoading(matchId, true);
    showToast('Generating your pitch email…', 'info');
    const approveData = await apiPost('/api/approve', { matchId });
    if (!approveData.success) {
      setCardLoading(matchId, false);
      showToast(approveData.error || 'Could not generate pitch.', 'error');
      return;
    }
    updateMatchInState(matchId, { status: 'approved' });
    updateCard(matchId);
    setCardLoading(matchId, false);
    // Poll for email to be written then open confirm modal
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      const fresh = state.matches.find((m) => m.id === matchId);
      if ((fresh?.email_subject || fresh?.email_body) || attempts >= 12) {
        clearInterval(poll);
        showSendConfirmModal(matchId);
      }
    }, 3000);
    return;
  }

  showSendConfirmModal(matchId);
}

function showSendConfirmModal(matchId) {
  const overlay = $('confirm-modal');
  if (!overlay) { doSendMatch(matchId); return; }
  const match = state.matches.find((m) => m.id === matchId);
  const showName = match?.podcasts?.title || 'this podcast';
  const showNameEl = $('confirm-send-show-name');
  if (showNameEl) showNameEl.textContent = showName;
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const confirmBtn = $('confirm-send-btn');
  const freshBtn = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(freshBtn, confirmBtn);

  freshBtn.addEventListener('click', async () => {
    closeConfirmModal();
    await doSendMatch(matchId);
  });
}

function closeConfirmModal() {
  const overlay = $('confirm-modal');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
}

async function bookMatch(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;
  setCardLoading(matchId, true);
  try {
    if (match.status === 'booked') {
      // Unbook
      const data = await apiPost('/api/unbook', { matchId });
      if (data.success) {
        updateMatchInState(matchId, { status: 'approved', booked_at: null });
        updateCard(matchId);
        updateStatBadges();
        showToast('Booking undone.', 'info');
      } else {
        showToast(data.error || 'Unbook failed.', 'error');
      }
    } else {
      // Book
      const data = await apiPost('/api/book', { matchId });
      if (data.success) {
        updateMatchInState(matchId, { status: 'booked', booked_at: data.match?.booked_at });
        switchToFilter('booked');
        updateStatBadges();
        showBookingCelebration(matchId);
      } else {
        showToast(data.error || 'Book failed.', 'error');
      }
    }
  } catch { showToast('Network error. Please try again.', 'error'); }
  finally  { setCardLoading(matchId, false); }
}

async function markAppeared(matchId) {
  setCardLoading(matchId, true);
  try {
    const data = await apiPost('/api/appeared', { matchId });
    if (data.success) {
      updateMatchInState(matchId, { status: 'appeared' });
      updateCard(matchId);
      updateStatBadges();
      showAiredCelebration(matchId);
    } else {
      showToast(data.error || 'Failed.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
  finally { setCardLoading(matchId, false); }
}
window.markAppeared = markAppeared;

// ── Aired celebration modal ───────────────────────────────────────────
function estimateAudience(listenScore) {
  const ls = listenScore || 0;
  if      (ls >= 80) return { low: 500000,  label: '500,000+' };
  else if (ls >= 65) return { low: 100000,  label: '100,000+' };
  else if (ls >= 50) return { low: 20000,   label: '20,000+'  };
  else if (ls >= 35) return { low: 5000,    label: '5,000+'   };
  else if (ls >= 20) return { low: 1000,    label: '1,000+'   };
  else               return { low: 500,     label: 'hundreds of' };
}

function getLifetimeAudience() {
  return state.matches
    .filter((m) => m.status === 'appeared')
    .reduce((total, m) => total + (estimateAudience(m.podcasts?.listen_score).low), 0);
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(0) + 'K';
  return n.toLocaleString();
}

function showAiredCelebration(matchId) {
  const modal = $('aired-celebration-modal');
  const body  = $('aired-celebration-body');
  if (!modal || !body) return;

  const match    = state.matches.find((m) => m.id === matchId);
  const podcast  = match?.podcasts || match;
  const title    = podcast?.title || 'the show';
  const audience = estimateAudience(podcast?.listen_score);
  const lifetime = getLifetimeAudience();
  const airedCount = state.matches.filter((m) => m.status === 'appeared').length;

  body.innerHTML = `
    <div style="font-size:52px;margin-bottom:12px;line-height:1;">🌟</div>
    <h2 style="font-size:24px;font-weight:800;color:var(--text-primary);letter-spacing:-0.03em;margin-bottom:6px;">You just went live.</h2>
    <p style="font-size:14px;color:var(--text-secondary);margin-bottom:20px;">${esc(title)}</p>

    <div style="background:linear-gradient(135deg,#eef2ff,#f5f3ff);border:1px solid rgba(99,102,241,0.15);border-radius:14px;padding:20px;margin-bottom:16px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--accent);margin-bottom:4px;">This episode</div>
      <div style="font-size:32px;font-weight:800;color:var(--text-primary);letter-spacing:-0.04em;line-height:1;">${audience.label}</div>
      <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;">estimated listeners reached</div>
    </div>

    ${airedCount > 1 ? `
    <div style="background:rgba(48,209,88,0.07);border:1px solid rgba(48,209,88,0.18);border-radius:14px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--success);margin-bottom:4px;">Your lifetime reach</div>
      <div style="font-size:28px;font-weight:800;color:var(--text-primary);letter-spacing:-0.04em;line-height:1;">${formatNumber(lifetime)} ears</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">across ${airedCount} episodes</div>
    </div>` : ''}

    <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px;">
      <button class="btn btn-primary" onclick="closeAiredCelebration();showContentBoostModal();" style="width:100%;">
        Turn this into 30 days of content
      </button>
      <button class="btn btn-secondary" onclick="closeAiredCelebration();" style="width:100%;">
        Back to dashboard
      </button>
    </div>`;

  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeAiredCelebration() {
  const modal = $('aired-celebration-modal');
  if (!modal) return;
  modal.style.display = 'none';
  document.body.style.overflow = '';
}
window.closeAiredCelebration = closeAiredCelebration;

async function markReplied(matchId) {
  setCardLoading(matchId, true);
  try {
    const data = await apiPost('/api/update-status', { matchId, status: 'replied' });
    if (data.success) {
      updateMatchInState(matchId, { status: 'replied' });
      updateCard(matchId);
      renderStatsStrip();
      showToast('💬 Moved to Host Replied!', 'success');
    } else {
      showToast(data.error || 'Failed.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
  finally { setCardLoading(matchId, false); }
}
window.markReplied = markReplied;

// ── Subject preset picker ─────────────────────────────────────────────
function applySubjectPreset(matchId) {
  const sel    = $(`pitch-subject-select-${matchId}`);
  const custom = $(`pitch-subject-custom-${matchId}`);
  if (!sel || !custom) return;
  if (sel.value === '__custom__') {
    custom.style.display = 'block';
    custom.focus();
  } else {
    custom.style.display = 'none';
  }
}
window.applySubjectPreset = applySubjectPreset;

// Helper: get the resolved subject value for a match editor
function getSubjectValue(matchId) {
  const sel    = $(`pitch-subject-select-${matchId}`);
  const custom = $(`pitch-subject-custom-${matchId}`);
  if (!sel) return '';
  if (sel.value === '__custom__') return custom?.value.trim() || '';
  return sel.value;
}

// ── Pitch generator ───────────────────────────────────────────────────
function togglePitchArea(matchId) {
  const editor = $(`pitch-editor-${matchId}`);
  if (!editor) return;
  const isVisible = editor.style.display !== 'none';
  editor.style.display = isVisible ? 'none' : 'flex';
  editor.style.flexDirection = 'column';
  if (!isVisible) {
    const match = state.matches.find((m) => m.id === matchId);
    const bodyEl    = $(`pitch-body-${matchId}`);
    const subjectEl = $(`pitch-subject-select-${matchId}`);
    // Auto-generate if no pitch exists yet
    if (bodyEl && !match?.email_body) {
      autoGeneratePitch(matchId, bodyEl, subjectEl);
    }
  }
}
window.togglePitchArea = togglePitchArea;

// ── Core pitch generation — used by both auto-generate and rewrite ─────
async function generatePitch(matchId, { clearFirst = false } = {}) {
  const bodyEl    = $(`pitch-body-${matchId}`);
  const subjectEl = $(`pitch-subject-select-${matchId}`);
  const rewriteBtn = document.querySelector(`[onclick="regeneratePitch('${matchId}')"]`);
  if (!bodyEl) return;

  const previousBody    = bodyEl.value;
  const previousSubject = subjectEl?.value || '';

  if (clearFirst) {
    bodyEl.value       = '';
    if (subjectEl) subjectEl.value = '';
  }
  bodyEl.placeholder = '✨ Writing your pitch…';
  bodyEl.disabled    = true;
  if (rewriteBtn) { rewriteBtn.disabled = true; rewriteBtn.textContent = '✦ Writing…'; }

  try {
    const data = await apiPost('/api/generate-pitch', { matchId });
    if (data.success) {
      if (subjectEl) subjectEl.value = data.subject || '';
      bodyEl.value = data.body || '';
      bodyEl.placeholder = 'Your pitch email…';
      updateMatchInState(matchId, { email_subject: data.subject, email_body: data.body });
      showToast('Pitch generated!', 'success');
    } else {
      // Restore previous content — don't leave user with a blank field
      bodyEl.value = previousBody;
      if (subjectEl) subjectEl.value = previousSubject;
      bodyEl.placeholder = 'Your pitch email…';
      showToast(data.error || 'Could not generate pitch. Try again.', 'error');
    }
  } catch {
    bodyEl.value = previousBody;
    if (subjectEl) subjectEl.value = previousSubject;
    bodyEl.placeholder = 'Your pitch email…';
    showToast('Network error. Please try again.', 'error');
  } finally {
    bodyEl.disabled = false;
    if (rewriteBtn) { rewriteBtn.disabled = false; rewriteBtn.textContent = '✦ Rewrite Pitch'; }
  }
}

async function autoGeneratePitch(matchId, bodyEl, subjectEl) {
  // Thin wrapper used when pitch area first opens with no content
  await generatePitch(matchId, { clearFirst: true });
}

async function regeneratePitch(matchId) {
  await generatePitch(matchId, { clearFirst: false });
}
window.regeneratePitch = regeneratePitch;

async function savePitch(matchId) {
  const bodyEl    = $(`pitch-body-${matchId}`);
  const subjectEl = $(`pitch-subject-select-${matchId}`);
  if (!bodyEl) return;
  const body    = bodyEl.value.trim();
  const subject = getSubjectValue(matchId);
  try {
    const data = await apiPost('/api/save-pitch', { matchId, subject, body });
    if (data.success) {
      updateMatchInState(matchId, { email_subject: subject, email_body: body });
      showToast('Pitch saved!', 'success');
    } else {
      showToast(data.error || 'Save failed.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
}
window.savePitch = savePitch;

function copyPitch(matchId) {
  const bodyEl    = $(`pitch-body-${matchId}`);
  const subjectEl = $(`pitch-subject-select-${matchId}`);
  const text = `Subject: ${getSubjectValue(matchId)}\n\n${bodyEl?.value || ''}`;
  navigator.clipboard.writeText(text).then(() => showToast('Pitch copied!', 'success'));
}
window.copyPitch = copyPitch;

// ── Interview prep modal ──────────────────────────────────────────────
function showInterviewPrepModal(matchId) {
  const modal = $('interview-prep-modal');
  if (!modal) return;
  const match   = state.matches.find((m) => m.id === matchId);
  const podcast = match?.podcasts || {};
  const titleEl = $('prep-podcast-title');
  if (titleEl) titleEl.textContent = podcast.title || 'this podcast';

  const contentEl = $('prep-content');
  if (contentEl) {
    if (match?.interview_prep) {
      try {
        const prep = typeof match.interview_prep === 'string'
          ? JSON.parse(match.interview_prep) : match.interview_prep;
        contentEl.innerHTML = `
          <div class="prep-section"><strong>About the host</strong><p>${esc(prep.host_background || '')}</p></div>
          <div class="prep-section"><strong>Show format</strong><p>${esc(prep.show_format || '')}</p></div>
          <div class="prep-section"><strong>Suggested topics</strong><ul>${(prep.suggested_topics||[]).map(t=>`<li>${esc(t)}</li>`).join('')}</ul></div>
          <div class="prep-section"><strong>Likely questions</strong><ul>${(prep.likely_questions||[]).map(q=>`<li>${esc(q)}</li>`).join('')}</ul></div>
          <div class="prep-section"><strong>Your talking points</strong><ul>${(prep.talking_points||[]).map(p=>`<li>${esc(p)}</li>`).join('')}</ul></div>
          <div class="prep-section" style="background:#fff8f0;border:1px solid #f59e0b;border-radius:8px;padding:12px;"><strong>⚠️ One thing to avoid</strong><p>${esc(prep.one_thing_to_avoid || '')}</p></div>`;
      } catch { contentEl.innerHTML = '<p>Loading prep…</p>'; }
    } else {
      contentEl.innerHTML = '<p style="color:var(--text-secondary);font-size:14px;">Generating your prep briefing…</p>';
      apiPost('/api/interview-prep', { matchId }).then((data) => {
        if (!contentEl) return;
        if (data.success) {
          const prep = data.prep;
          contentEl.innerHTML = `
            <div class="prep-section"><strong>About the host</strong><p>${esc(prep.host_background||'')}</p></div>
            <div class="prep-section"><strong>Show format</strong><p>${esc(prep.show_format||'')}</p></div>
            <div class="prep-section"><strong>Suggested topics</strong><ul>${(prep.suggested_topics||[]).map(t=>`<li>${esc(t)}</li>`).join('')}</ul></div>
            <div class="prep-section"><strong>Likely questions</strong><ul>${(prep.likely_questions||[]).map(q=>`<li>${esc(q)}</li>`).join('')}</ul></div>
            <div class="prep-section"><strong>Your talking points</strong><ul>${(prep.talking_points||[]).map(p=>`<li>${esc(p)}</li>`).join('')}</ul></div>
            <div class="prep-section" style="background:#fff8f0;border:1px solid #f59e0b;border-radius:8px;padding:12px;"><strong>⚠️ One thing to avoid</strong><p>${esc(prep.one_thing_to_avoid||'')}</p></div>`;
          updateMatchInState(matchId, { interview_prep: JSON.stringify(prep) });
        } else {
          contentEl.innerHTML = `<p style="color:var(--danger);font-size:14px;">Could not generate prep — ${esc(data.error || 'please try again')}.</p>`;
        }
      }).catch(() => {
        if (contentEl) contentEl.innerHTML = '<p style="color:var(--danger);font-size:14px;">Network error — please close and try again.</p>';
      });
    }
  }
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
window.showInterviewPrepModal = showInterviewPrepModal;

function closeInterviewPrepModal() {
  const modal = $('interview-prep-modal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
}
window.closeInterviewPrepModal = closeInterviewPrepModal;

// ── Notes ─────────────────────────────────────────────────────────────
function toggleNoteArea(matchId) {
  const editor = $(`note-editor-${matchId}`);
  if (!editor) return;
  const isVisible = editor.style.display === 'flex';
  editor.style.display = isVisible ? 'none' : 'flex';
  editor.style.flexDirection = 'column';
  if (!isVisible) {
    const ta = $(`note-text-${matchId}`);
    if (ta) ta.focus();
  }
}

async function saveNote(matchId) {
  const textarea = $(`note-text-${matchId}`);
  if (!textarea) return;
  const notes = textarea.value.trim();
  try {
    const data = await apiPost('/api/notes', { matchId, notes });
    if (data.success) {
      updateMatchInState(matchId, { client_notes: notes });
      updateCard(matchId);
      showToast('Note saved.', 'success');
    } else {
      showToast(data.error || 'Failed to save note.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
}

// ── Email modal ───────────────────────────────────────────────────────
function openEmailModal(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;
  const podcast = match.podcasts || {};
  state.modalMatchId = matchId;

  const titleEl = $('email-modal-title');
  if (titleEl) titleEl.textContent = `Email Draft — ${podcast.title || 'Unknown Show'}`;

  const subjectEl = $('modal-subject');
  const bodyEl    = $('modal-body-text');
  if (subjectEl) subjectEl.value = match.email_subject_edited || match.email_subject || '';
  if (bodyEl)    bodyEl.value    = match.email_body_edited    || match.email_body    || '';
  if (subjectEl && bodyEl && !subjectEl.value && !bodyEl.value) {
    bodyEl.placeholder = 'Approve this match to generate your personalised pitch email.';
  }

  // Contact info row
  const contactRow = $('email-contact-row');
  if (contactRow) {
    const chips = [];
    if (podcast.contact_email)       chips.push(`<a class="contact-chip" href="#" onclick="copyEmail(event,'${esc(podcast.contact_email)}')">${esc(podcast.contact_email)}</a>`);
    if (podcast.website)             chips.push(`<a class="contact-chip" href="${esc(podcast.website)}" target="_blank">Website</a>`);
    if (podcast.booking_page_url)    chips.push(`<a class="contact-chip" href="${esc(podcast.booking_page_url)}" target="_blank">Booking Page</a>`);
    if (chips.length > 0) {
      contactRow.innerHTML = chips.join('');
      contactRow.style.display = 'flex';
    } else {
      contactRow.style.display = 'none';
    }
  }

  // Show/hide approve button
  const approveBtn = $('email-approve-btn');
  if (approveBtn) {
    approveBtn.style.display = match.status === 'new' ? 'inline-flex' : 'none';
  }

  $('email-modal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeEmailModal() {
  $('email-modal').style.display = 'none';
  document.body.style.overflow = '';
  state.modalMatchId = null;
}

async function saveEmailDraft() {
  const matchId = state.modalMatchId;
  if (!matchId) return;
  const subject = $('modal-subject')?.value || '';
  const body    = $('modal-body-text')?.value || '';
  try {
    const data = await apiPost('/api/email/edit', { matchId, subject, body });
    if (data.success) {
      updateMatchInState(matchId, { email_subject_edited: subject, email_body_edited: body });
      showToast('Email draft saved.', 'success');
    } else {
      showToast(data.error || 'Save failed.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
}

function copyEmailDraft() {
  const subject = $('modal-subject')?.value || '';
  const body    = $('modal-body-text')?.value || '';
  const text    = `Subject: ${subject}\n\n${body}`;
  navigator.clipboard.writeText(text)
    .then(() => showToast('Email copied to clipboard!', 'success'))
    .catch(() => showToast('Could not copy — please copy manually.', 'error'));
}

// ── Contact modal ─────────────────────────────────────────────────────
function openContactModal(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;
  const p = match.podcasts || {};
  state.contactModalId = matchId;

  const titleEl = $('contact-modal-title');
  if (titleEl) titleEl.textContent = p.title || 'Podcast Details';

  // Build social links
  const socialLinks = [];
  if (p.instagram_url)     socialLinks.push(`<a href="${esc(p.instagram_url)}" target="_blank" class="social-link">Instagram</a>`);
  if (p.twitter_url)       socialLinks.push(`<a href="${esc(p.twitter_url)}" target="_blank" class="social-link">Twitter/X</a>`);
  if (p.facebook_url)      socialLinks.push(`<a href="${esc(p.facebook_url)}" target="_blank" class="social-link">Facebook</a>`);
  if (p.linkedin_page_url) socialLinks.push(`<a href="${esc(p.linkedin_page_url)}" target="_blank" class="social-link">LinkedIn</a>`);
  if (p.linkedin_url)      socialLinks.push(`<a href="${esc(p.linkedin_url)}" target="_blank" class="social-link">LinkedIn</a>`);
  if (p.tiktok_url)        socialLinks.push(`<a href="${esc(p.tiktok_url)}" target="_blank" class="social-link">TikTok</a>`);

  const scoreBreakdown = `
    <div style="display:flex;flex-direction:column;gap:5px;margin-top:8px;">
      ${scoreBarHtml('Relevance',   match.relevance_score)}
      ${scoreBarHtml('Audience',    match.audience_score)}
      ${scoreBarHtml('Recency',     match.recency_score)}
      ${scoreBarHtml('Reach',       match.reach_score)}
      ${scoreBarHtml('Contact',     match.contactability_score)}
      ${match.brand_score       ? scoreBarHtml('Brand Fit',   match.brand_score) : ''}
      ${match.guest_quality_score ? scoreBarHtml('Guest Qual.', match.guest_quality_score) : ''}
    </div>`;

  // Contact rows with copy buttons
  function contactRowHtml(icon, label, value, href, isLink) {
    if (!value) return '';
    const copyBtn = `<button class="btn btn-ghost btn-xs" onclick="navigator.clipboard.writeText('${esc(value)}').then(()=>showToast('Copied!','success'))">Copy</button>`;
    const openBtn = isLink ? `<a class="btn btn-outline btn-xs" href="${esc(href || value)}" target="_blank" rel="noopener">Open</a>` : '';
    return `<div class="contact-row">
      <span class="contact-row-label">${icon} ${esc(label)}</span>
      <span class="contact-row-value" title="${esc(value)}">${esc(value)}</span>
      <div class="contact-row-actions">${copyBtn}${openBtn}</div>
    </div>`;
  }

  const body = $('contact-modal-body');
  if (!body) return;

  body.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:20px;">

      ${p.description ? `<div>
        <p class="email-label">About This Show</p>
        <p style="color:var(--text-secondary);font-size:13px;line-height:1.6;">${esc(stripHtml(p.description))}</p>
      </div>` : ''}

      <div>
        <p class="email-label">Contact Info</p>
        <div class="contact-section">
          ${p.contact_email ? `<div class="contact-row"><span class="contact-row-label"> Email</span><span class="contact-row-value" title="${esc(p.contact_email)}">${esc(p.contact_email)}</span><div class="contact-row-actions"><button class="btn btn-ghost btn-xs" onclick="copyEmail(event,'${esc(p.contact_email)}')">Copy</button></div></div>` : ''}
          ${contactRowHtml('', 'Website', p.website, p.website, true)}
          ${contactRowHtml('', 'Booking', p.booking_page_url, p.booking_page_url, true)}
          ${!p.contact_email && !p.website && !p.booking_page_url && !p.guest_application_url
            ? '<p style="color:var(--text-tertiary);font-size:13px;">No contact info found</p>' : ''}
        </div>
      </div>

      ${socialLinks.length > 0 ? `<div>
        <p class="email-label">Social Media</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">${socialLinks.join('')}</div>
      </div>` : ''}

      <div>
        <p class="email-label">Show Stats</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${p.publish_frequency ? `<span class="meta-tag">${esc(p.publish_frequency)}</span>` : ''}
          ${p.avg_episode_duration_mins ? `<span class="meta-tag">${p.avg_episode_duration_mins} min avg</span>` : ''}
          ${p.language && p.language !== 'English' ? `<span class="meta-tag">${esc(p.language)}</span>` : ''}
          ${p.country ? `<span class="meta-tag">${esc(p.country)}</span>` : ''}
          ${p.listen_score      ? `<span class="meta-tag">Listen Score: ${p.listen_score}</span>` : ''}
          ${p.youtube_subscribers ? `<span class="meta-tag">${(p.youtube_subscribers >= 1000 ? (p.youtube_subscribers/1000).toFixed(0)+'K' : p.youtube_subscribers)} YT subs</span>` : ''}
        </div>
      </div>

      <div>
        <p class="email-label">Score Breakdown</p>
        ${scoreBreakdown}
      </div>

      ${match.why_this_client_fits ? `<div>
        <p class="email-label">Why You Fit</p>
        <p style="color:var(--text-secondary);font-size:13px;line-height:1.6;">${esc(match.why_this_client_fits)}</p>
      </div>` : ''}

      ${match.best_pitch_angle ? `<div>
        <p class="email-label">Best Pitch Angle</p>
        <p style="color:var(--accent-hover);font-size:13px;font-weight:500;line-height:1.5;">${esc(match.best_pitch_angle)}</p>
      </div>` : ''}

    </div>`;

  $('contact-modal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeContactModal() {
  $('contact-modal').style.display = 'none';
  document.body.style.overflow = '';
  state.contactModalId = null;
}

// ── Profile dropdown ──────────────────────────────────────────────────
function toggleProfileDropdown() {
  const dropdown = $('profile-dropdown');
  const trigger  = $('profile-trigger');
  if (!dropdown || !trigger) return;
  const isOpen = dropdown.style.display === 'block';
  dropdown.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    const rect = trigger.getBoundingClientRect();
    dropdown.style.top  = (rect.bottom + 8) + 'px';
    dropdown.style.right = (window.innerWidth - rect.right) + 'px';
    dropdown.style.left = 'auto';
  }
}

function closeProfileDropdown() {
  const d = $('profile-dropdown');
  if (d) d.style.display = 'none';
}

function toggleTheme() {
  const isLight = document.documentElement.classList.toggle('light-mode');
  localStorage.setItem('pp-theme', isLight ? 'light' : 'dark');
  const label = document.getElementById('theme-toggle-label');
  if (label) label.textContent = isLight ? 'Dark Mode' : 'Light Mode';
  closeProfileDropdown();
}

function copyDashboardLink() {
  navigator.clipboard.writeText(window.location.href)
    .then(() => showToast('Dashboard link copied!', 'success'))
    .catch(() => showToast('Could not copy link.', 'error'));
  closeProfileDropdown();
}

async function runPipeline() {
  const btn = $('header-run-pipeline');
  if (!btn || !state.client) return;

  // Prompt to connect Gmail if not yet connected
  if (!state.client.gmail_email) {
    const go = confirm('Connect your Gmail first so pitches can be sent directly from your inbox.\n\nClick OK to connect Gmail now.');
    if (go) {
      window.location.href = `/auth/gmail?clientId=${esc(state.client.id)}`;
    }
    return;
  }

  // Hide START HERE permanently after first click
  const startHereKey = `pp-start-here-gone-${state.token}`;
  if (!localStorage.getItem(startHereKey)) {
    localStorage.setItem(startHereKey, '1');
    const startHereEl = $('start-here-label');
    if (startHereEl) startHereEl.style.display = 'none';
  }

  btn.disabled = true;
  btn.style.color = '#fff';
  $('profile-dropdown').style.display = 'none';
  const steps = [
    'Scanning global podcast network…',
    'Scanning global podcast network…',
    'Filtering by audience alignment…',
    'Scoring shows by buyer intent…',
    'Ranking best-fit opportunities…',
    'Finalising your match list…',
  ];
  let stepIdx = 0;
  btn.textContent = steps[0];
  const stepInterval = setInterval(() => {
    stepIdx = (stepIdx + 1) % steps.length;
    btn.textContent = steps[stepIdx];
  }, 2200);
  try {
    const res  = await fetch(`/api/run/${state.client.id}`, { method: 'POST', headers: { 'x-dashboard-token': state.token } });
    const data = await res.json();
    if (data.success) {
      if (data.capReached) {
        showToast(data.message, 'info');
        showUnlimitedUpsell();
        btn.textContent = 'Find a Podcast';
        btn.disabled = false;
        return;
      }
      showToast(`Pipeline complete — checking for new matches…`, 'success');
      pollForNewMatches();
    } else {
      showToast('Pipeline run failed.', 'error');
    }
  } catch { showToast('Network error running pipeline.', 'error'); }
  finally { clearInterval(stepInterval); btn.textContent = 'Find a Podcast'; btn.disabled = false; btn.style.color = ''; }
}

function pollForNewMatches() {
  const knownCount = state.matches.length;
  let attempts = 0;
  const maxAttempts = 20; // poll for up to ~60s
  const interval = setInterval(async () => {
    attempts++;
    try {
      const res  = await fetch(`/api/dashboard/${state.token}`);
      const data = await res.json();
      if (data.success && data.matches) {
        const newCount = data.matches.length;
        if (newCount > knownCount) {
          clearInterval(interval);
          state.matches = data.matches;
          const added = newCount - knownCount;
          renderDashboard(data);
          showToast(`${added} new podcast match${added === 1 ? '' : 'es'} added!`, 'success');
        }
      }
    } catch { /* silent */ }
    if (attempts >= maxAttempts) clearInterval(interval);
  }, 3000);
}

function showUnlimitedUpsell() {
  const existing = document.getElementById('unlimited-upsell-banner');
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = 'unlimited-upsell-banner';
  banner.style.cssText = 'background:#faf5ff;border:2px solid #6366f1;border-radius:12px;padding:20px 24px;margin:20px 0;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;';
  banner.innerHTML = `
    <div>
      <div style="font-size:15px;font-weight:700;color:#1e293b;margin-bottom:4px;">You've hit your 10 bookings this month.</div>
      <div style="font-size:13px;color:#64748b;">You've reached your monthly limit. Get in touch to unlock unlimited pitching.</div>
    </div>
  `;
  const content = document.getElementById('dashboard-content');
  if (content) content.prepend(banner);
}

// ── Cover Image Banner ────────────────────────────────────────────────
function renderVisionBoard(client) {
  // Cover image coming soon — section intentionally left empty
}

async function triggerVisionBoardRegenerate() {
  const btn = document.getElementById('regen-vision-btn');
  if (btn) { btn.textContent = '⏳ Generating…'; btn.disabled = true; }
  const profileDropdown = document.getElementById('profile-dropdown');
  if (profileDropdown) profileDropdown.style.display = 'none';

  // Clear old image so skeleton shows while regenerating
  if (state.client) state.client.vision_board_url = null;
  window._visionBoardGenerating = true;
  if (window._visionBoardPollTimer) { clearInterval(window._visionBoardPollTimer); window._visionBoardPollTimer = null; }
  renderVisionBoard(state.client);
  showToast('🎨 Generating your vision board…', 'info');

  try {
    const data = await apiPost('/api/vision-board/generate', { token: state.token });
    if (data.success && data.imageUrl) {
      window._visionBoardGenerating = false;
      state.client.vision_board_url = data.imageUrl;
      renderVisionBoard(state.client);
      showToast('🎨 Vision board ready!', 'success');
    } else if (data.cooldown) {
      window._visionBoardGenerating = false;
      if (state.client) state.client.vision_board_url = null;
      renderVisionBoard(state.client);
      showToast(`⏳ Next generation available in ${data.hoursLeft}h`, 'info');
    } else {
      window._visionBoardGenerating = false;
      showToast(data.error || 'Generation failed.', 'error');
    }
  } catch {
    window._visionBoardGenerating = false;
    showToast('Network error.', 'error');
  }
  if (btn) { btn.textContent = '🎨 Regenerate Vision Board'; btn.disabled = false; }
}
window.triggerVisionBoardRegenerate = triggerVisionBoardRegenerate;

// ── Photo upload ──────────────────────────────────────────────────────
async function handlePhotoUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  // 5MB limit
  if (file.size > 5 * 1024 * 1024) {
    showToast('Photo must be under 5MB.', 'error');
    return;
  }

  showToast('Uploading photo…', 'info');

  try {
    const formData = new FormData();
    formData.append('photo', file);
    formData.append('token', state.token);

    const res = await fetch('/api/upload-photo', { method: 'POST', body: formData, headers: { 'x-dashboard-token': state.token || '' } });
    const data = await res.json();

    if (data.success && data.photo_url) {
      state.client.photo_url = data.photo_url;
      // Update avatars immediately
      const headerAvatar   = document.getElementById('header-avatar');
      const dropdownAvatar = document.getElementById('dropdown-avatar');
      if (headerAvatar)   { headerAvatar.src = data.photo_url;   headerAvatar.style.display = 'block'; }
      if (dropdownAvatar) { dropdownAvatar.src = data.photo_url; dropdownAvatar.style.display = 'block'; }
      showToast('Photo updated!', 'success');
    } else {
      showToast(data.error || 'Upload failed.', 'error');
    }
  } catch {
    showToast('Upload failed. Please try again.', 'error');
  }

  // Reset input so same file can be re-selected
  event.target.value = '';
}
window.handlePhotoUpload = handlePhotoUpload;

// ── Profile modal ─────────────────────────────────────────────────────
function openProfileModal() {
  const c = state.client;
  if (!c) return;
  $('profile-dropdown').style.display = 'none';
  $('profile-name').value         = c.name               || '';
  $('profile-title').value        = c.title              || '';
  $('profile-business').value     = c.business_name      || '';
  $('profile-website').value      = c.website            || '';
  $('profile-booking').value      = c.booking_link       || '';
  $('profile-instagram').value    = c.social_instagram   || '';
  $('profile-linkedin').value     = c.social_linkedin    || '';
  $('profile-twitter').value      = c.social_twitter     || '';
  $('profile-extra-links').value  = c.extra_links        || '';
  $('profile-tone').value         = c.preferred_tone     || 'warm-professional';
  $('profile-topics').value       = (c.topics            || []).join(', ');
  $('profile-angles').value       = (c.speaking_angles   || []).join(', ');
  $('profile-audience').value     = c.target_audience    || '';
  $('profile-bio-short').value    = c.bio_short          || '';
  $('profile-pitch-style').value  = c.pitch_style        || '';
  // Pace selector
  const dailyTarget = c.daily_target || 10;
  $('profile-daily').value = dailyTarget;
  const paceSelect = $('profile-daily-select');
  if (paceSelect) paceSelect.value = dailyTarget <= 5 ? '5' : dailyTarget >= 20 ? '20' : '10';

  $('profile-modal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeProfileModal() {
  $('profile-modal').style.display = 'none';
  document.body.style.overflow = '';
}

async function saveProfile() {
  if (!state.client) return;
  const splitTrim = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const updates = {
    name:             $('profile-name').value.trim(),
    title:            $('profile-title').value.trim(),
    business_name:    $('profile-business').value.trim(),
    website:          $('profile-website').value.trim(),
    booking_link:     $('profile-booking').value.trim(),
    social_instagram: $('profile-instagram').value.trim(),
    social_linkedin:  $('profile-linkedin').value.trim(),
    social_twitter:   $('profile-twitter').value.trim(),
    extra_links:      $('profile-extra-links').value.trim(),
    preferred_tone:   $('profile-tone').value,
    daily_target:     parseInt($('profile-daily-select')?.value || $('profile-daily').value, 10) || 10,
    topics:           splitTrim($('profile-topics').value),
    speaking_angles:  splitTrim($('profile-angles').value),
    target_audience:  $('profile-audience').value.trim(),
    bio_short:        $('profile-bio-short').value.trim(),
    pitch_style:      $('profile-pitch-style').value.trim(),
  };
  try {
    const data = await apiPatch(`/api/onboard/${state.client.id}`, updates);
    if (data.success) {
      const hadVisionData = !!(state.client.life_purpose || state.client.best_in_world_at);
      state.client = { ...state.client, ...data.client };
      showToast('Profile saved!', 'success');
      closeProfileModal();
      // Update name in nav
      const trigger = $('profile-trigger');
      if (trigger) trigger.innerHTML = `Settings <span style="opacity:0.5;font-size:11px;">▾</span>`;
      // If vision data was just added for the first time, trigger generation
      const nowHasVisionData = !!(state.client.life_purpose || state.client.best_in_world_at);
      if (nowHasVisionData && !state.client.vision_board_url) {
        renderVisionBoard(state.client); // will auto-trigger generation
      }
    } else {
      showToast(data.error || 'Save failed.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
}

// ── Confirm send modal ────────────────────────────────────────────────
function closeConfirmModal() {
  const overlay = $('confirm-modal');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
}

// ── Template modal ────────────────────────────────────────────────────
function openTemplateModal() {
  const modal = $('template-modal');
  if (!modal) return;

  // Load existing template if client has one
  const ta = $('template-textarea');
  if (ta && state.client?.email_template) {
    ta.value = state.client.email_template;
  } else if (ta) {
    ta.value = '';
  }

  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeTemplateModal() {
  const modal = $('template-modal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
}

async function saveTemplate() {
  const ta = $('template-textarea');
  if (!ta) return;
  const template = ta.value.trim();
  if (!state.token) return;

  try {
    const data = await apiPost('/api/template', { clientId: state.client?.id || state.token, template });
    if (data.success) {
      if (state.client) state.client.email_template = template;
      showToast('Template saved!', 'success');
      closeTemplateModal();
    } else {
      showToast(data.error || 'Save failed.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
}

function resetTemplate() {
  const ta = $('template-textarea');
  if (ta) ta.value = '';
  showToast('Template cleared — your default pitch template will be used.', 'info');
}

// ── Save as Template ──────────────────────────────────────────────────
async function saveAsTemplate() {
  const subject = $('modal-subject')?.value || '';
  const body = $('modal-body-text')?.value || '';
  if (!subject && !body) { showToast('Nothing to save.', 'error'); return; }
  const name = prompt('Name this template (e.g. "Intro pitch", "Follow-up"):');
  if (!name) return;
  const templates = state.client.email_templates ? [...state.client.email_templates] : [];
  const newTemplate = { id: Date.now().toString(), name: name.trim(), subject, body };
  templates.push(newTemplate);
  try {
    const data = await apiPatch(`/api/onboard/${state.client.id}`, { email_templates: templates });
    if (data.success) {
      state.client.email_templates = templates;
      showToast(`Template "${name}" saved.`, 'success');
    } else {
      showToast('Failed to save template.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
}

// ── Load Template ─────────────────────────────────────────────────────
function loadTemplate(templateId) {
  const templates = state.client.email_templates || [];
  const t = templates.find((x) => x.id === templateId);
  if (!t) return;
  const subjectEl = $('modal-subject');
  const bodyEl = $('modal-body-text');
  if (subjectEl && bodyEl && $('email-modal').style.display !== 'none') {
    subjectEl.value = t.subject;
    bodyEl.value = t.body;
    showToast(`Template "${t.name}" loaded.`, 'success');
  } else {
    const text = `Subject: ${t.subject}\n\n${t.body}`;
    navigator.clipboard.writeText(text)
      .then(() => showToast(`Template "${t.name}" copied to clipboard.`, 'success'))
      .catch(() => showToast('Could not copy template.', 'error'));
  }
  $('profile-dropdown').style.display = 'none';
}
window.loadTemplate = loadTemplate;

// ── Filter tabs ───────────────────────────────────────────────────────
function initFilterTabs() {
  const tabs = $('filter-tabs');
  if (!tabs) return;
  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.filter-tab');
    if (!tab) return;
    tabs.querySelectorAll('.filter-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.filter = tab.dataset.status;
    // Clear reply badge when Host Replied tab is clicked — persist seen IDs
    if (tab.dataset.status === 'replied') {
      const badge = document.getElementById('reply-badge');
      if (badge) badge.style.display = 'none';
      const seenKey = `seen_replied_${state.token}`;
      const allRepliedIds = state.matches.filter(m => m.status === 'replied').map(m => m.id);
      localStorage.setItem(seenKey, JSON.stringify(allRepliedIds));
    }
    renderGrid();
  });
}

// ── Sort select ───────────────────────────────────────────────────────
function initSortSelect() {
  const sel = $('sort-select');
  if (!sel) return;
  sel.addEventListener('change', (e) => {
    state.sortBy = e.target.value;
    renderGrid();
  });
}

// ── Extra filters ─────────────────────────────────────────────────────
function initExtraFilters() {
  const slider = $('min-score-slider');
  const valEl  = $('min-score-value');
  if (slider) {
    slider.addEventListener('input', () => {
      state.minScore = parseInt(slider.value, 10);
      if (valEl) valEl.textContent = state.minScore;
      renderGrid();
    });
  }
  const emailChk   = $('filter-has-email');
  const contactChk = $('filter-has-contact');
  if (emailChk)   emailChk.addEventListener('change',   () => { state.hasEmailOnly   = emailChk.checked;   renderGrid(); });
  if (contactChk) contactChk.addEventListener('change', () => { state.hasContactOnly = contactChk.checked; renderGrid(); });
}

// ── Modal event listeners ─────────────────────────────────────────────
function initModals() {
  // Email modal
  const emailModal = $('email-modal');
  $('email-modal-close')?.addEventListener('click', closeEmailModal);
  $('email-modal-close-btn')?.addEventListener('click', closeEmailModal);
  emailModal?.addEventListener('click', (e) => { if (e.target === emailModal) closeEmailModal(); });

  $('email-save-btn')?.addEventListener('click', saveEmailDraft);
  $('email-save-template-btn')?.addEventListener('click', saveAsTemplate);
  $('email-copy-btn')?.addEventListener('click', copyEmailDraft);
  $('email-send-btn')?.addEventListener('click', async () => {
    if (!state.modalMatchId) return;
    await saveEmailDraft();
    closeEmailModal();
    await sendMatch(state.modalMatchId);
  });
  $('email-approve-btn')?.addEventListener('click', async () => {
    if (!state.modalMatchId) return;
    const id = state.modalMatchId;
    closeEmailModal();
    await approveMatch(id);
  });

  // Contact modal
  const contactModal = $('contact-modal');
  $('contact-modal-close')?.addEventListener('click', closeContactModal);
  contactModal?.addEventListener('click', (e) => { if (e.target === contactModal) closeContactModal(); });

  // Template modal
  const templateModal = $('template-modal');
  $('template-modal-close')?.addEventListener('click', closeTemplateModal);
  $('template-modal-close-btn')?.addEventListener('click', closeTemplateModal);
  templateModal?.addEventListener('click', (e) => { if (e.target === templateModal) closeTemplateModal(); });
  $('template-save-btn')?.addEventListener('click', saveTemplate);
  $('template-reset-btn')?.addEventListener('click', resetTemplate);

  // Escape key closes any open modal
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (emailModal    && emailModal.style.display    !== 'none') closeEmailModal();
    if (contactModal  && contactModal.style.display  !== 'none') closeContactModal();
    if (templateModal && templateModal.style.display !== 'none') closeTemplateModal();
  });
}

// ── Share Win modal ───────────────────────────────────────────────────
function showShareModal(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;
  const podcastName = match.podcasts?.title || 'a podcast';
  const text = `Just landed a podcast appearance on ${podcastName} 🎙️ Excited to share my story with their audience. Find A Podcast made it happen → findapodcast.club #podcast #entrepreneur #personalbrand`;
  const textarea = $('share-text');
  if (textarea) textarea.value = text;
  const m = $('share-modal');
  if (m) { m.style.display = 'flex'; document.body.style.overflow = 'hidden'; }
}
window.showShareModal = showShareModal;

function closeShareModal() {
  const m = $('share-modal'); if (m) m.style.display = 'none';
  document.body.style.overflow = '';
}
window.closeShareModal = closeShareModal;

function copyShareText() {
  const t = $('share-text'); if (t) navigator.clipboard.writeText(t.value).then(() => showToast('Copied!', 'success'));
}
window.copyShareText = copyShareText;

function shareToTwitter() {
  const t = $('share-text'); if (!t) return;
  window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(t.value), '_blank');
}
window.shareToTwitter = shareToTwitter;

function shareToLinkedIn() {
  const t = $('share-text'); if (!t) return;
  window.open('https://www.linkedin.com/sharing/share-offsite/?url=https://findapodcast.club&summary=' + encodeURIComponent(t.value), '_blank');
}
window.shareToLinkedIn = shareToLinkedIn;

// ── Follow-up sequence presets ────────────────────────────────────────
const FOLLOWUP_SEQUENCES = {
  followup1: {
    subject: (p) => `Quick follow-up — ${p} guest spot`,
    body: (p) => `Hi [Host Name],\n\nJust wanted to follow up on my pitch to join you on ${p}.\n\nI know inboxes get busy — happy to send any extra info that would help make the decision easier.\n\nLooking forward to potentially connecting!\n\nBest,\n[Your Name]`,
  },
  followup2: {
    subject: (p) => `One more thought — ${p}`,
    body: (p) => `Hi [Host Name],\n\nFollowing up once more on my pitch for ${p}. I wanted to share a quick thought that might be relevant for your audience:\n\n[Add a specific insight, stat, or story relevant to their show's topic]\n\nI think this angle could make for a really compelling episode. Would love to explore it with you.\n\nBest,\n[Your Name]`,
  },
  followup3: {
    subject: (p) => `Last note — ${p} collaboration`,
    body: (p) => `Hi [Host Name],\n\nI'll keep this short — last follow-up on my pitch to appear on ${p}.\n\nIf the timing isn't right, no worries at all. If you'd ever like to revisit it down the track, I'd love to hear from you.\n\nWishing you and the show continued success!\n\nBest,\n[Your Name]`,
  },
};

function applyFollowUpSequence() {
  const modal     = $('followup-modal');
  const matchId   = modal?.dataset.matchId;
  const select    = $('followup-sequence-select');
  const seq       = select?.value;
  if (!seq || seq === 'custom') return;

  const match       = state.matches.find((m) => m.id === matchId);
  const podcastName = match?.podcasts?.title || 'the podcast';
  const preset      = FOLLOWUP_SEQUENCES[seq];
  if (!preset) return;

  const subjectEl = $('followup-subject');
  const bodyEl    = $('followup-body');
  if (subjectEl) subjectEl.value = preset.subject(podcastName);
  if (bodyEl)    bodyEl.value    = preset.body(podcastName);
}
window.applyFollowUpSequence = applyFollowUpSequence;

// ── Follow-up modal ───────────────────────────────────────────────────
function showFollowUpModal(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;
  const podcastName = match.podcasts?.title || 'the podcast';
  const nameEl = $('followup-podcast-name');
  if (nameEl) nameEl.textContent = podcastName;

  const saved = localStorage.getItem(`followup_template_${matchId}`);
  let subject, body;
  if (saved) {
    try { ({ subject, body } = JSON.parse(saved)); } catch { subject = null; }
  }
  if (!subject) subject = `Following up — ${podcastName} guest appearance`;
  if (!body) body = `Hi [Host Name],\n\nI wanted to follow up on my pitch to appear on ${podcastName}. I believe my experience with [topic] would genuinely resonate with your audience.\n\nHappy to send over any additional info that would help. Looking forward to hearing from you!\n\nBest,\n[Your Name]`;

  const subjectEl = $('followup-subject');
  const bodyEl    = $('followup-body');
  if (subjectEl) subjectEl.value = subject;
  if (bodyEl)    bodyEl.value    = body;

  // Store matchId on modal for save function
  const modal = $('followup-modal');
  if (modal) {
    modal.dataset.matchId   = matchId;
    modal.style.display     = 'flex';
    document.body.style.overflow = 'hidden';
    // Reset sequence dropdown to custom
    const sel = $('followup-sequence-select');
    if (sel) sel.value = 'custom';
  }
}
window.showFollowUpModal = showFollowUpModal;

function closeFollowUpModal() {
  const m = $('followup-modal'); if (m) m.style.display = 'none';
  document.body.style.overflow = '';
}
window.closeFollowUpModal = closeFollowUpModal;

function saveFollowUpTemplate() {
  const modal   = $('followup-modal');
  const matchId = modal?.dataset.matchId;
  if (!matchId) return;
  const subject = $('followup-subject')?.value || '';
  const body    = $('followup-body')?.value    || '';
  localStorage.setItem(`followup_template_${matchId}`, JSON.stringify({ subject, body }));
  showToast('Template saved!', 'success');
}
window.saveFollowUpTemplate = saveFollowUpTemplate;

function copyFollowUp() {
  const subject = $('followup-subject')?.value || '';
  const body    = $('followup-body')?.value    || '';
  const combined = `Subject: ${subject}\n\n${body}`;
  navigator.clipboard.writeText(combined).then(() => showToast('Copied!', 'success'));
}
window.copyFollowUp = copyFollowUp;

async function sendFollowUp() {
  const modal   = $('followup-modal');
  const matchId = modal?.dataset.matchId;
  const subject = $('followup-subject')?.value.trim() || '';
  const body    = $('followup-body')?.value.trim()    || '';
  if (!matchId) return;
  if (!body) { showToast('Please write a message before sending.', 'error'); return; }
  const btn = $('followup-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const data = await apiPost('/api/send-followup', { matchId, subject, body });
    if (data.success) {
      showToast(data.gmailSent ? 'Follow-up sent!' : 'Follow-up saved (Gmail not connected).', 'success');
      updateMatchInState(matchId, { status: 'followed_up' });
      updateStatBadges();
      closeFollowUpModal();
      switchToFilter('followed_up');
    } else {
      showToast(data.error || 'Send failed.', 'error');
    }
  } catch { showToast('Network error. Please try again.', 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '🚀 Send Follow Up'; } }
}
window.sendFollowUp = sendFollowUp;


// ── Expose globals for inline onclick handlers ────────────────────────
window.approveMatch      = approveMatch;
window.restoreMatch      = restoreMatch;
window.dismissMatch      = dismissMatch;
window.sendMatch         = sendMatch;
window.bookMatch         = bookMatch;
window.openEmailModal    = openEmailModal;
window.openContactModal  = openContactModal;
window.openTemplateModal = openTemplateModal;
window.toggleNoteArea    = toggleNoteArea;
window.saveNote          = saveNote;
window.showToast         = showToast;

// ── Referral Modal ────────────────────────────────────────────────────
function openReferralModal() {
  closeProfileDropdown();
  const modal = $('referral-modal');
  if (!modal) return;
  // Build referral link from current token
  const token = state.token || (window.location.pathname.split('/dashboard/')[1] || '').split('/')[0];
  const base = window.location.origin;
  const link = `${base}/onboard?ref=${token}`;
  const input = document.getElementById('referral-link-input');
  if (input) input.value = link;
  modal.style.display = 'flex';
}
function closeReferralModal() {
  const modal = $('referral-modal');
  if (modal) modal.style.display = 'none';
}
function copyReferralLink() {
  const input = document.getElementById('referral-link-input');
  if (!input) return;
  navigator.clipboard.writeText(input.value).then(() => {
    showToast('Referral link copied!', 'success');
  }).catch(() => {
    input.select();
    document.execCommand('copy');
    showToast('Referral link copied!', 'success');
  });
}

// ── Testimonial link ──────────────────────────────────────────────────
function openTestimonialLink() {
  closeProfileDropdown();
  // Opens a Google review / testimonial page — update URL as needed
  window.open('https://findapodcast.club/review', '_blank');
}

window.openReferralModal  = openReferralModal;
window.closeReferralModal = closeReferralModal;
window.copyReferralLink   = copyReferralLink;

async function joinReferralWaitlist() {
  const btn = $('referral-waitlist-btn');
  if (btn) { btn.textContent = 'Joining…'; btn.disabled = true; }
  try {
    await apiPost('/api/referral-waitlist', { clientId: state.client?.id, email: state.client?.email, name: state.client?.name });
    if (btn) { btn.textContent = "You're on the list!"; btn.style.background = 'var(--success)'; }
    showToast('You\'re on the waitlist — we\'ll email you when it launches.', 'success');
  } catch {
    if (btn) { btn.textContent = 'Join the Waitlist'; btn.disabled = false; }
    showToast('Something went wrong. Try again.', 'error');
  }
}
window.joinReferralWaitlist = joinReferralWaitlist;
window.openTestimonialLink = openTestimonialLink;

// ── Add Podcast Modal ─────────────────────────────────────────────────
function openAddPodcastModal() {
  const modal = document.getElementById('add-podcast-modal');
  if (modal) { modal.style.display = 'flex'; document.getElementById('add-podcast-url').focus(); }
}
function closeAddPodcastModal() {
  const modal = document.getElementById('add-podcast-modal');
  if (modal) modal.style.display = 'none';
  ['add-podcast-url','add-podcast-name','add-podcast-email','add-podcast-instagram','add-podcast-linkedin','add-podcast-facebook','add-podcast-spotify','add-podcast-apple','add-podcast-notes'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const btn = document.getElementById('add-podcast-btn');
  if (btn) { btn.textContent = 'Add to My Pipeline'; btn.disabled = false; }
}
async function submitAddPodcast() {
  const url  = document.getElementById('add-podcast-url').value.trim();
  const name = document.getElementById('add-podcast-name').value.trim();
  if (!url && !name) { showToast('Please enter a podcast URL or name.', 'error'); return; }
  const btn = document.getElementById('add-podcast-btn');
  if (btn) { btn.textContent = '⏳ Adding…'; btn.disabled = true; }
  try {
    const g = (id) => { const el = document.getElementById(id); return el?.value.trim() || null; };
    const data = await apiPost('/api/operator/add-podcast', {
      clientId:      state.client?.id,
      podcastUrl:    url || null,
      podcastName:   name || null,
      contactEmail:  g('add-podcast-email'),
      instagramUrl:  g('add-podcast-instagram'),
      linkedinUrl:   g('add-podcast-linkedin'),
      facebookUrl:   g('add-podcast-facebook'),
      spotifyUrl:    g('add-podcast-spotify'),
      appleUrl:      g('add-podcast-apple'),
      notes:         g('add-podcast-notes'),
    });
    if (data.success) {
      closeAddPodcastModal();
      showToast('⏳ Added! Scoring compatibility — ready in ~10 seconds.', 'info');
      // Add to state immediately as placeholder, then refresh to get real scores
      if (data.match && data.podcast) {
        state.matches.unshift({ ...data.match, podcasts: data.podcast });
        switchToFilter('new');
      }
      // Re-fetch dashboard after 10s so scored values appear
      setTimeout(async () => {
        try {
          const fresh = await apiFetch(`/api/dashboard/${state.token}`);
          if (fresh?.matches) {
            state.matches = fresh.matches;
            renderGrid();
            updateStatBadges();
            showToast('✅ Scoring complete!', 'success');
          }
        } catch { /* silent */ }
      }, 10000);
    } else {
      showToast(data.error || 'Failed to add podcast.', 'error');
      if (btn) { btn.textContent = 'Add to My Pipeline'; btn.disabled = false; }
    }
  } catch {
    showToast('Network error. Please try again.', 'error');
    if (btn) { btn.textContent = 'Add to My Pipeline'; btn.disabled = false; }
  }
}
window.openAddPodcastModal  = openAddPodcastModal;
window.closeAddPodcastModal = closeAddPodcastModal;
window.submitAddPodcast     = submitAddPodcast;

// ── Check for host replies ─────────────────────────────────────────────
async function checkForReplies() {
  if (!state.token) return;
  // Skip if tab is hidden (save Gmail API quota)
  if (document.visibilityState === 'hidden') return;
  try {
    const data = await apiPost('/api/gmail/check-replies', { token: state.token });

    // Warn once in console if Gmail not connected — don't show toast (too noisy)
    if (data.gmailConnected === false) {
      console.info('[Reply Check] Gmail not connected — host replies cannot be auto-detected.');
      return;
    }

    if (data.success && data.updated?.length) {
      data.updated.forEach((matchId) => updateMatchInState(matchId, { status: 'replied' }));
      renderGrid();
      updateStatBadges();
      // Show red badge on Host Replied tab
      const badge = document.getElementById('reply-badge');
      if (badge) {
        badge.textContent = data.updated.length;
        badge.style.display = 'inline-flex';
      }
      showToast(`📬 ${data.updated.length} host${data.updated.length > 1 ? 's have' : ' has'} replied to your pitch!`, 'success');
      switchToFilter('replied');
    }
  } catch {
    // Silently fail — not critical
  }
}

// Poll for replies every 5 minutes while the dashboard is open
function startReplyPolling() {
  // Run once immediately on load (already called in loadDashboard), then every 5 min
  setInterval(() => {
    checkForReplies();
  }, 5 * 60 * 1000);
}

async function refreshDashboard() {
  const btn  = $('refresh-btn');
  const icon = $('refresh-icon');
  if (btn) btn.disabled = true;
  if (icon) icon.style.animation = 'spin 0.7s linear infinite';
  try {
    const res  = await fetch(`/api/dashboard/${state.token}`);
    const data = await res.json();
    if (data.success) {
      state.matches = data.matches || [];
      state.client  = data.client  || state.client;
      renderGrid();
      updateStatBadges();
      showToast('Dashboard refreshed.', 'success');
    } else {
      showToast('Refresh failed — try again.', 'error');
    }
  } catch {
    showToast('Could not reach server. Check your connection.', 'error');
  } finally {
    if (btn)  btn.disabled = false;
    if (icon) icon.style.animation = '';
  }
}
window.refreshDashboard = refreshDashboard;

// ── Support Modal ─────────────────────────────────────────────────────
function openSupportModal() {
  closeProfileDropdown();
  const modal = $('support-modal');
  if (modal) modal.style.display = 'flex';
}
function closeSupportModal() {
  const modal = $('support-modal');
  if (modal) modal.style.display = 'none';
  const subj = $('support-subject');
  const msg  = $('support-message');
  if (subj) subj.value = '';
  if (msg)  msg.value  = '';
}
function sendSupportEmail() {
  const subject = ($('support-subject')?.value || '').trim();
  const message = ($('support-message')?.value || '').trim();
  if (!message) { showToast('Please enter a message.', 'error'); return; }
  const name  = state.client?.name  || '';
  const email = state.client?.email || '';
  const body  = encodeURIComponent(`From: ${name} (${email})\n\n${message}`);
  const subj  = encodeURIComponent(subject || 'Support Request — Find A Podcast');
  window.open(`https://mail.google.com/mail/?view=cm&to=hi@findapodcast.club&su=${subj}&body=${body}`, '_blank');
  closeSupportModal();
  showToast('Opening Gmail with your message pre-filled.', 'success');
}
window.openSupportModal  = openSupportModal;
window.closeSupportModal = closeSupportModal;
window.sendSupportEmail  = sendSupportEmail;
window.openProfileModal  = openProfileModal;
window.closeProfileModal = closeProfileModal;
window.saveProfile       = saveProfile;
window.toggleTheme       = toggleTheme;
window.runPipeline       = runPipeline;

// ── Init ──────────────────────────────────────────────────────────────
function initProfileVibePickers() {
  // Profile modal vibe pill selection
  document.querySelectorAll('#profile-vibe-selector .vibe-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#profile-vibe-selector .vibe-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      const hidden = document.getElementById('profile-visual-vibe');
      if (hidden) hidden.value = pill.dataset.vibe;
    });
  });
  // Profile modal colour picker sync
  const cp = document.getElementById('profile-color-primary');
  const cph = document.getElementById('profile-color-primary-hex');
  const cs = document.getElementById('profile-color-secondary');
  const csh = document.getElementById('profile-color-secondary-hex');
  if (cp && cph) {
    cp.addEventListener('input', () => { cph.value = cp.value; });
    cph.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(cph.value)) cp.value = cph.value; });
  }
  if (cs && csh) {
    cs.addEventListener('input', () => { csh.value = cs.value; });
    csh.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(csh.value)) cs.value = csh.value; });
  }
}

function init() {
  initFilterTabs();
  initSortSelect();
  initExtraFilters();
  initModals();
  initProfileVibePickers();
  loadDashboard();
  startReplyPolling();
  loadLeaderboard();

  // Handle Stripe redirect back to dashboard
  const params = new URLSearchParams(window.location.search);
  if (params.get('boost') === 'success') {
    showToast('🎉 Content Boost purchased! Our team will be in touch shortly.', 'success');
    // Clean URL without reload
    window.history.replaceState({}, '', window.location.pathname);
  } else if (params.get('boost') === 'cancelled') {
    showToast('No worries — you can upgrade anytime from your Booked tab.', 'info');
    window.history.replaceState({}, '', window.location.pathname);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
