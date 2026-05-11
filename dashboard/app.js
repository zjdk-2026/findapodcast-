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

// ── Country → language + geography mapping ────────────────────────────
const COUNTRY_MAP = {
  'Any':            { languages: ['English'],    geographies: ['US','CA','UK','AU'], itunesCountry: 'US' },
  'Australia':      { languages: ['English'],    geographies: ['AU'],               itunesCountry: 'AU' },
  'Brazil':         { languages: ['Portuguese'], geographies: ['BR'],               itunesCountry: 'BR' },
  'Canada':         { languages: ['English'],    geographies: ['CA'],               itunesCountry: 'CA' },
  'France':         { languages: ['French'],     geographies: ['FR'],               itunesCountry: 'FR' },
  'Germany':        { languages: ['German'],     geographies: ['DE'],               itunesCountry: 'DE' },
  'India':          { languages: ['Hindi'],      geographies: ['IN'],               itunesCountry: 'IN' },
  'Italy':          { languages: ['Italian'],    geographies: ['IT'],               itunesCountry: 'IT' },
  'Japan':          { languages: ['Japanese'],   geographies: ['JP'],               itunesCountry: 'JP' },
  'Mexico':         { languages: ['Spanish'],    geographies: ['MX'],               itunesCountry: 'MX' },
  'Netherlands':    { languages: ['Dutch'],      geographies: ['NL'],               itunesCountry: 'NL' },
  'Poland':         { languages: ['Polish'],     geographies: ['PL'],               itunesCountry: 'PL' },
  'Portugal':       { languages: ['Portuguese'], geographies: ['PT'],               itunesCountry: 'PT' },
  'South Korea':    { languages: ['Korean'],     geographies: ['KR'],               itunesCountry: 'KR' },
  'Spain':          { languages: ['Spanish'],    geographies: ['ES'],               itunesCountry: 'ES' },
  'Sweden':         { languages: ['Swedish'],    geographies: ['SE'],               itunesCountry: 'SE' },
  'United Kingdom': { languages: ['English'],    geographies: ['UK','GB'],          itunesCountry: 'GB' },
};
function countryToLangGeo(country) {
  const m = COUNTRY_MAP[country] || COUNTRY_MAP['Any'];
  return { languages: m.languages, geographies: m.geographies };
}

// ── API helpers ───────────────────────────────────────────────────────
async function apiFetch(url) {
  const res = await fetch(url, {
    headers: { 'x-dashboard-token': state.token || '' },
  });
  return res.json();
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':     'application/json',
      'x-dashboard-token': state.token || '',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // Universal demo-locked handler — any 402 demo_locked fires the upgrade modal
  if (res.status === 402 && (data.error === 'demo_locked' || data.demo_locked)) {
    if (typeof openUpgradeModal === 'function') openUpgradeModal();
  }
  // Universal out-of-credits handler — any 402 fires the top-up modal
  else if (res.status === 402 && data.error === 'insufficient_credits') {
    if (typeof handleInsufficientCredits === 'function') handleInsufficientCredits(data);
  }
  // Refresh credit counter after every successful charging action
  if (res.ok && data.credits_balance !== undefined && typeof loadCredits === 'function') {
    loadCredits();
  }
  return data;
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
// Thresholds are deliberately wide on the high end - real-world fit
// scores cluster in the 60-90 range, and showing every decent match as
// "yellow / mid" undersells the matches. Anything 65+ is a real fit
// worth pitching.
function scoreTier(score) {
  if (score >= 65) return 'high';
  if (score >= 40) return 'mid';
  return 'low';
}

function scoreColorClass(score) {
  if (score >= 65) return 'high';
  if (score >= 40) return 'mid';
  return 'low';
}

function scoreColorVar(score) {
  if (score >= 65) return 'var(--success)';
  if (score >= 40) return 'var(--warning)';
  return 'var(--danger)';
}

function likelihoodClass(likelihood) {
  if (likelihood === 'high')   return 'likelihood-high';
  if (likelihood === 'medium') return 'likelihood-medium';
  return 'likelihood-low';
}

function statusBadgeHtml(status) {
  const labels = {
    new:          'New',
    sent:         'Sent',
    followed_up:  'Followed Up',
    replied:      'Replied',
    booked:       'Booked',
    dismissed:    'Not a Fit',
    dream:        'Wish List',
    appeared:     'Aired',
  };
  return `<span class="status-badge status-${esc(status)}">${labels[status] || esc(status)}</span>`;
}

// ── Next-action pill ──────────────────────────────────────────────────
// Tells the user the SINGLE thing to do next on this card.
function nextActionPillHtml(match) {
  if (!match || !match.status) return '';
  const status = match.status;
  let label = '', color = '';

  if (status === 'replied') {
    label = '↪ Reply now';
    color = '#ef4444';
    return `<button onclick="event.stopPropagation();openThreadModal('${esc(match.id)}')" style="display:inline-flex;align-items:center;gap:4px;background:${color}1a;color:${color};border:1px solid ${color}40;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700;letter-spacing:0.02em;white-space:nowrap;cursor:pointer;">Next: ${esc(label)}</button>`;
  } else if (status === 'new') {
    label = '✉ Send pitch';
    color = '#6366f1';
  } else if (status === 'sent' && !match.follow_up_sent && match.sent_at) {
    const days = (Date.now() - new Date(match.sent_at).getTime()) / 86400000;
    if (days >= 7) { label = '⟳ Follow up'; color = '#f59e0b'; }
    else { label = `⏳ ${Math.ceil(7 - days)}d for follow-up`; color = '#94a3b8'; }
  } else if (status === 'sent' && match.follow_up_sent) {
    label = '⏳ Awaiting host';
    color = '#94a3b8';
  } else if (status === 'followed_up') {
    label = '⏳ Awaiting host';
    color = '#94a3b8';
  } else if (status === 'booked') {
    label = '🎙 Record';
    color = '#10b981';
  } else if (status === 'appeared') {
    label = '✨ Send thank-you';
    color = '#8b5cf6';
  } else if (status === 'dream') {
    label = '⭐ Saved';
    color = '#94a3b8';
  } else if (status === 'dismissed') {
    return '';
  } else {
    return '';
  }

  return `<span style="display:inline-flex;align-items:center;gap:4px;background:${color}1a;color:${color};border:1px solid ${color}40;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700;letter-spacing:0.02em;white-space:nowrap;">Next: ${esc(label)}</span>`;
}

// ── HTML escape ───────────────────────────────────────────────────────
// Normalize @handle or bare username to full profile URL
function normalizeHandle(val, baseUrl) {
  if (!val) return '';
  if (val.startsWith('http')) return val;
  const handle = val.replace(/^@/, '').trim();
  return handle ? baseUrl + handle : '';
}
// Normalize LinkedIn — accept full URL or /in/name
function normalizeProfileUrl(val, baseUrl) {
  if (!val) return '';
  if (val.startsWith('http')) return val;
  const slug = val.replace(/^\/in\//, '').replace(/^@/, '').trim();
  return slug ? baseUrl + slug : '';
}

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

// ── Reply tracking helpers ────────────────────────────────────────────
function hasUnseenReply() {
  return state.matches.some((m) =>
    (m.reply_count > 0) &&
    (!m.last_reply_seen_at || new Date(m.last_reply_at) > new Date(m.last_reply_seen_at))
  );
}

function updateHeaderReplyDot() {
  const el = document.getElementById('hero-greeting-name');
  if (!el) return;
  const existing = el.querySelector('.header-reply-dot');
  if (hasUnseenReply()) {
    if (!existing) {
      const dot = document.createElement('span');
      dot.className = 'header-reply-dot';
      dot.title = 'You have unseen host replies';
      el.appendChild(dot);
    }
  } else {
    if (existing) existing.remove();
  }
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

  // Hero already shows the reply via the dominant "Open reply" Move pill +
  // the red dot next to the user's name. A second "X new replies" chip
  // duplicates the signal and adds visual noise. Keeping the chips array
  // for any future use, but no chips currently render.
  const chips = [];

  const airedMatches   = state.matches.filter((m) => m.status === 'appeared');
  const lifetimeTotal  = airedMatches.reduce((t, m) => t + (estimateAudience(m.podcasts?.listen_score).low), 0);

  // Streak: count consecutive days back from today where at least one pitch was sent
  const sentDates = state.matches
    .filter(m => m.sent_at)
    .map(m => new Date(m.sent_at).toISOString().slice(0, 10));
  const sentDaysSet = new Set(sentDates);
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 60; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (sentDaysSet.has(key)) streak++;
    else if (i > 0) break;
    else continue; // today with 0 sends: still allow streak if yesterday had one
  }

  // Pitches sent this week (Monday-anchored)
  const startOfWeek = new Date();
  startOfWeek.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  startOfWeek.setHours(0, 0, 0, 0);
  const sentThisWeek = state.matches.filter(m => m.sent_at && new Date(m.sent_at) >= startOfWeek).length;
  const weeklyTarget = 15;
  const weekProgress = Math.min(100, Math.round((sentThisWeek / weeklyTarget) * 100));

  const photoUrl = state.client?.photo_url || '';
  const avatarHtml = photoUrl
    ? `<img src="${esc(photoUrl)}" alt="" style="width:48px;height:48px;border-radius:50%;object-fit:cover;border:2px solid var(--accent);flex-shrink:0;" />`
    : '';

  // Your Move pill — compact, sits inline with streak/reach
  const move = (typeof computeYourMove === 'function') ? computeYourMove() : null;
  const moveTones = {
    urgent: { bg: 'linear-gradient(135deg,rgba(239,68,68,0.12),rgba(245,158,11,0.06))', border: 'rgba(239,68,68,0.30)', label: '#ef4444', btnBg: '#ef4444' },
    warm:   { bg: 'linear-gradient(135deg,rgba(245,158,11,0.10),rgba(99,102,241,0.05))', border: 'rgba(245,158,11,0.30)', label: '#d97706', btnBg: '#f59e0b' },
    cool:   { bg: 'linear-gradient(135deg,rgba(99,102,241,0.08),rgba(139,92,246,0.05))', border: 'rgba(99,102,241,0.25)', label: '#6366f1', btnBg: '#6366f1' },
  };
  const tone = move ? (moveTones[move.tone] || moveTones.cool) : null;
  // Compact one-liner (truncated to fit pill)
  const moveTextShort = move ? (move.text.length > 80 ? move.text.slice(0, 78) + '…' : move.text) : '';

  heroEl.innerHTML = `
    <div class="hero-greeting">
      <div style="display:flex;align-items:center;gap:12px;">
        ${avatarHtml}
        <div class="hero-greeting-name" id="hero-greeting-name">${greeting}, ${esc(name.split(' ')[0])}${hasUnseenReply() ? '<span class="header-reply-dot" title="You have unseen host replies"></span>' : ''}</div>
      </div>
      <div style="margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <!-- Pill 1: ACTION — dominant. Heavier border, larger padding, accent CTA.
             CTA colour matches the urgency: red for replies (matches Host Replied tab badge), green otherwise. -->
        ${move ? (() => {
          const ctaBg = move.tone === 'urgent' ? '#ef4444' : '#10b981';
          return `
          <div style="display:inline-flex;align-items:center;gap:12px;background:var(--surface-card);border:1.5px solid var(--border-medium);border-radius:999px;padding:7px 8px 7px 18px;font-size:14px;color:var(--text-primary);box-shadow:0 1px 2px rgba(0,0,0,0.03);">
            <span style="color:var(--text-primary);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:440px;" title="${esc(move.text)}">${esc(moveTextShort)}</span>
            <button onclick="${move.action}" style="background:${ctaBg};color:#fff;border:none;border-radius:999px;padding:6px 14px;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px;">
              ${esc(move.cta)}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </button>
          </div>`;
        })() : ''}
        <!-- Pill 2: PROGRESS — subtle. Hidden when 0 (avoids 'shame at zero'). Streak only when meaningful (>= 3 days). Hidden in demo mode (prospect hasn't actually pitched, "X of 15" is misleading). -->
        ${sentThisWeek > 0 && !state.demo?.active ? `
          <div style="display:inline-flex;align-items:center;gap:8px;background:transparent;border:1px solid var(--border-light);border-radius:999px;padding:6px 14px;font-size:12.5px;color:var(--text-tertiary);">
            <span style="color:var(--text-secondary);font-weight:600;">${sentThisWeek} of ${weeklyTarget}</span>
            <span>this week</span>
            ${streak >= 3 ? `<span style="color:var(--border-medium);">·</span><span>${streak}-day streak</span>` : ''}
            ${weekProgress >= 100 ? `<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:#10b981;"></span>` : ''}
          </div>` : ''}
        <!-- Pill 3: REACH — subtle. Professional language. Hidden in demo mode (prospect hasn't aired anything yet). -->
        ${lifetimeTotal > 0 && !state.demo?.active ? `
          <div style="display:inline-flex;align-items:baseline;gap:6px;background:transparent;border:1px solid var(--border-light);border-radius:999px;padding:6px 14px;font-size:12.5px;color:var(--text-tertiary);">
            <span style="color:var(--text-secondary);font-weight:600;">${formatNumber(lifetimeTotal)}</span>
            <span>listener reach</span>
          </div>` : ''}
      </div>
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
    el.innerHTML = `<div class="onboarding-card"><div class="onboarding-inner" style="justify-content:center;"><div class="onboarding-complete">You're all set. Your pipeline is live. Keep pitching!</div></div></div>`;
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
          ${step(hasProfile,  'Complete your profile',      'Paste your LinkedIn bio',                        'openProfileModal()')}
          ${step(state.client?.gmail_email, 'Connect your email', 'Link Gmail so we can send pitches',          'connectGmail()')}
          ${step(hasMatches,  'Find a Podcast',             'Hit Find a Podcast to get your first matches',   'runPipeline()')}
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

  const linkedInText = encodeURIComponent(`Just booked a guest spot on ${title}. Can't wait to share my thoughts on [your topic] with their audience.\n\nIf you want to grow through podcasting, highly recommend @FindAPodcast 🎙️\n\nhttps://findapodcast.io`);
  const linkedInUrl  = `https://www.linkedin.com/sharing/share-offsite/?url=https://findapodcast.io&summary=${linkedInText}`;

  body.innerHTML = `
    <div style="font-size:52px;margin-bottom:12px;line-height:1;"><svg width="52" height="52" viewBox="0 0 52 52" fill="none"><circle cx="26" cy="26" r="25" stroke="#6366f1" stroke-width="2" fill="#f5f3ff"/><path d="M15 27l8 8 14-16" stroke="#6366f1" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
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
          <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;background:var(--accent);border-radius:6px;flex-shrink:0;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg></span>
          Confirm your recording date with the host
        </div>
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-primary);">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;background:var(--accent);border-radius:6px;flex-shrink:0;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg></span>
          Prep your best stories and talking points
        </div>
        <div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-primary);">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;background:var(--accent);border-radius:6px;flex-shrink:0;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></span>
          After it airs, mark it as Aired to unlock Content Boost
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
  // Tag the match as 'requested' and notify hi@zacdeane.com
  if (_contentBoostMatchId) {
    try {
      await apiPost('/api/content-boost/request', { matchId: _contentBoostMatchId });
      updateMatchInState(_contentBoostMatchId, { content_boost_status: 'requested' });
      updateContentBoostTab();
      // Fire notification email to team
      try { await apiPost('/api/content-boost/notify', { matchId: _contentBoostMatchId }); } catch { /* non-fatal */ }
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
      banner.innerHTML = `Your Content Boost is ready! <button onclick="switchToFilter('content_boost');dismissBoostNotification()" style="margin-left:10px;background:var(--accent);color:#fff;border:none;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700;cursor:pointer;">View now</button>`;
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
      showToast('Episode link sent to our team! We\'ll start editing shortly.', 'success');
      updateMatchInState(matchId, { content_boost_episode_url: url });
      // Refresh card so the submission section hides
      const card = document.getElementById(`card-${matchId}`);
      if (card) {
        const section = document.getElementById(`boost-link-section-${matchId}`);
        if (section) {
          section.innerHTML = `<p style="font-size:13px;font-weight:700;color:#6366f1;margin:0;">Episode link received. Our team is on it!</p>`;
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
  set('stat-sent',     stats.pitched ?? 0);
  set('stat-booked',   stats.booked);
  renderPipelineHealth(stats);
}

// ── Pipeline health card — momentum + next-action signal ──────────────
function computeYourMove() {
  const matches = state.matches || [];
  const seenKey = `seen_replied_${state.token}`;
  const seenIds = new Set(JSON.parse(localStorage.getItem(seenKey) || '[]'));

  const unseenReplies = matches.filter(m => m.status === 'replied' && !seenIds.has(m.id));
  const unbooked      = matches.filter(m => m.status === 'replied');
  const stalePitches  = matches.filter(m => {
    if (m.status !== 'sent' || m.follow_up_sent) return false;
    if (!m.sent_at) return false;
    const daysAgo = (Date.now() - new Date(m.sent_at).getTime()) / 86400000;
    return daysAgo > 7;
  });
  const newReady = matches.filter(m => m.status === 'new');
  const aired    = matches.filter(m => m.status === 'aired' || m.status === 'appeared');

  // Priority: unseen reply > book the call > stale follow-up > new pitches > find more
  // Phrasing tuned for business experts: specific names where known, no hype, no shame.
  if (unseenReplies.length > 0) {
    const m = unseenReplies[0];
    const hostFirst = (m.podcasts?.host_name || '').split(' ')[0] || '';
    const showName  = m.podcasts?.title || 'the show';
    const text = hostFirst
      ? `${hostFirst} at ${showName} replied. Lock in the recording before the window closes.`
      : `New reply on ${showName}. Lock in the recording before the window closes.`;
    return {
      label: 'Your move',
      text,
      cta:   'Open reply',
      action: `openMatchDetail(${JSON.stringify(m.id)})`,
      tone: 'urgent',
    };
  }
  if (unbooked.length > 0) {
    return {
      label: 'Your move',
      text:  `${unbooked.length} host${unbooked.length > 1 ? 's' : ''} waiting. Reply windows cool inside 48 hours.`,
      cta:   'See replies',
      action: `setFilter('replied')`,
      tone: 'urgent',
    };
  }
  if (stalePitches.length > 0) {
    return {
      label: 'Your move',
      text:  `${stalePitches.length} pitch${stalePitches.length > 1 ? 'es' : ''} past 7 days. Most bookings land on the second touch.`,
      cta:   'Coming soon',
      action: `void(0)`,
      tone: 'warm',
    };
  }
  if (newReady.length > 0) {
    return {
      label: 'Your move',
      text:  `${newReady.length} fresh match${newReady.length > 1 ? 'es' : ''} ready to review.`,
      cta:   'Coming soon',
      action: `void(0)`,
      tone: 'warm',
    };
  }
  if (aired.length > 0) {
    return {
      label: 'Your move',
      text:  `Pipeline is clear. Discover 10 fresh shows in your niche.`,
      cta:   'Find a Podcast',
      action: `runPipeline()`,
      tone: 'cool',
    };
  }
  return {
    label: 'Get started',
    text:  `Discover your first 10 matches and start pitching.`,
    cta:   'Find a Podcast',
    action: `runPipeline()`,
    tone: 'cool',
  };
}

function renderPipelineHealth(stats) {
  const el = $('pipeline-health');
  if (!el || !state.matches) return;

  const matches  = state.matches;
  const total    = matches.length;
  const newCount = matches.filter(m => m.status === 'new').length;
  const sent     = matches.filter(m => ['sent','followed_up','replied','booked','aired'].includes(m.status)).length;
  const replied  = matches.filter(m => ['replied','booked','aired'].includes(m.status)).length;
  const booked   = matches.filter(m => ['booked','aired'].includes(m.status)).length;
  const aired    = matches.filter(m => m.status === 'aired').length;

  const replyRate = sent > 0 ? Math.round((replied / sent) * 100) : 0;
  const bookRate  = sent > 0 ? Math.round((booked / sent) * 100) : 0;

  const move = computeYourMove();
  const toneColors = {
    urgent: { bg: 'linear-gradient(135deg,rgba(239,68,68,0.10),rgba(245,158,11,0.06))', border: 'rgba(239,68,68,0.30)', label: '#ef4444' },
    warm:   { bg: 'linear-gradient(135deg,rgba(245,158,11,0.10),rgba(99,102,241,0.05))', border: 'rgba(245,158,11,0.30)', label: '#f59e0b' },
    cool:   { bg: 'linear-gradient(135deg,rgba(99,102,241,0.08),rgba(139,92,246,0.05))', border: 'rgba(99,102,241,0.18)', label: '#6366f1' },
  };
  const t = toneColors[move.tone] || toneColors.cool;

  // Behavioral nudge based on stage
  let nudge, nudgeColor, icon;
  if (total === 0) {
    nudge = 'Click "Find a Podcast" up top to discover your first 50 matches.';
    nudgeColor = '#6366f1'; icon = '🚀';
  } else if (sent === 0) {
    nudge = `${newCount} matches waiting. Send your first pitch — average client books #1 within 7 sends.`;
    nudgeColor = '#f59e0b'; icon = '✉️';
  } else if (sent < 5) {
    nudge = `You've sent ${sent}. The math: ~${Math.max(7 - sent, 1)} more sends to hit the average first-booking threshold.`;
    nudgeColor = '#f59e0b'; icon = '📈';
  } else if (replied === 0) {
    nudge = `${sent} pitches out, no replies yet. Industry average is 14-18% reply rate — you're due. Try the Check Replies button up top.`;
    nudgeColor = '#6366f1'; icon = '⏳';
  } else if (booked === 0) {
    nudge = `${replied} repl${replied === 1 ? 'y' : 'ies'} in! Book the call before they cool — reply windows are 48 hours.`;
    nudgeColor = '#10b981'; icon = '🔥';
  } else if (aired === 0) {
    nudge = `${booked} booked! Once aired, hit "Send a Thank You" to seed referrals — every aired episode unlocks Content Boost.`;
    nudgeColor = '#10b981'; icon = '🎤';
  } else {
    nudge = `${aired} aired, ${booked} booked, ${replyRate}% reply rate. Keep the cadence — Refresh Pipeline weekly for fresh shows.`;
    nudgeColor = '#10b981'; icon = '🏆';
  }

  // Your Move now lives in the hero row — pipeline-health banner is hidden to avoid duplication.
  // (Stats SENT/REPLY/BOOK still computed; surface them here only if we want to bring them back.)
  el.style.display = 'none';
  el.innerHTML = '';
}

window.openMatchDetail = window.openMatchDetail || function(id) {
  // Fallback: scroll to the card. Existing app.js may have a richer modal opener.
  const card = document.querySelector(`[data-match-id="${id}"]`) || document.getElementById(`match-${id}`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
};
window.setFilter = window.setFilter || function(status) {
  const btn = document.querySelector(`.filter-tab[data-status="${status}"]`);
  if (btn) btn.click();
};

// ── Score tooltips ────────────────────────────────────────────────────
const SCORE_TOOLTIPS = {
  'Relevance':   'How well this show\'s topics line up with what you talk about and who you help.',
  'Audience':    'Our best estimate of how many people are actually listening to this show.',
  'Recency':     'Shows that publish regularly tend to be actively booking guests right now.',
  'Reach':       'How big this show is across YouTube, social media and podcast platforms combined.',
  'Contact':     'How easy it is to get in touch with the host. A direct email gets a much higher score than no contact info at all.',
  'Brand Fit':   'How naturally you\'d fit in with the tone and guest style of this show.',
  'Guest Qual.': 'The kind of guests this show typically features.',
};

// ── Score bar HTML ────────────────────────────────────────────────────
function scoreBarHtml(label, value, badge = '') {
  const v   = Math.round(value || 0);
  const tip = SCORE_TOOLTIPS[label] || '';
  const cls = v >= 70 ? 'high' : v >= 40 ? 'mid' : 'low';
  return `
    <div class="score-row"${tip ? ` title="${esc(tip)}" style="cursor:help;"` : ''}>
      <div class="score-row-header">
        <span class="score-row-label">${esc(label)}${badge ? `&nbsp;${badge}` : ''}</span>
        <span class="score-row-value" style="color:${v >= 70 ? 'var(--success)' : v >= 40 ? 'var(--warning)' : 'var(--danger)'}">${v}</span>
      </div>
      <div class="score-bar-track">
        <div class="score-bar-fill ${cls}" style="width:${v}%"></div>
      </div>
    </div>`;
}

function audienceSizeTierHtml(reachScore) {
  const s = reachScore || 0;
  let label, color;
  if (s >= 85)      { label = 'Mega';  color = '#6366f1'; }
  else if (s >= 70) { label = 'Macro'; color = '#22c55e'; }
  else if (s >= 50) { label = 'Mid';   color = '#f59e0b'; }
  else if (s >= 30) { label = 'Micro'; color = '#94a3b8'; }
  else              { label = 'Nano';  color = '#cbd5e1'; }
  return `<span title="Audience size tier based on reach signals" style="font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${color};background:${color}18;border:1px solid ${color}44;border-radius:4px;padding:2px 7px;cursor:help;">${label}</span>`;
}

// ── Contact chips HTML ────────────────────────────────────────────────
function isValidUrl(url) {
  if (!url) return false;
  try { new URL(url); return true; } catch { return false; }
}

// Client-side social profile URL validation — mirrors server-side rules in enrichment.js.
// Protects against bad data already in the DB being displayed to users.
const SOCIAL_BLOCKED_SEGMENTS_CLIENT = new Set([
  'intent', 'sharer', 'dialog', 'ads', 'login', 'signup', 'register',
  'redirect', 'out', 'settings', 'notifications', 'direct',
  'reel', 'reels', 'stories', 'explore', 'tags', 'p', 'tv',
  'events', 'groups', 'jobs', 'learning', 'school',
  'status', 'i', 'share', 'oauth', 'api',
]);
const SOCIAL_BLOCKED_QS_CLIENT = ['share?', 'shareArticle?', 'sharedby', 'intent/tweet', '?u=', '?url=', 'dialog/share'];
function isValidSocialProfile(url, platform) {
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  const full = url.toLowerCase();
  const path = u.pathname.toLowerCase();
  const host = u.hostname.toLowerCase();
  // Reject known query-string share/intent patterns
  if (SOCIAL_BLOCKED_QS_CLIENT.some(q => full.includes(q))) return false;
  // Reject blocked path segments (segment-boundary-aware, not prefix match)
  const segments = path.split('/').filter(Boolean);
  if (segments.some(seg => SOCIAL_BLOCKED_SEGMENTS_CLIENT.has(seg))) return false;
  switch (platform) {
    case 'instagram':
      return host.includes('instagram.com') && /^\/[a-z0-9_.]{1,30}\/?$/.test(path);
    case 'twitter':
      return (host.includes('twitter.com') || host.includes('x.com')) && /^\/[a-z0-9_]{1,15}\/?$/.test(path);
    case 'facebook':
      return host.includes('facebook.com') && !/\/(groups|events|watch|marketplace|gaming|live|ads|business|help|login)\b/.test(path);
    case 'linkedin':
      return host.includes('linkedin.com') && /^\/(company|in)\/[a-z0-9\-_%.]{2,}\/?$/i.test(path);
    default:
      return isValidUrl(url);
  }
}

function contactChipsHtml(podcast) {
  // Helper: is this URL a podcast platform URL (not a real website)?
  const PLATFORM_DOMAINS = ['apple.com', 'podcasts.apple.com', 'itunes.apple.com', 'itunes.', 'spotify.com', 'anchor.fm',
    'youtube.com', 'soundcloud.com', 'stitcher.com', 'podbean.com', 'buzzsprout.com',
    'transistor.fm', 'simplecast.com', 'libsyn.com', 'captivate.fm'];
  function isPlatformUrl(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return PLATFORM_DOMAINS.some(d => lower.includes(d));
  }

  const chips = [];

  // Order: Apple Podcasts → Spotify → Website → Instagram → Email
  if (isValidUrl(podcast.apple_url) && podcast.apple_url.toLowerCase().includes('apple.com')) {
    chips.push(`<a class="contact-chip" href="${esc(podcast.apple_url)}" target="_blank" rel="noopener">Apple Podcasts</a>`);
  }
  if (isValidUrl(podcast.spotify_url) && podcast.spotify_url.toLowerCase().includes('spotify.com')) {
    chips.push(`<a class="contact-chip" href="${esc(podcast.spotify_url)}" target="_blank" rel="noopener">Spotify</a>`);
  }
  if ((isValidUrl(podcast.soundcloud_url) && podcast.soundcloud_url.toLowerCase().includes('soundcloud.com')) || (isValidUrl(podcast.apple_url) && podcast.apple_url.toLowerCase().includes('soundcloud.com'))) {
    chips.push(`<a class="contact-chip" href="${esc(podcast.soundcloud_url || podcast.apple_url)}" target="_blank" rel="noopener">SoundCloud</a>`);
  }

  const isSameAsApple = podcast.apple_url && podcast.website &&
    podcast.website.toLowerCase().trim() === podcast.apple_url.toLowerCase().trim();
  if (isValidUrl(podcast.website) && !isPlatformUrl(podcast.website) && !isSameAsApple) {
    chips.push(`<a class="contact-chip" href="${esc(podcast.website)}" target="_blank" rel="noopener">Website</a>`);
  }

  if (isValidSocialProfile(podcast.instagram_url, 'instagram')) {
    chips.push(`<a class="contact-chip" href="${esc(podcast.instagram_url)}" target="_blank" rel="noopener">Instagram <span style="font-size:9px;font-weight:700;background:rgba(99,102,241,0.18);color:#6366f1;border-radius:8px;padding:1px 5px;margin-left:3px;letter-spacing:0.3px;">BETA</span></a>`);
  }

  const isAutoEmail = podcast.contact_email && /podcasts\d*\+[a-f0-9]+@anchor\.fm/i.test(podcast.contact_email);
  if (podcast.contact_email && !isAutoEmail) {
    chips.push(`<a class="contact-chip contact-chip-primary" href="#" onclick="copyEmail(event,'${esc(podcast.contact_email)}')" title="Click to copy email"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> ${esc(podcast.contact_email)}</a>`);
  }

  return chips.length > 0
    ? `<div class="contact-section"><div class="contact-chips">${chips.join('')}</div></div>`
    : `<div class="contact-section"><span style="font-size:12px;color:var(--text-tertiary);">No contact info found yet.</span></div>`;
}

// ── Contact-likelihood badge ────────────────────────────────────────────
function confidenceBadgeHtml(confidence) {
  const map = {
    high:   { dot: '#10b981', label: 'Likely to unlock' },
    medium: { dot: '#f59e0b', label: 'Might unlock' },
    low:    { dot: '#9ca3af', label: 'Unlikely to unlock' },
    none:   { dot: '#9ca3af', label: 'Unlikely to unlock' },
  };
  const m = map[confidence] || map.medium;
  return `<span class="contact-chip" style="background:#fafafa;border:1px solid #eee;color:#666;font-size:11px;padding:4px 10px;"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${m.dot};margin-right:5px;vertical-align:1px;"></span>${m.label}</span>`;
}

// ── Verified-via receipt (shown after unlock) ───────────────────────────
function verifiedViaHtml(podcast) {
  const sources = podcast.contact_sources || {};
  const vals = Object.values(sources).filter(Boolean);
  if (vals.length === 0) return '';
  const sourceLabels = {
    rss_owner:      'RSS feed owner',
    website_link:   'show website',
    apple_sameAs:   'Apple Podcasts',
    cross_verified: 'multiple sources',
    bio_mention:    'profile bio',
    rss_or_apple:   'RSS or Apple',
    verified:       'verified',
  };
  const uniqueSources = [...new Set(vals.map(v => sourceLabels[v] || v))].slice(0, 3).join(', ');
  const days = podcast.contact_unlocked_at
    ? Math.max(1, Math.floor((Date.now() - new Date(podcast.contact_unlocked_at).getTime()) / (1000 * 60 * 60 * 24)))
    : 0;
  const when = days === 0 ? 'just now' : days === 1 ? '1 day ago' : `${days} days ago`;
  return `<div style="font-size:11px;color:#888;margin-top:6px;display:flex;align-items:center;gap:5px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>Verified via ${uniqueSources} · ${when}</div>`;
}

// ── Fallback tips — shown when unlock returns no contact data ──────────
function fallbackTipsHtml(podcast) {
  const tips = podcast._fallback_tips || buildFallbackTipsClient(podcast);
  if (!tips.length) return '';
  return `<div style="margin-top:10px;padding:12px 14px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;font-size:12.5px;color:#7c2d12;">
    <div style="font-weight:700;margin-bottom:6px;">No verified public contact — try one of these:</div>
    ${tips.map(t => `<div style="margin-top:4px;"><a href="${esc(t.url)}" target="_blank" rel="noopener" style="color:#c2410c;font-weight:600;text-decoration:underline;">${esc(t.label)} →</a><span style="color:#9a3412;"> ${esc(t.reason)}</span></div>`).join('')}
  </div>`;
}

// Client-side duplicate of buildFallbackTips (used when server didn't bundle them)
function buildFallbackTipsClient(podcast) {
  const tips = [];
  const host = (podcast?.host_name || '').trim();
  const title = (podcast?.title || '').trim();
  if (host) {
    tips.push({ label: `DM ${host} on Instagram`, url: `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(host)}`, reason: '— hosts often reply to warm DMs' });
    tips.push({ label: `Find ${host} on LinkedIn`, url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(host + (title ? ' ' + title : ''))}`, reason: '— LinkedIn requests with a show note often land' });
  }
  if (title) {
    tips.push({ label: 'Search Google', url: `https://www.google.com/search?q=${encodeURIComponent('"' + title + '"' + (host ? ' "' + host + '"' : '') + ' contact email')}`, reason: '— may list contact on a page we missed' });
  }
  return tips;
}

// ── Unlock button handler ───────────────────────────────────────────────
// Deep search can take 20-40s. If the fetch stalls/times out, the server may
// still have completed successfully — so on error we poll the dashboard API
// to confirm whether contact_unlocked_at has been set. Fires a page reload
// either way once we confirm success.
async function unlockContact(event, podcastId) {
  event.preventDefault();
  event.stopPropagation();
  if (state.demo?.active) { openUpgradeModal(); return; }
  const btn = event.currentTarget;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 1s linear infinite;"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg> Searching…`;

  const flashSuccessAndReload = () => {
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg> Unlocked`;
    btn.style.background = '#10b981';
    setTimeout(() => window.location.reload(), 600);
  };

  const pollForUnlock = async (attempts = 6) => {
    const tok = state?.token || location.pathname.split('/').pop();
    for (let i = 0; i < attempts; i++) {
      await new Promise(r => setTimeout(r, 2500));
      try {
        const r = await fetch(`/api/dashboard/${encodeURIComponent(tok)}`);
        if (!r.ok) continue;
        const d = await r.json();
        const match = (d.matches || []).find(m => m.podcasts?.id === podcastId);
        if (match?.podcasts?.contact_unlocked_at) return true;
      } catch { /* try again */ }
    }
    return false;
  };

  try {
    const res = await fetch(`/api/unlock/${encodeURIComponent(podcastId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: (typeof state !== 'undefined' && state.client?.id) || window.__clientId || null }),
    });
    const data = await res.json().catch(() => null);
    if (data?.ok) {
      flashSuccessAndReload();
      return;
    }
    // Maybe server is still processing and hit an edge timeout — poll for truth
    const finished = await pollForUnlock();
    if (finished) {
      flashSuccessAndReload();
      return;
    }
    btn.disabled = false;
    btn.innerHTML = orig;
    btn.style.background = '';
    showToast('Could not unlock right now. Try again in a moment.');
  } catch (err) {
    // Network/timeout — still poll, server may have succeeded
    const finished = await pollForUnlock();
    if (finished) {
      flashSuccessAndReload();
      return;
    }
    btn.disabled = false;
    btn.innerHTML = orig;
    btn.style.background = '';
    showToast('Network hiccup — try again in a moment.');
  }
}

function showToast(msg) {
  try {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1d1d1f;color:#fff;padding:10px 18px;border-radius:999px;font-size:13px;font-weight:600;z-index:9999;box-shadow:0 6px 20px rgba(0,0,0,0.3);';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  } catch { /* no-op */ }
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

// ── Content Boost button — state-aware ───────────────────────────────
function contentBoostButton(match) {
  const id  = match.id;
  const cbs = match.content_boost_status;
  const url = match.content_boost_episode_url;

  if (!cbs) {
    // Not purchased yet — show buy button
    return `<button class="btn btn-action-send btn-xs btn-action-primary" onclick="showContentBoostModal('${id}')">Content Boost</button>`;
  }
  if (cbs === 'requested') {
    // Stripe payment processing
    return `<button class="btn btn-xs" disabled style="background:#fef9c3;color:#92400e;border:1.5px solid #fde68a;font-weight:600;cursor:default;">Payment Processing…</button>`;
  }
  if (cbs === 'ordered' && !url) {
    // Paid — waiting for episode link
    return `<button class="btn btn-xs btn-action-primary" onclick="toggleCardExpand('${id}');document.getElementById('boost-url-${id}')?.focus()" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);">Submit Episode Link</button>`;
  }
  if (cbs === 'ordered' && url) {
    // Link submitted, team working on it
    return `<button class="btn btn-xs" disabled style="background:#f0fdf4;color:#16a34a;border:1.5px solid #86efac;font-weight:600;cursor:default;">Link Submitted</button>`;
  }
  if (cbs === 'completed') {
    return `<button class="btn btn-xs" disabled style="background:#f0fdf4;color:#16a34a;border:1.5px solid #86efac;font-weight:600;cursor:default;">Boost Complete</button>`;
  }
  return '';
}

// ── Action buttons HTML ───────────────────────────────────────────────
function actionButtonsHtml(match) {
  const status  = match.status;
  const id      = match.id;
  const podcast = match.podcasts || {};
  const buttons = [];

  // ── AI Enrich button ──
  // Show on 'new' and 'dream' cards that have a website/URL but no host_name yet
  const hasUrl = !!(podcast.website || podcast.url);
  const needsEnrich = !podcast.host_name && hasUrl;
  if (needsEnrich) {
    buttons.push(`<button class="btn btn-xs sgai-enrich-btn" onclick="enrichAICard('${id}')" style="background:#eef2ff;color:#4338ca;border:1.5px solid #c7d2fe;font-weight:600;">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:5px;vertical-align:middle;"><path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1-8.313-12.454z"/></svg>AI Enrich
    </button>`);
  }

  const hasContactEmail = !!(podcast.contact_email && !/podcasts\d*\+[a-f0-9]+@anchor\.fm/i.test(podcast.contact_email));
  const hasSocial = isValidSocialProfile(podcast.instagram_url, 'instagram') ||
                    isValidSocialProfile(podcast.twitter_url, 'twitter') ||
                    isValidSocialProfile(podcast.linkedin_page_url || podcast.linkedin_url, 'linkedin') ||
                    isValidSocialProfile(podcast.facebook_url, 'facebook');

  // ── Pitch button (Write Pitch Email / DM Template) shown on NEW and WISH LIST ──
  const pitchStatuses = ['new', 'dream'];
  if (pitchStatuses.includes(status)) {
    if (hasContactEmail) {
      buttons.push(`<button class="btn btn-action-send btn-xs" onclick="toggleInlinePitch('${id}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:5px;vertical-align:middle;"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Write Pitch Email
      </button>`);
    } else {
      buttons.push(`<button class="btn btn-xs" style="background:#f8f8f8;color:#aaa;border:1.5px solid #e0e0e0;font-weight:600;cursor:pointer;" onclick="showNoEmailWarning('${id}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:5px;vertical-align:middle;"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Write Pitch Email
      </button>`);
    }
    if (hasSocial) {
      buttons.push(`<button class="btn btn-xs" style="background:#fff7ed;color:#c2410c;border:1.5px solid #fed7aa;font-weight:600;" onclick="toggleSocialDM('${id}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:5px;vertical-align:middle;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>DM Template
      </button>`);
    }
  }

  // ── NEW tab ──
  if (status === 'new') {
    buttons.push(`<button class="btn btn-xs" style="background:#f0fdf4;color:#16a34a;border:1.5px solid #bbf7d0;font-weight:600;" onclick="markAsPitchedFromInline('${id}')">I Sent It Myself</button>`);
    buttons.push(`<button class="btn btn-xs" style="background:#f0ebff;color:#6366f1;border:1.5px solid #c4b5fd;font-weight:600;" onclick="dreamMatch('${id}')">Add to Wish List</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="confirmDismiss('${id}')">Not a Fit</button>`);

  // ── PITCHED tab ──
  } else if (status === 'sent') {
    buttons.push(`<button class="btn btn-action-followup btn-xs" onclick="toggleFollowUpPanel('${id}')">Follow Up</button>`);
    buttons.push(`<button class="btn btn-xs" style="background:#f0fdf4;color:#16a34a;border:1.5px solid #bbf7d0;font-weight:600;" onclick="markAsFollowedUpManually('${id}')">I Sent It Myself</button>`);
    buttons.push(`<button class="btn btn-xs" style="background:#eff6ff;color:#2563eb;border:1.5px solid #bfdbfe;font-weight:600;" onclick="markReplied('${id}')">Host Replied</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="confirmDismiss('${id}')">Not a Fit</button>`);

  // ── FOLLOWED UP tab ──
  } else if (status === 'followed_up') {
    buttons.push(`<button class="btn btn-action-followup btn-xs" onclick="toggleFollowUpPanel('${id}')">Follow Up Again</button>`);
    buttons.push(`<button class="btn btn-xs" style="background:#eff6ff;color:#2563eb;border:1.5px solid #bfdbfe;font-weight:600;" onclick="markReplied('${id}')">Host Replied</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="confirmDismiss('${id}')">Not a Fit</button>`);

  // ── HOST REPLIED tab ──
  } else if (status === 'replied') {
    // Reply opens the threaded reply modal (proper Gmail thread, AI draft, tracked).
    // Falls back to mailto only if the host has no captured email at all.
    if (match.podcasts?.contact_email || match.gmail_thread_id) {
      buttons.push(`<button class="btn btn-xs" style="background:#eff6ff;color:#2563eb;border:1.5px solid #bfdbfe;font-weight:600;" onclick="openThreadModal('${id}')">Reply</button>`);
    }
    buttons.push(`<button class="btn btn-action-book btn-xs btn-action-primary" onclick="bookMatch('${id}')">It's Booked!</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="confirmDismiss('${id}')">Not a Fit</button>`);

  // ── BOOKED tab ──
  } else if (status === 'booked') {
    buttons.push(`<button class="btn btn-action-appeared btn-xs" onclick="markAppeared('${id}')">Mark as Aired</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="confirmDismiss('${id}')">Not a Fit</button>`);

  // ── AIRED tab ──
  } else if (status === 'appeared') {
    buttons.push(`<button class="btn btn-xs" style="background:#f0ebff;color:#6366f1;border:1.5px solid #c4b5fd;font-weight:600;" onclick="toggleThankYouPanel('${id}')">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:5px;vertical-align:middle;"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Send a Thank You
    </button>`);
    buttons.push(`<button class="btn btn-action-share btn-xs" onclick="showShareModal('${id}')">Share Win</button>`);
    buttons.push(contentBoostButton(match));

  // ── WISH LIST tab — same as NEW ──
  } else if (status === 'dream') {
    buttons.push(`<button class="btn btn-xs" style="background:#f0fdf4;color:#16a34a;border:1.5px solid #bbf7d0;font-weight:600;" onclick="markAsPitchedFromInline('${id}')">I Sent It Myself</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="confirmDismiss('${id}')">Not a Fit</button>`);

  // ── NOT A FIT tab ──
  } else if (status === 'dismissed') {
    buttons.push(`<button class="btn btn-restore btn-xs" onclick="restoreMatch('${id}')">Restore to New</button>`);

  // ── CONTENT BOOST tab ──
  } else if (status === 'content_boost') {
    buttons.push(contentBoostButton(match));
  }

  return buttons.join('');
}

// ── Toggle card expand ────────────────────────────────────────────────
function toggleCardExpand(matchId) {
  const card = $(`card-${matchId}`);
  if (!card) return;
  const isExpanded = card.getAttribute('data-expanded') === 'true';
  const nowExpanded = !isExpanded;
  card.setAttribute('data-expanded', nowExpanded ? 'true' : 'false');

  // When expanding, mark any unseen reply as seen
  if (nowExpanded) {
    const match = state.matches.find((m) => m.id === matchId);
    if (match) {
      const hasUnseen = (match.reply_count > 0) &&
        (!match.last_reply_seen_at || new Date(match.last_reply_at) > new Date(match.last_reply_seen_at));
      if (hasUnseen) {
        const seenAt = new Date().toISOString();
        apiPost('/api/mark-reply-seen', { matchId }).catch(() => {});
        updateMatchInState(matchId, { last_reply_seen_at: seenAt });
        updateCard(matchId);
        updateHeaderReplyDot();
      }
    }
  }
}
window.toggleCardExpand = toggleCardExpand;

function isNeutralFallback(match) {
  const r  = match.relevance_score;
  const a  = match.audience_score;
  const rc = match.reach_score;
  const allFifty = r === 50 && a === 50 && rc === 50;
  const allZero  = (r === 0 || r == null) && (a === 0 || a == null) && (rc === 0 || rc == null);
  // Also catch demo match with hardcoded placeholder text — re-score against real client profile
  const hasPlaceholderText = (match.why_this_client_fits || '').includes('live demo match') ||
                             (match.best_pitch_angle || '').includes('goes directly to Zac');
  return allFifty || allZero || hasPlaceholderText;
}

/**
 * AI Enrich a single podcast card using ScrapeGraphAI.
 * Calls the backend API, updates the card in-place, and shows toast feedback.
 */
async function enrichAICard(matchId) {
  const btn = document.querySelector(`.sgai-enrich-btn[onclick*="'${matchId}'"]`);
  const originalText = btn ? btn.innerText : 'Enrich';

  try {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32 20" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>Enriching…
      </span>`;
      btn.style.background = '#e0e7ff';
      btn.style.color = '#6366f1';
      btn.style.cursor = 'wait';
    }

    const data = await apiPost(`/api/enrich-ai/${matchId}`, {});

    if (!data.ok) {
      const errorMap = {
        podcast_not_found: 'Podcast not found in database.',
        internal_error:    'Server error. Try again in a moment.',
        no_url_available:  'No website URL for this podcast.',
        empty_result:      'Could not extract data from this website.',
        sgai_timeout:      'ScrapeGraphAI timed out. Try again.',
        sgai_api_error:    'AI enrichment failed. Try again later.',
        db_update_failed:  'Failed to save enriched data.',
      };
      const msg = errorMap[data.error?.split(':')[0]] || data.error || 'Enrichment failed.';
      showToast(msg, 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalText;
        btn.style.cursor = 'pointer';
      }
      return;
    }

    // Success — update the match in state with enriched fields
    if (data.podcast) {
      const match = state.matches.find(m => m.id === matchId);
      if (match) {
        match.podcasts = { ...match.podcasts, ...data.podcast };
      }
    }

    showToast('🎯 Podcast enriched with AI data!', 'success');

    // Re-render the card to show new data
    updateCard(matchId);
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalText;
      btn.style.cursor = 'pointer';
    }
  }
}
window.enrichAICard = enrichAICard;

// ── Deep Enrich Card —────────────────────────────────────────────────────
// Uses SGAI to scrape the podcast's website for social links + email.
// Costs 2 credits charged to the client's balance.
// ── Deep enrichment handler ─────────────────────────────────────
async function deepEnrichCard(matchId, podcastId, btnEl) {
  // Remove button immediately — no loading state
  if (btnEl) btnEl.remove();

  try {
    const data = await apiPost(`/api/enrich-ai/deep/${podcastId}`, {});

    if (!data.ok) {
      const errorMap = {
        insufficient_credits: 'Not enough credits. Deep Enrich costs 2 credits.',
        internal_error:       'Server error. Try again in a moment.',
        podcast_not_found:    'Podcast not found in database.',
        no_url_available:     'No website URL available to scrape.',
        empty_result:         'Could not extract data from this website.',
        sgai_timeout:         'ScrapeGraphAI timed out. Try again.',
        sgai_api_error:       'Deep enrichment failed. Try again later.',
        db_update_failed:     'Failed to save enriched data.',
      };
      const msg = errorMap[data.error?.split(':')[0]] || data.error || 'Deep enrichment failed.';
      showToast(msg, 'error');
      return;
    }

    // Success — update the match in state with enriched fields
    if (data.podcast) {
      const match = state.matches.find(m => m.id === matchId);
      if (match) {
        match.podcasts = { ...match.podcasts, ...data.podcast };
      }
    }

    const fields = data.fields_found && data.fields_found.length
      ? ` (${data.fields_found.length} fields)`
      : '';
    showToast(`🎯 Deep enrich complete${fields}!`, 'success');

    // Re-render the card to show new social links
    updateCard(matchId);
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  }
}
// ── End of deep enrichment handler ──────────────────────────────

window.deepEnrichCard = deepEnrichCard;

/**
 * Silent background re-enrich for a single match.
 * No UI indicators — cards just update quietly once scores come back.
 */
async function triggerReEnrich(matchId) {
  try {
    const data = await apiPost(`/api/re-enrich/${matchId}`, {});
    if (data.success) {
      // Update podcast fields on the match in state so chips re-render correctly
      if (data.podcast) {
        const match = state.matches.find(m => m.id === matchId);
        if (match) {
          match.podcasts = { ...match.podcasts, ...data.podcast };
        }
      }
    }
    if (data.success && data.scores) {
      const s = data.scores;
      updateMatchInState(matchId, {
        fit_score:            s.fit_score,
        relevance_score:      s.relevance_score,
        audience_score:       s.audience_score,
        recency_score:        s.recency_score,
        reach_score:          s.reach_score,
        contactability_score: s.contactability_score,
        brand_score:          s.brand_score,
        guest_quality_score:  s.guest_quality_score,
        booking_likelihood:   s.booking_likelihood,
        why_this_client_fits: s.why_this_client_fits,
        best_pitch_angle:     s.best_pitch_angle,
        episode_to_reference: s.episode_to_reference,
        red_flags:            s.red_flags,
      });
      updateCard(matchId);
      updateStatBadges();
    }
  } catch {
    // Silently ignore — will retry next dashboard load
  }
}
window.triggerReEnrich = triggerReEnrich;

/**
 * On dashboard load: find all matches with neutral/missing scores and re-enrich
 * them in the background one by one. Client sees real scores appear quietly
 * without any loading states or toasts.
 */
async function backgroundReEnrichAll() {
  if (!state.matches?.length) return;
  const stale = state.matches.filter(isNeutralFallback);
  if (!stale.length) return;

  console.info(`[Re-enrich] ${stale.length} match(es) with missing scores — enriching in background`);

  // Process in batches of 3 concurrently, 800ms between batches
  const BATCH = 3;
  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = stale.slice(i, i + BATCH);
    await Promise.all(batch.map(m => triggerReEnrich(m.id)));
    if (i + BATCH < stale.length) {
      await new Promise(r => setTimeout(r, 800));
    }
  }
}

// ── Leaderboard ───────────────────────────────────────────────────────
let _leaderboardVisible = true;

function showLeaderboardView() {
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('leaderboard-tab')?.classList.add('active');
  $('cards-grid').style.display        = 'none';
  $('leaderboard-view').style.display  = '';
  $('min-score-slider')?.closest('label')?.style && ($('min-score-slider').closest('label').style.display = 'none');
  $('filter-has-email')?.closest('label')?.style && ($('filter-has-email').closest('label').style.display = 'none');
  // Set community group link
  const groupLink = $('community-group-link');
  if (groupLink && state.communityGroupUrl) {
    groupLink.href = state.communityGroupUrl;
  } else if (groupLink) {
    groupLink.style.display = 'none';
  }
  loadLeaderboard();
}
window.showLeaderboardView = showLeaderboardView;

function hideLeaderboardView() {
  $('leaderboard-view').style.display = 'none';
  $('cards-grid').style.display = '';
  document.getElementById('leaderboard-tab')?.classList.remove('active');
  $('min-score-slider')?.closest('label')?.style && ($('min-score-slider').closest('label').style.display = '');
  $('filter-has-email')?.closest('label')?.style && ($('filter-has-email').closest('label').style.display = '');
}

// ── Shared social icon builder ────────────────────────────────────────
function buildSocialIcons(m, size = 16) {
  const s = size;
  return [
    m.website        && `<a href="${esc(m.website)}" target="_blank" rel="noopener" title="Website" style="color:#6366f1;display:flex;"><svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></a>`,
    m.social_instagram && `<a href="${esc(m.social_instagram)}" target="_blank" rel="noopener" title="Instagram" style="color:#e1306c;display:flex;"><svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg></a>`,
    m.social_linkedin  && `<a href="${esc(m.social_linkedin)}" target="_blank" rel="noopener" title="LinkedIn" style="color:#0077b5;display:flex;"><svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg></a>`,
    m.social_twitter   && `<a href="${esc(m.social_twitter)}" target="_blank" rel="noopener" title="Twitter/X" style="color:#1da1f2;display:flex;"><svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 3a10.9 10.9 0 0 1-3.14 1.53 4.48 4.48 0 0 0-7.86 3v1A10.66 10.66 0 0 1 3 4s-4 9 5 13a11.64 11.64 0 0 1-7 2c9 5 20 0 20-11.5a4.5 4.5 0 0 0-.08-.83A7.72 7.72 0 0 0 23 3z"/></svg></a>`,
    m.social_facebook  && `<a href="${esc(m.social_facebook)}" target="_blank" rel="noopener" title="Facebook" style="color:#1877f2;display:flex;"><svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg></a>`,
  ].filter(Boolean).join('');
}

function buildMemberCard(m, featured = false) {
  const initials  = (m.display_name || m.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const name      = m.display_name || m.name || 'Member';
  const avatarSz  = featured ? 80 : 64;
  const border    = m.is_me ? '#6366f1' : (featured ? '#8b5cf6' : 'transparent');
  const avatar    = m.photo_url
    ? `<img src="${esc(m.photo_url)}" style="width:${avatarSz}px;height:${avatarSz}px;border-radius:50%;object-fit:cover;border:2.5px solid ${border};" />`
    : `<div style="width:${avatarSz}px;height:${avatarSz}px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:${featured?24:18}px;font-weight:700;color:#fff;border:2.5px solid ${border};flex-shrink:0;">${initials}</div>`;

  const statBadge = (val, label, color) => val > 0
    ? `<span style="font-size:11px;font-weight:700;color:${color};background:${color}18;border-radius:6px;padding:2px 8px;">${val} ${label}</span>`
    : '';
  const socials = buildSocialIcons(m, featured ? 18 : 15);
  const youBadge = m.is_me ? `<span style="font-size:10px;font-weight:700;color:#6366f1;background:#ede9fe;border-radius:999px;padding:1px 7px;margin-left:4px;">YOU</span>` : '';

  if (featured) {
    // Spotlight — horizontal hero card
    return `
      <div style="background:var(--bg-card);border-radius:16px;box-shadow:var(--shadow-card);border:2px solid #8b5cf6;padding:24px 28px;display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-bottom:24px;">
        <div style="position:relative;flex-shrink:0;">
          ${avatar}
          <div style="position:absolute;top:-6px;right:-6px;background:linear-gradient(135deg,#f59e0b,#f97316);border-radius:999px;padding:2px 8px;font-size:10px;font-weight:700;color:#fff;white-space:nowrap;">Member Spotlight</div>
        </div>
        <div style="flex:1;min-width:200px;">
          <div style="font-size:18px;font-weight:800;color:var(--text-primary);margin-bottom:2px;">${esc(name)}${youBadge}</div>
          ${m.title ? `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:2px;">${esc(m.title)}</div>` : ''}
          ${m.business_name ? `<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px;">${esc(m.business_name)}</div>` : ''}
          ${m.bio_short ? `<div style="font-size:13px;color:var(--text-secondary);line-height:1.5;margin-bottom:10px;max-width:480px;">${esc(m.bio_short.slice(0,180))}${m.bio_short.length>180?'…':''}</div>` : ''}
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
            ${statBadge(m.sent||0, 'Pitched', '#6366f1')}
            ${statBadge(m.booked||0, 'Booked', '#f59e0b')}
            ${statBadge(m.appeared||0, 'Aired', '#22c55e')}
          </div>
          ${socials ? `<div style="display:flex;gap:14px;align-items:center;">${socials}</div>` : ''}
        </div>
      </div>`;
  }

  // Option A — horizontal row card (podcast-card style), click to expand
  const cardId  = `member-card-${(m.display_name || m.name || Math.random()).replace(/\W+/g, '-')}`;
  const bioLong = m.bio_long || m.bio_short || '';
  const headline = m.bio_short || m.title || m.business_name || '';
  const avatar48 = m.photo_url
    ? `<img src="${esc(m.photo_url)}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;border:2px solid ${m.is_me ? '#6366f1' : 'var(--border-medium)'};flex-shrink:0;" />`
    : `<div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#fff;flex-shrink:0;border:2px solid ${m.is_me ? '#6366f1' : 'transparent'};">${initials}</div>`;

  // Empty state: what to show when no headline or bio
  const headlineHtml = headline
    ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;">${esc(headline)}</div>`
    : m.is_me
      ? `<div style="font-size:12px;color:#a78bfa;margin-top:2px;font-style:italic;">Add your headline in your profile</div>`
      : `<div style="font-size:12px;color:var(--text-tertiary);margin-top:2px;font-style:italic;">New member</div>`;

  const expandedBioHtml = bioLong
    ? `<p style="font-size:13px;color:var(--text-secondary);line-height:1.65;margin:14px 0 12px;">${esc(bioLong)}</p>`
    : m.is_me
      ? `<p style="font-size:13px;color:#a78bfa;font-style:italic;margin:14px 0 12px;">Your bio is empty. Add it in your profile so other members can get to know you.</p>`
      : `<p style="font-size:13px;color:var(--text-tertiary);font-style:italic;margin:14px 0 12px;">This member hasn't added a bio yet.</p>`;

  const hasStats = (m.sent||0) + (m.booked||0) + (m.appeared||0) > 0;

  return `
    <div id="${cardId}" style="background:var(--bg-card);border-radius:14px;box-shadow:var(--shadow-card);${m.is_me ? 'border:2px solid #6366f1;' : 'border:1.5px solid var(--border-subtle);'}overflow:hidden;min-width:0;width:100%;box-sizing:border-box;">
      <!-- Collapsed row — always visible, click to expand -->
      <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;min-width:0;overflow:hidden;">
        ${avatar48}
        <div style="flex:1;min-width:0;overflow:hidden;">
          <div style="font-size:13px;font-weight:700;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(name)}${youBadge}</div>
          ${headlineHtml}
        </div>
        ${socials ? `<div style="display:flex;gap:10px;align-items:center;flex-shrink:0;">${socials}</div>` : ''}
      </div>
    </div>`;
}

async function loadLeaderboard() {
  const card   = $('leaderboard-card');
  const body   = $('leaderboard-body');
  const grid   = $('community-members-grid');
  const empty  = $('leaderboard-empty');
  const spotEl = $('community-spotlight');
  if (!card || !body || !grid) return;

  try {
    const res = await apiFetch('/api/leaderboard');
    if (!res?.success) {
      // Show rankings section anyway with a note
      card.style.display  = '';
      empty.style.display = 'none';
      body.innerHTML = `<div style="padding:16px;font-size:12px;color:var(--text-tertiary);text-align:center;">Could not load rankings.</div>`;
      return;
    }

    const rows      = res.rows      || [];
    const community = res.community || [];
    const spotlight = res.spotlight || null;

    // ── Empty / placeholder state ────────────────────────────────────
    if (!rows.length) {
      card.style.display  = 'none';
      empty.style.display = '';
      return;
    }

    // ── Spotlight ────────────────────────────────────────────────────
    if (spotEl) {
      if (spotlight) {
        spotEl.innerHTML    = buildMemberCard(spotlight, true);
        spotEl.style.display = '';
      } else {
        spotEl.style.display = 'none';
      }
    }

    // ── Member cards ─────────────────────────────────────────────────
    if (community.length) {
      grid.innerHTML = community.map(m => buildMemberCard(m, false)).join('');
    } else {
      grid.innerHTML = `
        <div style="grid-column:1/-1;background:var(--bg-card);border-radius:14px;border:1.5px dashed var(--border-medium);padding:24px;text-align:center;">
          <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:4px;">No members visible yet</div>
          <div style="font-size:12px;color:var(--text-secondary);">Enable community sharing in your profile to appear here and connect with other members.</div>
          <button onclick="openProfileModal()" style="margin-top:12px;background:#6366f1;color:#fff;border:none;border-radius:999px;padding:8px 18px;font-size:12px;font-weight:700;cursor:pointer;">Update My Profile</button>
        </div>`;
    }

    // ── Rankings ─────────────────────────────────────────────────────
    const top10 = rows.slice(0, 10);
    const hasMe = top10.some(r => r.is_me);
    const meRow = !hasMe ? rows.find(r => r.is_me) : null;
    const medalMap = new Map();
    [...rows].sort((a, b) => b.appeared - a.appeared).slice(0, 3).forEach((r, i) => {
      if (r.appeared > 0) medalMap.set(r.rank, ['1st','2nd','3rd'][i]);
    });

    const renderRankRow = (r, divider = false) => {
      const medal = medalMap.get(r.rank) || '';
      const rankDisp = medal || `#${r.rank}`;
      return `
        ${divider ? `<div style="border-top:1px dashed var(--border-subtle);margin:4px 16px;"></div>` : ''}
        <div style="display:grid;grid-template-columns:36px 1fr 44px 44px 44px;align-items:center;padding:8px 16px;gap:4px;
          ${r.is_me ? 'background:linear-gradient(90deg,#f5f3ff,#ede9fe);border-left:3px solid #6366f1;' : 'border-left:3px solid transparent;'}">
          <div style="font-size:12px;font-weight:700;color:${medal ? '#f59e0b' : (r.is_me ? '#6366f1' : 'var(--text-secondary)')};">${rankDisp}</div>
          <div style="font-size:12px;font-weight:${r.is_me?'700':'500'};color:${r.is_me?'#6366f1':'var(--text-primary)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${esc(r.display_name)}${r.is_me ? ' <span style="font-size:9px;font-weight:700;color:#6366f1;background:#ede9fe;border-radius:999px;padding:1px 5px;margin-left:3px;">YOU</span>' : ''}
          </div>
          <div style="text-align:center;">${r.sent>0?`<span style="font-size:12px;font-weight:600;color:#6366f1;">${r.sent}</span>`:`<span style="font-size:11px;color:var(--text-tertiary);">—</span>`}</div>
          <div style="text-align:center;">${r.booked>0?`<span style="font-size:12px;font-weight:700;color:#f59e0b;">${r.booked}</span>`:`<span style="font-size:11px;color:var(--text-tertiary);">—</span>`}</div>
          <div style="text-align:center;">${r.appeared>0?`<span style="font-size:12px;font-weight:600;color:#22c55e;">${r.appeared}</span>`:`<span style="font-size:11px;color:var(--text-tertiary);">—</span>`}</div>
        </div>`;
    };

    body.innerHTML = `
      <div style="display:grid;grid-template-columns:36px 1fr 44px 44px 44px;align-items:center;padding:5px 16px;gap:4px;border-bottom:1px solid var(--border-subtle);">
        <div style="font-size:9px;font-weight:700;color:var(--text-tertiary);letter-spacing:0.06em;text-transform:uppercase;"></div>
        <div style="font-size:9px;font-weight:700;color:var(--text-tertiary);letter-spacing:0.06em;text-transform:uppercase;">Member</div>
        <div style="font-size:9px;font-weight:700;color:#6366f1;letter-spacing:0.06em;text-transform:uppercase;text-align:center;">P</div>
        <div style="font-size:9px;font-weight:700;color:#f59e0b;letter-spacing:0.06em;text-transform:uppercase;text-align:center;">B</div>
        <div style="font-size:9px;font-weight:700;color:#22c55e;letter-spacing:0.06em;text-transform:uppercase;text-align:center;">A</div>
      </div>
      ${top10.map(r => renderRankRow(r)).join('')}
      ${meRow ? renderRankRow(meRow, true) : ''}`;

    card.style.display  = '';
    empty.style.display = 'none';
  } catch {
    // Silently fail
  }
}

async function loadWinsFeed() {
  const feed = $('wins-feed');
  if (!feed) return;
  try {
    const res = await apiFetch('/api/leaderboard/wins');
    if (!res?.success || !res.wins?.length) {
      feed.innerHTML = `<p style="font-size:12px;color:var(--text-tertiary);padding:16px;text-align:center;">No wins yet. Be the first to get booked!</p>`;
      return;
    }
    feed.innerHTML = res.wins.map(w => {
      const initials = (w.first_name || '?')[0].toUpperCase();
      const avatar   = w.photo_url
        ? `<img src="${esc(w.photo_url)}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;" />`
        : `<div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0;">${initials}</div>`;
      const verb  = w.status === 'appeared' ? 'aired on' : 'got booked on';
      const color = w.status === 'appeared' ? '#22c55e' : '#f59e0b';
      const icon  = w.status === 'appeared'
        ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`
        : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
      const ago   = (() => {
        const d = new Date(w.at);
        const diff = Date.now() - d;
        const hrs  = Math.floor(diff / 36e5);
        const days = Math.floor(diff / 864e5);
        return days > 0 ? `${days}d ago` : hrs > 0 ? `${hrs}h ago` : 'just now';
      })();
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--border-subtle);">
          ${avatar}
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;color:var(--text-primary);line-height:1.4;">
              <strong>${esc(w.first_name)}</strong> ${verb} <strong style="color:${color};">${esc(w.show)}</strong>
            </div>
            <div style="display:flex;align-items:center;gap:4px;margin-top:2px;">
              ${icon}
              <span style="font-size:11px;color:var(--text-tertiary);">${esc(ago)}</span>
            </div>
          </div>
        </div>`;
    }).join('');
  } catch {
    // Silently fail
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

// ── Small date formatter ───────────────────────────────────────────────
function formatDateShort(date) {
  if (!date || isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Render a single match card ────────────────────────────────────────
function renderMatchCard(match) {
  const podcast    = match.podcasts || {};
  const fitScore   = match.fit_score || 0;
  const tier       = scoreTier(fitScore);
  const tierClass  = `score-tier-${tier}`;
  const likeCls    = likelihoodClass(match.booking_likelihood);
  const isBooked   = match.status === 'booked';
  const bookedClass = isBooked ? 'card-booked-highlight' : '';

  const episodeHtml = '';

  const socialHtml = '';

  return `
  <article class="match-card status-${esc(match.status)} ${tierClass} ${bookedClass}" id="card-${esc(match.id)}" data-status="${esc(match.status)}" data-score="${fitScore}" data-expanded="false">

    <!-- Collapsed row — click to expand -->
    <div class="card-row" onclick="toggleCardExpand('${esc(match.id)}')">
      <div class="card-row-left">
        ${podcast.image ? `<div class="card-cover-wrap"><img class="card-cover" src="${esc(podcast.image)}" alt="${esc(podcast.title)||'Podcast'}" loading="lazy" /></div>` : ''}
        <div class="card-row-content">
          <div class="card-row-title">
          ${esc(podcast.title) || 'Unknown Show'}
          ${(() => {
            const pills = [];
            if (podcast.total_episodes) pills.push(`<span class="inline-pill">${podcast.total_episodes} eps</span>`);
            if (podcast.last_episode_date) {
              const days = Math.round((Date.now() - new Date(podcast.last_episode_date).getTime()) / 86400000);
              pills.push(`<span class="inline-pill">${days}d ago</span>`);
            }
            // Showcase card never shows synthetic audience numbers — would
            // be a fabrication. Real shows can show their estimate.
            if (!match._showcase) {
              if (podcast.estimated_monthly_listeners) {
                const n = podcast.estimated_monthly_listeners;
                const label = n >= 1000000 ? (n/1000000).toFixed(1).replace(/\.0$/,'')+'M' : n >= 1000 ? Math.round(n/1000)+'K' : n;
                pills.push(`<span class="inline-pill" style="background:rgba(99,102,241,0.08);color:#6366f1;border-color:rgba(99,102,241,0.2);" title="Estimated monthly listeners from Rephonic">~${label}/mo</span>`);
              } else if (podcast.listen_score) {
                const est = estimateAudience(podcast.listen_score);
                pills.push(`<span class="inline-pill" style="background:rgba(99,102,241,0.08);color:#6366f1;border-color:rgba(99,102,241,0.2);" title="Estimated monthly listeners based on listen score">~${est.label}/mo</span>`);
              }
            }
            if (podcast.country) pills.push(`<span class="inline-pill">${esc(podcast.country)}</span>`);
            return pills.join('');
          })()}
        </div>
        ${podcast.host_name ? `<div class="card-row-host">Hosted by ${esc(podcast.host_name)}</div>` : ''}
        <div class="card-row-links" onclick="event.stopPropagation()">
          ${isValidUrl(podcast.apple_url) && podcast.apple_url.toLowerCase().includes('apple.com') ? `<a class="card-link-chip" href="${esc(podcast.apple_url)}" target="_blank" rel="noopener">Apple Podcasts</a>` : ''}
          ${isValidUrl(podcast.spotify_url) && podcast.spotify_url.toLowerCase().includes('spotify.com') ? `<a class="card-link-chip" href="${esc(podcast.spotify_url)}" target="_blank" rel="noopener">Spotify</a>` : ''}
          ${(isValidUrl(podcast.soundcloud_url) && podcast.soundcloud_url.toLowerCase().includes('soundcloud.com')) || (isValidUrl(podcast.apple_url) && podcast.apple_url.toLowerCase().includes('soundcloud.com')) ? `<a class="card-link-chip" href="${esc(podcast.soundcloud_url || podcast.apple_url)}" target="_blank" rel="noopener">SoundCloud</a>` : ''}
          ${podcast.website ? `<a class="card-link-chip" href="${esc(podcast.website)}" target="_blank" rel="noopener"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Website</a>` : ''}
          ${isValidSocialProfile(podcast.twitter_url, "twitter") ? `<a class="card-link-chip" href="${esc(podcast.twitter_url)}" target="_blank" rel="noopener">Twitter/X</a>` : ""}
          ${isValidSocialProfile(podcast.facebook_url, "facebook") ? `<a class="card-link-chip" href="${esc(podcast.facebook_url)}" target="_blank" rel="noopener">Facebook</a>` : ""}
          ${isValidSocialProfile(podcast.linkedin_page_url || podcast.linkedin_url, "linkedin") ? `<a class="card-link-chip" href="${esc(podcast.linkedin_page_url || podcast.linkedin_url)}" target="_blank" rel="noopener">LinkedIn</a>` : ""}
          ${isValidSocialProfile(podcast.youtube_url, "youtube") ? `<a class="card-link-chip" href="${esc(podcast.youtube_url)}" target="_blank" rel="noopener">YouTube</a>` : ""}
          ${isValidUrl(podcast.tiktok_url) ? `<a class="card-link-chip" href="${esc(podcast.tiktok_url)}" target="_blank" rel="noopener">TikTok</a>` : ""}
          ${isValidUrl(podcast.booking_page_url) ? `<a class="card-link-chip" href="${esc(podcast.booking_page_url)}" target="_blank" rel="noopener">Booking Page</a>` : ""}
          ${isValidSocialProfile(podcast.instagram_url, 'instagram') ? `<a class="card-link-chip" href="${esc(podcast.instagram_url)}" target="_blank" rel="noopener">Instagram <span style="font-size:9px;font-weight:700;background:rgba(99,102,241,0.18);color:#6366f1;border-radius:8px;padding:1px 5px;margin-left:3px;letter-spacing:0.3px;">BETA</span></a>` : ''}
          ${podcast.contact_email && !/podcasts\d*\+[a-f0-9]+@anchor\.fm/i.test(podcast.contact_email) ? `<a class="card-link-chip" href="#" onclick="copyEmail(event,'${esc(podcast.contact_email)}')" title="Click to copy email"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> ${esc(podcast.contact_email)}</a>` : ''}
        ${match.reply_count >= 1 ? `<span class="reply-count-badge"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> ${match.reply_count} ${match.reply_count === 1 ? 'reply' : 'replies'}</span>` : ''}
        </div>
        <!-- /.card-row-content -->
        </div>
      </div>
      <div class="card-row-right">
        ${nextActionPillHtml(match)}
        ${statusBadgeHtml(match.status)}
        ${(() => {
          const hasUnseen = (match.reply_count > 0) &&
            (!match.last_reply_seen_at || new Date(match.last_reply_at) > new Date(match.last_reply_seen_at));
          if (!hasUnseen) return '';
          return `<span class="new-reply-badge"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> New Reply</span>`;
        })()}
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
          ${match.seo_score != null ? scoreBarHtml('SEO Value', match.seo_score) : ''}
        </div>

        <!-- Why fits — only relevant for pre-booking pipeline stages -->
        ${['new','dream','sent','followed_up','replied'].includes(match.status) && match.why_this_client_fits ? `
        <div class="why-fits-box">
          <p class="why-fits-label">Why You Fit</p>
          <p class="why-fits-text">${esc(match.why_this_client_fits)}</p>
        </div>` : ''}

        <!-- Best Pitch Angle — only for pre-booking stages -->
        ${['new','dream','sent','followed_up','replied'].includes(match.status) ? `
        <div class="card-analysis">
          ${match.best_pitch_angle ? `
          <div class="why-fits-box">
            <p class="why-fits-label">Best Pitch Angle</p>
            <p class="pitch-text">${esc(match.best_pitch_angle)}</p>
          </div>` : ''}
      ${episodeHtml}
    </div>` : ''}

        <!-- Booking info — shown on Booked tab -->
        ${match.status === 'booked' ? `
        <div class="why-fits-box">
          <p class="why-fits-label">Booking Details</p>
          ${match.booked_show_name ? `<p class="why-fits-text" style="margin-bottom:6px;"><strong>Show:</strong> ${esc(match.booked_show_name)}</p>` : ''}
          ${match.booked_at ? `<p class="why-fits-text" style="margin-bottom:6px;"><strong>Booked:</strong> ${formatDateShort(new Date(match.booked_at))}</p>` : ''}
          ${match.client_notes ? `<p class="why-fits-text" style="margin-bottom:6px;"><strong>Notes:</strong> ${esc(match.client_notes)}</p>` : ''}
        </div>` : ''}

    <!-- Meta tags -->
    ${metaTagsHtml(podcast)}

    <!-- Social chips -->
    ${socialHtml}


        <!-- Footer: action buttons -->
        <div class="card-footer">
          ${actionButtonsHtml(match)}
        </div>

      </div><!-- /.card-expanded-inner -->
    </div><!-- /.card-expanded -->

    <!-- Inline pitch panel -->
    ${['new','dream','sent','followed_up','replied','booked'].includes(match.status) ? `
    <div class="inline-pitch-panel" id="pitch-panel-${esc(match.id)}">
      <div class="inline-pitch-header">
        <span class="inline-pitch-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px;"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>Pitch Email
        </span>
        <button class="inline-pitch-close" onclick="toggleInlinePitch('${esc(match.id)}')" title="Close">&#x2715;</button>
      </div>
      <select id="inline-preset-${esc(match.id)}" class="inline-pitch-field" style="display:none;cursor:pointer;"></select>
      <div class="inline-field-group">
        <label class="inline-field-label">Subject</label>
        <input id="inline-subject-${esc(match.id)}" type="text" class="inline-pitch-field inline-subject-field" placeholder="Subject line…" oninput="updatePitchPreview('${esc(match.id)}')" />
      </div>
      <div class="inline-field-group">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <label class="inline-field-label">Message</label>
          <span class="inline-word-count" id="inline-wc-${esc(match.id)}"></span>
        </div>
        <textarea id="inline-body-${esc(match.id)}" class="inline-pitch-field inline-pitch-body-field" placeholder="Your pitch will appear here…" oninput="updatePitchPreview('${esc(match.id)}')"></textarea>
      </div>
      <div class="pitch-preview-strip" id="pitch-preview-${esc(match.id)}"></div>
      <div class="inline-pitch-actions">
        <button class="btn btn-action-send btn-xs" onclick="sendFromInline('${esc(match.id)}')">Send</button>
        <button id="inline-rewrite-${esc(match.id)}" class="btn btn-xs" style="background:#f0ebff;color:#6366f1;border:1.5px solid #c4b5fd;font-weight:600;" onclick="rewriteInlinePitch('${esc(match.id)}')">Rewrite Pitch</button>
      </div>
    </div>` : ''}

    <!-- Inline follow-up panel -->
    ${['sent','followed_up'].includes(match.status) ? `
    <div class="inline-pitch-panel" id="followup-panel-${esc(match.id)}">
      <div class="inline-pitch-header">
        <span class="inline-pitch-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px;"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>Follow Up Email
        </span>
        <button class="inline-pitch-close" onclick="toggleFollowUpPanel('${esc(match.id)}')" title="Close">&#x2715;</button>
      </div>
      <select id="followup-seq-${esc(match.id)}" class="inline-pitch-field" style="cursor:pointer;" onchange="applyFollowUpSequenceInline('${esc(match.id)}')">
        <option value="custom">Custom message…</option>
        <option value="followup1">Follow-up 1: Quick check-in</option>
        <option value="followup2">Follow-up 2: Add value angle</option>
        <option value="followup3">Follow-up 3: Last note</option>
      </select>
      <div class="inline-field-group">
        <label class="inline-field-label">Subject</label>
        <input id="followup-subj-${esc(match.id)}" type="text" class="inline-pitch-field inline-subject-field" placeholder="Subject line…" />
      </div>
      <div class="inline-field-group">
        <label class="inline-field-label">Message</label>
        <textarea id="followup-body-${esc(match.id)}" class="inline-pitch-field inline-pitch-body-field" placeholder="Your follow-up message…"></textarea>
      </div>
      <div class="inline-pitch-actions">
        <button class="btn btn-action-followup btn-xs" id="followup-send-btn-${esc(match.id)}" onclick="sendFollowUpFromPanel('${esc(match.id)}')">Send Follow Up</button>
        <button class="btn btn-xs" id="followup-rewrite-btn-${esc(match.id)}" style="background:#f0ebff;color:#6366f1;border:1.5px solid #c4b5fd;font-weight:600;" onclick="rewriteFollowUp('${esc(match.id)}')">Generate</button>
      </div>
    </div>` : ''}

    <!-- Inline thank you panel -->
    ${match.status === 'appeared' ? `
    <div class="inline-pitch-panel" id="thankyou-panel-${esc(match.id)}">
      <div class="inline-pitch-header">
        <span class="inline-pitch-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px;"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>Thank You Email
        </span>
        <button class="inline-pitch-close" onclick="toggleThankYouPanel('${esc(match.id)}')" title="Close">&#x2715;</button>
      </div>
      <div class="inline-field-group">
        <label class="inline-field-label">Subject</label>
        <input id="thankyou-subj-${esc(match.id)}" type="text" class="inline-pitch-field inline-subject-field" placeholder="Subject line…" />
      </div>
      <div class="inline-field-group">
        <label class="inline-field-label">Message</label>
        <textarea id="thankyou-body-${esc(match.id)}" class="inline-pitch-field inline-pitch-body-field" placeholder="Your thank you message…"></textarea>
      </div>
      <div class="inline-pitch-actions">
        <button id="thankyou-generate-btn-${esc(match.id)}" class="btn btn-xs" style="background:#f0ebff;color:#6366f1;border:1.5px solid #c4b5fd;font-weight:600;" onclick="generateThankYou('${esc(match.id)}')">Generate</button>
        <button class="btn btn-action-send btn-xs" onclick="sendThankYouFromPanel('${esc(match.id)}')">Send</button>
      </div>
    </div>` : ''}

    <!-- Social DM panel -->
    ${(() => {
      const p = match.podcasts || {};

      // Extract a clean @handle or /slug from a validated URL.
      // Returns null if the URL doesn't resolve to a recognisable profile path.
      function extractHandle(url, platform) {
        if (!url) return null;
        let u;
        try { u = new URL(url); } catch { return null; }
        const segments = u.pathname.split('/').filter(Boolean);
        if (!segments.length) return null;
        switch (platform) {
          case 'instagram':
          case 'twitter': {
            const handle = segments[0];
            // Must look like a real username — no dots-only, no just numbers that look like IDs
            if (!/^[a-z0-9_.]{1,30}$/i.test(handle)) return null;
            return '@' + handle;
          }
          case 'linkedin': {
            // /company/slug or /in/slug — show the slug
            if (segments.length >= 2 && (segments[0] === 'company' || segments[0] === 'in')) {
              return segments[1].slice(0, 30);
            }
            return null;
          }
          case 'facebook': {
            // Skip numeric IDs (profile.php?id=... style leaked through, or /100012345678/)
            const slug = segments[segments.length - 1];
            if (/^\d+$/.test(slug)) return null;
            if (slug.length < 2) return null;
            return slug.slice(0, 30);
          }
          default: return null;
        }
      }

      const platforms = [];
      const candidates = [
        { key: 'instagram_url',                       platform: 'instagram', label: 'Instagram'  },
        { key: 'twitter_url',                         platform: 'twitter',   label: 'Twitter/X'  },
        { key: 'linkedin_page_url||linkedin_url',     platform: 'linkedin',  label: 'LinkedIn'   },
        { key: 'facebook_url',                        platform: 'facebook',  label: 'Facebook'   },
      ];
      for (const c of candidates) {
        const url = c.key.includes('||')
          ? (p[c.key.split('||')[0]] || p[c.key.split('||')[1]])
          : p[c.key];
        if (!isValidSocialProfile(url, c.platform)) continue;
        const handle = extractHandle(url, c.platform);
        if (!handle) continue;               // no recognisable handle → skip button entirely
        platforms.push({ label: c.label, url, handle });
      }
      if (!platforms.length) return '';
      const platformBtns = platforms.map(pl =>
        `<a href="${esc(pl.url)}" target="_blank" rel="noopener" class="btn btn-xs" title="${esc(pl.url)}" style="background:#fff7ed;color:#c2410c;border:1.5px solid #fed7aa;font-weight:600;text-decoration:none;">${esc(pl.label)} <span style="opacity:0.7;font-weight:400;">${esc(pl.handle)}</span></a>`
      ).join('');
      return `
    <div class="social-dm-panel" id="dm-panel-${esc(match.id)}">
      <div class="social-dm-header">DM Template: copy and send on social</div>
      <textarea class="social-dm-script inline-pitch-field inline-pitch-body-field" id="dm-script-${esc(match.id)}" style="min-height:140px;line-height:1.6;">${esc(buildDMScriptFromMatch(match))}</textarea>
      <div class="social-dm-platforms">
        <button class="btn btn-xs" style="background:#6366f1;color:#fff;font-weight:600;border:none;" onclick="copyDMScript('${esc(match.id)}')">Copy DM</button>
        <button class="btn btn-xs" style="background:#f0ebff;color:#6366f1;border:1.5px solid #c4b5fd;font-weight:600;" id="dm-regen-btn-${esc(match.id)}" onclick="regenerateDMScript('${esc(match.id)}')">Regenerate</button>
      </div>
    </div>`;
    })()}

    <!-- Content Boost episode link submission -->
    ${match.content_boost_status === 'ordered' ? `
    <div class="boost-link-section" id="boost-link-section-${esc(match.id)}" style="border-top:1px solid var(--border-subtle,#f0f0f0);padding:16px 20px;background:linear-gradient(135deg,#f5f3ff 0%,#ede9fe 100%);">
      <p style="font-size:13px;font-weight:700;color:#6366f1;margin:0 0 6px;">Content Boost: Submit Your Episode</p>
      <p style="font-size:12px;color:#555;margin:0 0 12px;">Paste the link to your episode (Spotify, Apple, YouTube, etc.) so our team can download and start editing.</p>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="url" id="boost-url-${esc(match.id)}" class="form-input" placeholder="https://open.spotify.com/episode/..." style="flex:1;height:36px;padding:0 10px;border-radius:8px;border:1px solid #c4b5fd;font-size:13px;background:#fff;" />
        <button class="btn btn-primary btn-sm" onclick="submitEpisodeLink('${esc(match.id)}')" id="boost-link-btn-${esc(match.id)}" style="height:36px;white-space:nowrap;background:linear-gradient(135deg,#6366f1,#8b5cf6);">Send to Team</button>
      </div>
    </div>` : match.content_boost_status === 'completed' ? `
    <div style="border-top:1px solid var(--border-subtle,#f0f0f0);padding:12px 20px;background:linear-gradient(135deg,#f0fdf4 0%,#dcfce7 100%);">
      <p style="font-size:13px;font-weight:700;color:#16a34a;margin:0;">Content Boost complete. Check your inbox for your 30 days of content!</p>
    </div>` : match.content_boost_status === 'requested' ? `
    <div style="border-top:1px solid var(--border-subtle,#f0f0f0);padding:12px 20px;background:#fffbeb;">
      <p style="font-size:13px;color:#92400e;margin:0;">Payment is processing. Once confirmed you'll be able to submit your episode link.</p>
    </div>` : ''}

  </article>`;
}

// ── Filter & sort ─────────────────────────────────────────────────────
function getFilteredSorted() {
  // Deduplicate by title (primary) — keep the match with most data / highest score
  const byTitle = new Map();
  for (const m of state.matches) {
    const title = (m.podcasts?.title || '').toLowerCase().trim();
    // In demo mode, redacted titles collapse to block characters of similar
    // length and would otherwise collide on the dedup key, hiding most cards.
    // Skip title-based dedup when the title is just blocks; fall through to
    // podcast_id which is always unique.
    const isRedacted = title && /^█+$/.test(title);
    const key   = (isRedacted ? null : title) || m.podcast_id || m.id;
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, m);
    } else {
      // Priority: user-actioned statuses always beat 'new' (prevents pitched/booked cards disappearing)
      const ACTION_PRIORITY = { booked: 6, appeared: 5, replied: 4, followed_up: 3, sent: 2, dream: 1, dismissed: 1, new: 0 };
      const mPriority = ACTION_PRIORITY[m.status] ?? 0;
      const ePriority = ACTION_PRIORITY[existing.status] ?? 0;
      const mScore = m.fit_score || 0;
      const eScore = existing.fit_score || 0;
      const mHasData = !!(m.podcasts?.total_episodes || m.podcasts?.contact_email);
      const eHasData = !!(existing.podcasts?.total_episodes || existing.podcasts?.contact_email);
      if (mPriority > ePriority) {
        byTitle.set(key, m);
      } else if (mPriority === ePriority && (mScore > eScore || (mScore === eScore && mHasData && !eHasData))) {
        byTitle.set(key, m);
      }
    }
  }
  let matches = [...byTitle.values()];

  if (state.filter === 'content_boost') {
    matches = matches.filter((m) => !!m.content_boost_status);
  } else if (state.filter === 'new') {
    matches = matches.filter((m) => m.status === 'new');
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

  // 'New' tab sort priority:
  //   1. Most-recently added at top (manual +Add a Podcast inserts always float to top)
  //   2. Cards with no email AND no Apple URL sink to the bottom (nothing actionable)
  //   3. Restored cards float above older auto-discovered ones
  //   4. Fit score as final tiebreaker within same bucket
  if (state.filter === 'new') {
    matches.sort((a, b) => {
      // 1. Recency: anything created in the last 24h beats anything older
      const now = Date.now();
      const aCreated = new Date(a.created_at || 0).getTime();
      const bCreated = new Date(b.created_at || 0).getTime();
      const aIsFresh = (now - aCreated) < 24 * 60 * 60 * 1000;
      const bIsFresh = (now - bCreated) < 24 * 60 * 60 * 1000;
      if (aIsFresh && !bIsFresh) return -1;
      if (!aIsFresh && bIsFresh) return 1;
      if (aIsFresh && bIsFresh) return bCreated - aCreated; // most recent fresh add first
      // 2. Actionable (has email or apple url) first
      const aActionable = !!(a.podcasts?.contact_email || a.podcasts?.apple_url);
      const bActionable = !!(b.podcasts?.contact_email || b.podcasts?.apple_url);
      if (aActionable && !bActionable) return -1;
      if (!aActionable && bActionable) return 1;
      // 3. Restored cards above older
      if (a.restored_at && !b.restored_at) return -1;
      if (!a.restored_at && b.restored_at) return 1;
      if (a.restored_at && b.restored_at) return new Date(b.restored_at) - new Date(a.restored_at);
      // 4. Fit score
      return (b.fit_score || 0) - (a.fit_score || 0);
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
    grid.innerHTML = renderEmptyTabState();
    if (noResults) noResults.style.display = 'none';
  } else {
    if (noResults) noResults.style.display = 'none';
    grid.innerHTML = filtered.map(renderMatchCard).join('');
  }
}

// ── Top alert banner — Gmail not connected / OAuth scope problem ───────
function renderTopAlertBanner() {
  const el = document.getElementById('top-alert-banner');
  if (!el) return;
  const c = state.client || {};

  // Priority 1: DEMO MODE banner. The whole pipeline is locked, this needs to
  // be loud. Sticky and dismissable only by upgrading.
  if (state.demo?.active) {
    const expiresAt = state.demo.expires_at ? new Date(state.demo.expires_at) : null;
    const daysLeft  = expiresAt ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86400000)) : null;
    const expired   = state.demo.expired;
    const title = expired
      ? 'Your demo expired. Unlock to keep your pipeline.'
      : 'Demo mode · You can browse, but actions are locked.';
    const sub = expired
      ? "Your matches are still here. Upgrade to start contacting hosts and sending pitches."
      : (daysLeft !== null
          ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left in your demo. Unlock to send pitches, see contact details, and get the real platform.`
          : 'Unlock to send pitches, see contact details, and get the real platform.');
    el.style.display = 'block';
    el.innerHTML = `
      <div style="max-width:1400px;margin:0 auto;padding:12px 24px 0;">
        <div style="display:flex;align-items:center;gap:14px;background:linear-gradient(135deg,#1e1b4b,#312e81);border:1.5px solid #6366f1;border-radius:14px;padding:14px 18px;color:#fff;">
          <div style="flex-shrink:0;width:36px;height:36px;border-radius:50%;background:#6366f1;display:flex;align-items:center;justify-content:center;">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:800;color:#fff;margin-bottom:2px;">${esc(title)}</div>
            <div style="font-size:12.5px;color:rgba(255,255,255,0.78);line-height:1.45;">${esc(sub)}</div>
          </div>
          <button onclick="openUpgradeModal()" style="flex-shrink:0;background:#fff;color:#312e81;border:none;font-size:13px;font-weight:700;padding:9px 18px;border-radius:8px;white-space:nowrap;cursor:pointer;">Unlock pipeline →</button>
        </div>
      </div>`;
    return;
  }

  // Priority 2: Gmail OAuth callback can redirect with ?gmailError=reauth_required when
  // the refresh token gets revoked or expires. Surface that loud.
  const urlError = new URLSearchParams(window.location.search).get('gmailError');
  const needsReconnect = urlError === 'reauth_required';
  const notConnected   = !c.gmail_email;
  if (!notConnected && !needsReconnect) { el.innerHTML = ''; el.style.display = 'none'; return; }

  const title = needsReconnect ? 'Gmail needs to be reconnected.' : 'Connect Gmail to send your pitches.';
  const sub   = needsReconnect
    ? 'Your Gmail token expired. Pitches and reply detection are paused until you reconnect (30 seconds).'
    : "Without Gmail you can't send pitches or auto-detect host replies. Takes 30 seconds.";
  const btnLabel = needsReconnect ? 'Reconnect Gmail' : 'Connect Gmail';
  el.style.display = 'block';
  el.innerHTML = `
    <div style="max-width:1400px;margin:0 auto;padding:12px 24px 0;">
      <div style="display:flex;align-items:center;gap:14px;background:linear-gradient(135deg,#fef3c7,#fde68a);border:1.5px solid #f59e0b;border-radius:14px;padding:14px 18px;">
        <div style="flex-shrink:0;width:36px;height:36px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#b45309" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:800;color:#78350f;margin-bottom:2px;">${esc(title)}</div>
          <div style="font-size:12.5px;color:#92400e;line-height:1.45;">${esc(sub)}</div>
        </div>
        <a href="/auth/gmail?clientId=${esc(c.id || '')}" style="flex-shrink:0;background:#b45309;color:#fff;text-decoration:none;font-size:13px;font-weight:700;padding:9px 16px;border-radius:8px;white-space:nowrap;">${esc(btnLabel)}</a>
      </div>
    </div>`;
}

// Upgrade modal — every locked action button funnels here. Click "Unlock"
// hits /api/demo/unlock-checkout which creates a Stripe Checkout Session with
// success_url baked to land them back on THEIR dashboard post-payment with
// ?unlocked=success. The poll-and-reload then surfaces the unredacted matches.
function openUpgradeModal() {
  let modal = document.getElementById('upgrade-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'upgrade-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,15,25,0.72);backdrop-filter:blur(6px);z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px;';
    modal.onclick = (e) => { if (e.target === modal) closeUpgradeModal(); };
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div style="background:#fff;border-radius:18px;padding:36px 36px 32px;max-width:480px;width:100%;box-shadow:0 30px 80px rgba(0,0,0,0.4);">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;">
        <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#312e81);display:flex;align-items:center;justify-content:center;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <div style="flex:1;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;color:#6366f1;text-transform:uppercase;">Unlock the platform</div>
          <div style="font-size:20px;font-weight:800;color:#1d1d1f;letter-spacing:-0.01em;margin-top:2px;">Ready to start booking?</div>
        </div>
        <button onclick="closeUpgradeModal()" style="background:none;border:none;font-size:24px;color:#86868b;cursor:pointer;line-height:1;">×</button>
      </div>
      <p style="font-size:14.5px;color:#4b4b52;line-height:1.6;margin:0 0 22px;">Your pipeline is real. The matches, the AI pitches, the scoring — all generated for your profile. Unlock now to:</p>
      <ul style="list-style:none;padding:0;margin:0 0 24px;display:flex;flex-direction:column;gap:9px;">
        <li style="font-size:14px;color:#1d1d1f;padding-left:24px;position:relative;">
          <span style="position:absolute;left:0;top:1px;width:16px;height:16px;background:#eef0ff;color:#6366f1;border-radius:50%;font-size:10px;font-weight:800;display:grid;place-items:center;">✓</span>
          See every podcast title, host name and contact email
        </li>
        <li style="font-size:14px;color:#1d1d1f;padding-left:24px;position:relative;">
          <span style="position:absolute;left:0;top:1px;width:16px;height:16px;background:#eef0ff;color:#6366f1;border-radius:50%;font-size:10px;font-weight:800;display:grid;place-items:center;">✓</span>
          Send AI-drafted pitches from your own Gmail
        </li>
        <li style="font-size:14px;color:#1d1d1f;padding-left:24px;position:relative;">
          <span style="position:absolute;left:0;top:1px;width:16px;height:16px;background:#eef0ff;color:#6366f1;border-radius:50%;font-size:10px;font-weight:800;display:grid;place-items:center;">✓</span>
          Live reply detection (5-min cron, email alert)
        </li>
        <li style="font-size:14px;color:#1d1d1f;padding-left:24px;position:relative;">
          <span style="position:absolute;left:0;top:1px;width:16px;height:16px;background:#eef0ff;color:#6366f1;border-radius:50%;font-size:10px;font-weight:800;display:grid;place-items:center;">✓</span>
          500 monthly pitch credits, top-ups available
        </li>
      </ul>
      <button id="upgrade-cta-btn" onclick="startDemoCheckout()" style="width:100%;display:block;text-align:center;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;border:none;text-decoration:none;padding:14px 22px;border-radius:10px;font-weight:700;font-size:15px;box-shadow:0 8px 24px rgba(99,102,241,0.3);cursor:pointer;">Unlock pipeline →</button>
      <p style="text-align:center;font-size:12px;color:#86868b;margin:14px 0 0;">$997 AUD · Secure checkout via Stripe · Pipeline unlocks instantly on payment.</p>
    </div>
  `;
  modal.style.display = 'flex';
}
async function startDemoCheckout() {
  const btn = document.getElementById('upgrade-cta-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = 'Opening checkout…'; }
  try {
    const data = await apiPost('/api/demo/unlock-checkout', {});
    if (data.ok && data.url) {
      window.location.href = data.url;
    } else if (data.error === 'stripe_not_configured') {
      showToast('Checkout temporarily unavailable. Email hi@zacdeane.com to unlock manually.', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = 'Unlock pipeline →'; }
    } else {
      showToast(data.error || 'Could not start checkout. Try again.', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = 'Unlock pipeline →'; }
    }
  } catch {
    showToast('Network error. Please try again.', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = 'Unlock pipeline →'; }
  }
}
window.startDemoCheckout = startDemoCheckout;
function closeUpgradeModal() {
  const modal = document.getElementById('upgrade-modal');
  if (modal) modal.style.display = 'none';
}
window.openUpgradeModal  = openUpgradeModal;
window.closeUpgradeModal = closeUpgradeModal;

// ── Empty-state CTAs per tab ──────────────────────────────────────────
function renderEmptyTabState() {
  const tab = state.currentFilter || 'new';

  // Special case: DEMO ACCOUNT with zero matches yet. Don't auto-poll —
  // the pipeline runs ONLY when the prospect clicks Find A Podcast, that's
  // the demo's wow moment. Show a big inviting prompt instead.
  if (tab === 'new' && state.demo?.active && state.matches.length === 0) {
    return `
      <div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 24px;text-align:center;background:linear-gradient(180deg,#eef0ff,#fff);border:1.5px solid #c7d2fe;border-radius:18px;margin-top:8px;">
        <div style="display:inline-flex;align-items:center;gap:8px;background:#6366f1;color:#fff;padding:6px 14px;border-radius:99px;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:18px;">▸ Live demo</div>
        <div style="font-size:24px;font-weight:800;color:#1d1d1f;margin-bottom:10px;letter-spacing:-0.01em;">Click Find A Podcast to see the magic.</div>
        <p style="font-size:14.5px;color:#4b4b52;max-width:520px;line-height:1.6;margin-bottom:24px;">We'll search 4M+ podcasts, score the top 10 against your profile, and write a personalised pitch for each one in about 90 seconds. Your matches are real — only the contact details stay locked until you upgrade.</p>
        <button onclick="runPipeline()" style="background:#6366f1;color:#fff;border:none;border-radius:999px;padding:13px 26px;font-size:15px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px;box-shadow:0 8px 24px rgba(99,102,241,0.3);">
          Find A Podcast
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>
      </div>
    `;
  }

  // Special case: paid customer just signed up and the first-run pipeline is
  // still running in the background. Show a clear "we're working" state with
  // auto-polling.
  if (tab === 'new' && state.client && !state.client.last_run_at && !state.demo?.active) {
    const created = state.client.created_at ? new Date(state.client.created_at) : null;
    const ageMin  = created ? (Date.now() - created.getTime()) / 60000 : Infinity;
    if (ageMin < 5) {
      // Auto-poll dashboard every 8s while we're in this state (pipeline takes ~60-90s)
      if (!state._firstRunPollTimer) {
        state._firstRunPollTimer = setInterval(async () => {
          try {
            const fresh = await apiFetch(`/api/dashboard/${state.token}`);
            if (fresh?.client?.last_run_at || (fresh?.matches?.length || 0) > 0) {
              clearInterval(state._firstRunPollTimer);
              state._firstRunPollTimer = null;
              state.client = fresh.client;
              state.matches = fresh.matches || [];
              renderGrid();
              updateStatBadges();
            }
          } catch { /* keep polling */ }
        }, 8000);
      }
      return `
        <div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;text-align:center;background:var(--surface-card);border:1.5px dashed var(--border-medium);border-radius:18px;margin-top:8px;">
          <div style="width:42px;height:42px;border:3px solid #e0e7ff;border-top-color:#6366f1;border-radius:50%;animation:spin 0.9s linear infinite;margin-bottom:18px;"></div>
          <div style="font-size:18px;font-weight:800;color:var(--text-primary);margin-bottom:8px;">Finding your first 50 podcast matches.</div>
          <p style="font-size:14px;color:var(--text-secondary);max-width:480px;line-height:1.6;margin-bottom:6px;">Searching Listen Notes, scoring fit, drafting personalised pitches. Usually ready in 60-90 seconds.</p>
          <p style="font-size:12px;color:var(--text-tertiary);">This page will refresh automatically.</p>
        </div>
      `;
    }
  }

  const messages = {
    new: {
      icon: '🎯',
      title: 'No new matches in your queue.',
      sub:   'Click Find a Podcast to discover 10 fresh shows in your niche (10 credits).',
      cta:   'Find a Podcast',
      action: 'runPipeline()',
    },
    sent: {
      icon: '📭',
      title: 'No pitches sent yet.',
      sub:   'Head to the New tab, pick a match, and hit Send. Your first booking is usually 7 sends away.',
      cta:   'Go to New',
      action: `setFilter('new')`,
    },
    followed_up: {
      icon: '⏳',
      title: 'Nothing followed up yet.',
      sub:   'The system auto-fires follow-ups at day 7 if a host hasn\'t replied. You\'ll see them here.',
      cta:   '',
      action: '',
    },
    replied: {
      icon: '📬',
      title: 'No replies yet.',
      sub:   'Most replies arrive 2-7 days after the pitch. The Check Replies button up top force-polls Gmail right now.',
      cta:   'Check Replies',
      action: 'checkRepliesNow(event)',
    },
    booked: {
      icon: '🎙',
      title: 'Nothing booked yet.',
      sub:   'Reply to a host quickly and lock in a recording — booking windows close inside 48 hours.',
      cta:   'See replies',
      action: `setFilter('replied')`,
    },
    appeared: {
      icon: '✨',
      title: 'No aired episodes yet.',
      sub:   'Mark a recording as Aired once it goes live to track your reach + unlock Content Boost.',
      cta:   'See bookings',
      action: `setFilter('booked')`,
    },
    dream: {
      icon: '⭐',
      title: 'Wish List is empty.',
      sub:   'Save shows you love but aren\'t ready to pitch yet. They wait here until the timing\'s right.',
      cta:   'Browse new',
      action: `setFilter('new')`,
    },
    dismissed: {
      icon: '🗑',
      title: 'No dismissed matches.',
      sub:   'Shows you mark as Not a Fit show up here. Useful for cleaning your pipeline.',
      cta:   '',
      action: '',
    },
  };
  const m = messages[tab] || messages.new;
  return `
    <div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;text-align:center;background:var(--surface-card);border:1.5px dashed var(--border-medium);border-radius:18px;margin-top:8px;">
      <div style="font-size:48px;margin-bottom:14px;line-height:1;">${m.icon}</div>
      <div style="font-size:18px;font-weight:800;color:var(--text-primary);margin-bottom:8px;">${esc(m.title)}</div>
      <p style="font-size:14px;color:var(--text-secondary);max-width:480px;line-height:1.6;margin-bottom:18px;">${esc(m.sub)}</p>
      ${m.cta ? `<button onclick="${m.action}" style="background:var(--accent);color:#fff;border:none;border-radius:999px;padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">${esc(m.cta)} <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg></button>` : ''}
    </div>
  `;
}

// ── Render full dashboard ─────────────────────────────────────────────
function renderDashboard(data) {
  const { client, matches, stats } = data;
  state.client            = client;
  state.matches           = matches || [];
  state.stats             = stats   || {};
  state.communityGroupUrl = data.community_group_url || null;
  state.demo              = data.demo || null;
  // Auto-open the unlock modal when the prospect lands here from a Stripe-cancelled
  // checkout, OR celebrate when they return successfully (handled in the
  // ?topup= block below — also catches ?unlocked=success).
  if (state.demo?.expired) {
    setTimeout(() => openUpgradeModal(), 600);
  }

  // Fetch live credit balance (fire-and-forget so render isn't blocked)
  loadCredits();

  // Show reply badge — only for replied matches not yet seen by user
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

  // Top alert banner — Gmail not connected (or token expired). Critical for
  // premium UX: customer can't send pitches or have replies detected without
  // Gmail. Banner stays until they reconnect.
  renderTopAlertBanner();

  // Navbar right: Find a Stage + Community (coming-soon) + credits counter + Settings
  // Credits counter populated by loadCredits() once balance is fetched.
  const navbarRight = $('navbar-right');
  if (navbarRight) {
    navbarRight.innerHTML = `
      <a id="find-a-stage-tab" href="/stages/${state.token}" title="Find speaking opportunities" style="display:inline-flex;align-items:center;gap:6px;background:linear-gradient(135deg,rgba(99,102,241,0.08),rgba(139,92,246,0.08));border:1.5px solid rgba(99,102,241,0.3);color:var(--text-primary);font-size:13px;font-weight:700;padding:6px 12px;border-radius:999px;cursor:pointer;line-height:1.3;text-decoration:none;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.4H22l-6.2 4.6 2.4 7.4L12 16.8 5.8 21.4l2.4-7.4L2 9.4h7.6z"/></svg>
        Find a Stage
        <span style="font-size:9px;font-weight:800;letter-spacing:0.05em;background:#f59e0b;color:#fff;padding:2px 6px;border-radius:999px;">BETA</span>
      </a>
      <button id="leaderboard-tab" disabled title="Community unlocks once we hit 50 members" style="display:inline-flex;align-items:center;gap:6px;background:none;border:1.5px solid var(--border-medium);color:var(--text-tertiary);font-size:13px;font-weight:700;padding:6px 12px;border-radius:999px;cursor:not-allowed;line-height:1.3;opacity:0.65;">
        Community
        <span style="font-size:9px;font-weight:800;letter-spacing:0.05em;background:#f59e0b;color:#fff;padding:2px 6px;border-radius:999px;">SOON</span>
      </button>
      <button id="credits-counter" onclick="openCreditsModal()" title="Your monthly credit balance" style="display:none;align-items:center;gap:6px;background:linear-gradient(135deg,rgba(99,102,241,0.1),rgba(139,92,246,0.1));border:1.5px solid rgba(99,102,241,0.3);color:var(--text-primary);font-size:13px;font-weight:700;padding:6px 14px;border-radius:999px;cursor:pointer;line-height:1.3;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        <span id="credits-counter-value">—</span>
        <span id="credits-counter-label" style="font-size:11px;font-weight:500;color:var(--text-tertiary);">credits</span>
      </button>
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
      const gmailLabel = client.gmail_email === 'connected' ? 'Gmail' : esc(client.gmail_email);
      gmailItem.style.cursor = 'default';
      gmailItem.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;width:100%;gap:8px;">
          <span style="color:var(--success);font-size:13px;display:flex;align-items:center;gap:5px;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            ${gmailLabel}
          </span>
          <button onclick="disconnectGmail()" style="font-size:11px;font-weight:600;color:#ef4444;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;padding:2px 8px;cursor:pointer;">Disconnect</button>
        </div>`;
    } else {
      gmailItem.style.cursor = 'pointer';
      gmailItem.innerHTML = `<a href="/auth/gmail?clientId=${esc(client.id)}" style="color:var(--accent);text-decoration:none;font-size:13px;display:flex;align-items:center;gap:5px;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/></svg>
        Connect Gmail
      </a>`;
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
  const highCount = state.matches.filter((m) => (m.fit_score || 0) >= 65).length;
  const avgScore  = state.matches.length > 0
    ? Math.round(state.matches.reduce((s, m) => s + (m.fit_score || 0), 0) / state.matches.length)
    : 0;
  renderStats({
    total:    state.matches.length,
    high:     highCount,
    avgScore,
    pitched:  state.matches.filter((m) => ['sent','followed_up','replied'].includes(m.status)).length,
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

  // Credit top-up success / cancellation feedback
  if (urlParams.get('topup') === 'success') {
    showToast('Top-up successful. Credits added to your account.', 'success');
    // Refresh credit balance now that the webhook has processed the top-up
    setTimeout(() => loadCredits(), 1500);
    window.history.replaceState({}, '', window.location.pathname);
  } else if (urlParams.get('topup') === 'cancelled') {
    showToast('Top-up cancelled. No charge made.', 'info');
    window.history.replaceState({}, '', window.location.pathname);
  }

  // Demo unlock success — coming back from Stripe after the $997 payment.
  // Stripe webhook may not have processed yet; poll the dashboard a few times
  // until demo_mode flips off, then refresh the page so all redacted matches
  // become real podcast names.
  if (urlParams.get('unlocked') === 'success') {
    showToast('Welcome to Find A Podcast — unlocking your pipeline now…', 'success');
    window.history.replaceState({}, '', window.location.pathname);
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        const fresh = await apiFetch(`/api/dashboard/${state.token}`);
        if (fresh && fresh.demo === null) {
          clearInterval(poll);
          showToast('Pipeline unlocked. Welcome aboard.', 'success');
          // Force a hard reload so every cached match re-renders unredacted.
          setTimeout(() => window.location.reload(), 800);
        }
      } catch { /* keep polling */ }
      if (attempts >= 12) clearInterval(poll); // ~36 sec ceiling
    }, 3000);
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
    // Re-enrich any matches with missing/neutral scores silently in the background
    backgroundReEnrichAll();
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
  // Preserve expanded state so background re-enrich doesn't collapse an open card
  const wasExpanded = card.getAttribute('data-expanded') === 'true';
  const tmp = document.createElement('div');
  tmp.innerHTML = renderMatchCard(match);
  const newCard = tmp.firstElementChild;
  if (wasExpanded && newCard) newCard.setAttribute('data-expanded', 'true');
  card.replaceWith(newCard);
}

// ── Switch active filter tab programmatically ─────────────────────────
function switchToFilter(status) {
  // Hide leaderboard view when switching to a match filter
  if ($('leaderboard-view')) $('leaderboard-view').style.display = 'none';
  if ($('cards-grid'))       $('cards-grid').style.display = '';
  document.getElementById('leaderboard-tab')?.classList.remove('active');
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
    high:     m.filter((x) => (x.fit_score || 0) >= 65).length,
    avgScore: m.length > 0
      ? Math.round(m.reduce((s, x) => s + (x.fit_score || 0), 0) / m.length)
      : 0,
    pitched:  m.filter((x) => ['sent','followed_up','replied'].includes(x.status)).length,
    booked:   m.filter((x) => x.status === 'booked').length,
  });

  // Refresh hero subtitle, onboarding checklist, content boost tab
  renderHeroSection();
  renderOnboardingChecklist();
  updateContentBoostTab();

  // Update tab count badges
  const tabCounts = {};
  m.forEach((x) => { tabCounts[x.status] = (tabCounts[x.status] || 0) + 1; });
  const seenKey2 = `seen_replied_${state.token}`;
  const seenIds2 = new Set(JSON.parse(localStorage.getItem(seenKey2) || '[]'));
  const unseenRepliedCount = m.filter(x => x.status === 'replied' && !seenIds2.has(x.id)).length;
  const tabs = $('filter-tabs');
  if (tabs) {
    tabs.querySelectorAll('.filter-tab').forEach((t) => {
      const st = t.dataset.status;
      // Remove old count badge + any pulsing dot
      t.querySelectorAll('.tab-count, .tab-pulse-dot').forEach((el) => el.remove());
      const cnt = tabCounts[st] || 0;
      if (cnt > 0) {
        const badge = document.createElement('span');
        badge.className = 'tab-count';
        // Host Replied tab: use red/orange badge when there are unseen replies
        if (st === 'replied' && unseenRepliedCount > 0) {
          badge.style.cssText = 'background:#ef4444;color:#fff;font-weight:800;';
          // Add a pulsing red dot to scream urgency
          const dot = document.createElement('span');
          dot.className = 'tab-pulse-dot';
          dot.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:50%;background:#ef4444;margin-left:6px;animation:tab-pulse 1.4s infinite;';
          if (!document.getElementById('tab-pulse-style')) {
            const style = document.createElement('style');
            style.id = 'tab-pulse-style';
            style.textContent = '@keyframes tab-pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:0.4; transform:scale(1.4); } }';
            document.head.appendChild(style);
          }
          t.appendChild(dot);
        }
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
      updateMatchInState(matchId, { approved_at: data.match?.approved_at });
      updateCard(matchId);
      updateStatBadges();
      showToast('Pitch ready. Writing your personalised email now...', 'success');
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
      showToast('Moved to Not a Fit. You can always restore it later.', 'info');
    } else {
      showToast(data.error || 'Could not dismiss.', 'error');
    }
  } catch { showToast('Network error. Please try again.', 'error'); }
  finally  { setCardLoading(matchId, false); }
}

function confirmDismiss(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  const name  = match?.podcasts?.title || 'this show';
  if (window.confirm(`Skip "${name}"? You can always restore it from the Not a Fit tab.`)) {
    dismissMatch(matchId);
  }
}

async function markAsPitched(matchId) {
  setCardLoading(matchId, true);
  try {
    const data = await apiPost('/api/update-status', { matchId, status: 'sent' });
    if (data.success) {
      updateMatchInState(matchId, { status: 'sent', sent_at: data.match?.sent_at || new Date().toISOString() });
      renderGrid();
      updateStatBadges();
      showToast('Marked as sent. We\'ll watch for a reply automatically.', 'success');
    } else {
      showToast(data.error || 'Could not update status.', 'error');
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
      showToast('Moved back to New. Ready to pitch when you are.', 'success');
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
      showToast('Saved to your Wish List. Pitch it when the time is right.', 'success');
    } else {
      showToast(data.error || 'Failed.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
  finally { setCardLoading(matchId, false); }
}
window.dreamMatch = dreamMatch;

async function doSendMatch(matchId) {
  // Auto-save whatever is in the inline pitch editor before sending
  const inlineBodyEl    = $(`inline-body-${matchId}`);
  const inlineSubjectEl = $(`inline-subject-${matchId}`);
  if (inlineBodyEl?.value.trim()) {
    try {
      await apiPost('/api/email/edit', {
        matchId,
        subject: inlineSubjectEl?.value.trim() || '',
        body:    inlineBodyEl.value.trim(),
      });
      updateMatchInState(matchId, { email_subject_edited: inlineSubjectEl?.value.trim() || '', email_body_edited: inlineBodyEl.value.trim() });
    } catch { /* non-fatal — proceed to send anyway */ }
  }
  // Guard: don't send if there's no email content — would send a blank email
  const currentMatch = state.matches.find((m) => m.id === matchId);
  const hasContent = !!(currentMatch?.email_body || currentMatch?.email_body_edited || bodyEl?.value.trim());
  if (!hasContent) {
    showToast('Pitch email not ready yet. Write your pitch first or wait a moment and try again.', 'error');
    return;
  }

  setCardLoading(matchId, true);
  try {
    const data = await apiPost('/api/send', { matchId });
    if (data.success) {
      updateMatchInState(matchId, { status: 'sent', sent_at: data.match?.sent_at });
      updateStatBadges();
      showToast('Pitch sent. We\'ll notify you the moment the host replies.', 'success');
      switchToFilter('sent');
    } else {
      showToast(data.error || 'Send failed. Check your Gmail is connected and try again.', 'error');
    }
  } catch { showToast('Network error. Please try again.', 'error'); }
  finally  { setCardLoading(matchId, false); }
}

async function sendMatch(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;

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
  if (!confirmBtn) { doSendMatch(matchId); return; }
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

// bookMatch now opens a modal so the customer can capture the show/episode title,
// recording date/time, and notes — all of which feed the dashboard timeline AND
// the booking congrats email. The actual /api/book POST happens inside submitBooking().
let _activeBookMatchId = null;
function bookMatch(matchId) {
  if (state.demo?.active) { openUpgradeModal(); return; }
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;
  _activeBookMatchId = matchId;
  const modal = document.getElementById('book-modal');
  if (!modal) {
    // Fallback if modal HTML missing — book directly
    return submitBookingDirect(matchId, {});
  }
  // Pre-fill show name with podcast title
  const nameEl  = document.getElementById('book-show-name');
  const dateEl  = document.getElementById('book-recording-date');
  const timeEl  = document.getElementById('book-recording-time');
  const notesEl = document.getElementById('book-notes');
  if (nameEl)  nameEl.value  = match.podcasts?.title || '';
  if (dateEl)  dateEl.value  = '';
  if (timeEl)  timeEl.value  = '';
  if (notesEl) notesEl.value = '';
  modal.style.display = 'flex';
  setTimeout(() => nameEl?.focus(), 50);
}
function closeBookModal() {
  _activeBookMatchId = null;
  const modal = document.getElementById('book-modal');
  if (modal) modal.style.display = 'none';
}
async function submitBooking() {
  const matchId = _activeBookMatchId;
  if (!matchId) return closeBookModal();
  const showName = (document.getElementById('book-show-name')?.value || '').trim();
  const date     = (document.getElementById('book-recording-date')?.value || '').trim();
  const time     = (document.getElementById('book-recording-time')?.value || '').trim();
  const notes    = (document.getElementById('book-notes')?.value || '').trim();
  // Combine date + time into ISO if both are set; date alone is fine too.
  let recordingAt = null;
  if (date) recordingAt = time ? `${date}T${time}:00` : `${date}T00:00:00`;
  closeBookModal();
  await submitBookingDirect(matchId, { showName, recordingAt, notes });
}
async function submitBookingDirect(matchId, payload) {
  setCardLoading(matchId, true);
  try {
    const data = await apiPost('/api/book', { matchId, ...payload });
    if (data.success) {
      updateMatchInState(matchId, { status: 'booked', booked_at: data.match?.booked_at, booked_show_name: payload.showName || null, client_notes: data.match?.client_notes });
      switchToFilter('booked');
      updateStatBadges();
      showBookingCelebration(matchId);
    } else {
      showToast(data.error || 'Could not mark as booked.', 'error');
    }
  } catch { showToast('Network error. Please try again.', 'error'); }
  finally  { setCardLoading(matchId, false); }
}
window.closeBookModal = closeBookModal;
window.submitBooking  = submitBooking;

function confirmUnbook(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  const name  = match?.podcasts?.title || 'this show';
  if (window.confirm(`Did the booking for "${name}" fall through? This will move it back to Pitched.`)) {
    unbookMatch(matchId);
  }
}

async function unbookMatch(matchId) {
  setCardLoading(matchId, true);
  try {
    const data = await apiPost('/api/unbook', { matchId });
    if (data.success) {
      updateMatchInState(matchId, { status: 'sent', booked_at: null });
      updateCard(matchId);
      updateStatBadges();
      showToast('Moved back to Pitched. Keep going, the next one is closer than you think.', 'info');
    } else {
      showToast(data.error || 'Could not update.', 'error');
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
      updateStatBadges();
      showToast('Moved to Host Replied.', 'success');
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
    // Auto-generate if no real pitch exists yet (ignore placeholder fallback text)
    const hasRealPitch = match?.email_body && !match.email_body.includes('[Write your pitch here');
    if (bodyEl && !hasRealPitch) {
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
  bodyEl.placeholder = 'Writing your pitch…';
  bodyEl.disabled    = true;
  if (rewriteBtn) { rewriteBtn.disabled = true; rewriteBtn.textContent = 'Writing…'; }

  try {
    const data = await apiPost('/api/generate-pitch', { matchId });
    if (data.success) {
      // Set subject — if it doesn't match a preset option, switch to custom
      if (subjectEl && data.subject) {
        const matchingOption = [...subjectEl.options].find(o => o.value === data.subject);
        if (matchingOption) {
          subjectEl.value = data.subject;
        } else {
          subjectEl.value = '__custom__';
          const customEl = $(`pitch-subject-custom-${matchId}`);
          if (customEl) { customEl.value = data.subject; customEl.style.display = 'block'; }
        }
      }
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
    if (rewriteBtn) { rewriteBtn.disabled = false; rewriteBtn.textContent = 'Rewrite Pitch'; }
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
          contentEl.innerHTML = `<p style="color:var(--danger);font-size:14px;">Could not generate prep. ${esc(data.error || 'Please try again')}.</p>`;
        }
      }).catch(() => {
        if (contentEl) contentEl.innerHTML = '<p style="color:var(--danger);font-size:14px;">Network error. Please close and try again.</p>';
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

// ── Inline pitch panel ────────────────────────────────────────────────

function expandCard(matchId) {
  const card = $(`card-${matchId}`);
  if (card && card.getAttribute('data-expanded') !== 'true') {
    card.setAttribute('data-expanded', 'true');
  }
}

function toggleInlinePitch(matchId) {
  const panel = $(`pitch-panel-${matchId}`);
  if (!panel) return;
  const isOpen = panel.style.display === 'block';
  if (isOpen) { panel.style.display = 'none'; return; }
  expandCard(matchId);
  document.querySelectorAll('.inline-pitch-panel, .social-dm-panel').forEach(p => { if (p !== panel) p.style.display = 'none'; });
  panel.style.display = 'block';
  populateInlinePitch(matchId);
}
window.toggleInlinePitch = toggleInlinePitch;

// ── Pitch preset templates ─────────────────────────────────────────────
// Two flavours:
//   1. Subject-only: Just swaps the subject line, keeps the AI-drafted body.
//      Good for tweaking the framing of the AI pitch.
//   2. Full template: Swaps subject AND body. Short, human-sounding alternatives
//      to the AI pitch — for hosts who prefer quick + casual.
//
// RULES applied to ALL presets:
//   - No em dashes, no exclamation marks, no bullet points
//   - No "Guest inquiry" / "Guest pitch" / "Guest application" phrasing
//   - Under 80 words body, under 6 words subject
//   - Peer-level tone, not salesy
//   - No P.S., no sign-off (added by system)
//   - No emoji, no canned generic closers
function sanitizePitchFields(subject, body) {
  // Detect if body is a raw JSON string (AI response wasn't parsed before saving)
  if (body && body.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(body);
      if (parsed.body) {
        return { subject: parsed.subject || subject, body: parsed.body };
      }
    } catch {}
  }
  return { subject, body };
}

function populateInlinePitch(matchId) {
  const match = state.matches.find(m => m.id === matchId);
  if (!match) return;
  let currentSubject = match.email_subject_edited || match.email_subject || '';
  let currentBody    = match.email_body_edited    || match.email_body    || '';
  // Auto-heal corrupted JSON bodies before displaying
  ({ subject: currentSubject, body: currentBody } = sanitizePitchFields(currentSubject, currentBody));
  const isFallback = !currentBody || currentBody.includes('[Write your pitch here') || currentBody.includes("I'd love to be a guest");
  const subjEl   = $(`inline-subject-${matchId}`);
  const bodyEl   = $(`inline-body-${matchId}`);
  const presetEl = $(`inline-preset-${matchId}`);
  if (subjEl) subjEl.value = isFallback ? '' : currentSubject;
  if (bodyEl)  bodyEl.value  = isFallback ? '' : currentBody;
  // Populate subject presets — podcast-specific options
  if (presetEl) {
    presetEl.innerHTML =
      '<option value="tmpl:my">My Template</option>' +
      '<option value="tmpl:soft">Soft Option</option>' +
      '<option value="tmpl:blank">Write it Yourself</option>';
    presetEl.style.display = 'block';
    presetEl.onchange = () => {
      if (!presetEl.value || !subjEl) return;
      const option = presetEl.value.split(':')[1];
      applyInlineTemplateOption(matchId, option);
      presetEl.value = '';
    };
  }
  updatePitchPreview(matchId);
  // Auto-generate if no real pitch exists
  const isAppeared = match.status === 'appeared';
  if (isFallback && !isAppeared) {
    setTimeout(() => rewriteInlinePitch(matchId), 100);
  }
}

// ── Apply a template option from the inline dropdown ──────────────
function applyInlineTemplateOption(matchId, option) {
  const match = state.matches.find(m => m.id === matchId);
  if (!match) return;
  const subjEl = $('inline-subject-' + matchId);
  const bodyEl = $('inline-body-' + matchId);
  if (!subjEl || !bodyEl) return;
  const podcast = match.podcasts || match;
  if (option === 'my') {
    const saved = (state.client?.email_templates || []).filter(t => t.subject || t.body);
    if (saved.length > 0) {
      subjEl.value = saved[0].subject || '';
      bodyEl.value = saved[0].body || '';
      showToast('Loaded "' + saved[0].name + '".', 'success');
    } else if (state.client?.pitch_style) {
      bodyEl.value = state.client.pitch_style;
      subjEl.value = '';
      showToast('Loaded your pitch style.', 'info');
    } else {
      showToast('No saved template. Save one in Manage Templates.', 'info');
    }
  } else if (option === 'soft') {
    const hostSubject = match.email_subject_edited || match.email_subject || '';
    const hostBody = match.email_body_edited || match.email_body || '';
    if (hostBody && !hostBody.includes('[Write your pitch here') && !hostBody.includes("I'd love to be a guest")) {
      subjEl.value = hostSubject;
      bodyEl.value = hostBody;
      showToast('Loaded the AI generated pitch for this host.', 'success');
    } else {
      const hostName = (podcast?.host_name || '').split(' ')[0] || 'there';
      const showTitle = podcast?.title || 'your show';
      const fromName = (state.client?.name || '').split(' ')[0] || '';
      subjEl.value = 'Are you booking guests on ' + showTitle + ' right now?';
      bodyEl.value = 'Hi ' + hostName + ',\n\nQuick question: what kind of guests are you booking on ' + showTitle + ' this season? I would rather ask than guess whether my angle fits.\n\nIf you are open to it, I will send a short summary of what I would bring to your audience.' + (fromName ? '\n\n' + fromName : '');
      showToast('No pitch found. Loaded a soft fit check template.', 'success');
    }
  } else if (option === 'blank') {
    subjEl.value = '';
    bodyEl.value = '';
  }
  updatePitchPreview(matchId);
}


function updatePitchPreview(matchId) {
  const subjEl    = $(`inline-subject-${matchId}`);
  const bodyEl    = $(`inline-body-${matchId}`);
  const previewEl = $(`pitch-preview-${matchId}`);
  const wcEl      = $(`inline-wc-${matchId}`);

  const subject = subjEl?.value.trim() || '';
  const body    = bodyEl?.value.trim() || '';

  // Word count
  if (wcEl && body) {
    const wc = body.split(/\s+/).filter(Boolean).length;
    const wcColor = wc < 80 ? 'var(--warning)' : wc > 130 ? 'var(--danger)' : 'var(--success)';
    wcEl.innerHTML = `<span style="color:${wcColor};font-size:11px;font-weight:600;">${wc} words</span><span style="color:var(--text-tertiary);font-size:11px;"> / 90–120 target</span>`;
  } else if (wcEl) {
    wcEl.innerHTML = '';
  }

  if (!previewEl) return;
  if (!subject && !body) { previewEl.style.display = 'none'; return; }
  const firstPara = body.split('\n\n')[0] || '';
  previewEl.style.display = 'block';
  previewEl.innerHTML = `<div class="preview-label">Preview</div>
    <div class="preview-subject">${esc(subject) || '<em style="color:var(--text-tertiary)">No subject yet</em>'}</div>
    ${firstPara ? `<div class="preview-firstline">${esc(firstPara)}</div>` : ''}`;
}
window.updatePitchPreview = updatePitchPreview;

async function rewriteInlinePitch(matchId) {
  const btn    = $(`inline-rewrite-${matchId}`);
  const bodyEl = $(`inline-body-${matchId}`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Writing your pitch...';
    btn.style.cssText += ';background:#6366f1;color:#fff;border-color:#6366f1;opacity:1;animation:pulse 1.4s ease-in-out infinite;';
  }
  if (bodyEl) {
    bodyEl.disabled = true;
    bodyEl.value = '';
    bodyEl.placeholder = 'Writing your pitch…';
    bodyEl.style.opacity = '0.4';
    // Inject a loading overlay sibling
    const existingOverlay = document.getElementById(`pitch-loading-${matchId}`);
    if (!existingOverlay) {
      const overlay = document.createElement('div');
      overlay.id = `pitch-loading-${matchId}`;
      overlay.style.cssText = 'position:absolute;inset:0;background:rgba(255,255,255,0.7);border-radius:inherit;pointer-events:none;display:flex;align-items:center;justify-content:center;';
      overlay.innerHTML = '<span style="font-size:13px;font-weight:500;color:var(--text-secondary);">Writing your pitch...</span>';
      const parent = bodyEl.parentElement;
      if (parent) {
        parent.style.position = 'relative';
        parent.appendChild(overlay);
      }
    }
  }
  try {
    const data = await apiPost('/api/generate-pitch', { matchId });
    if (data.subject && data.body) {
      const subjEl = $(`inline-subject-${matchId}`);
      const bodyEl = $(`inline-body-${matchId}`);
      if (subjEl) subjEl.value = data.subject;
      if (bodyEl)  bodyEl.value  = data.body;
      updateMatchInState(matchId, { email_subject_edited: data.subject, email_body_edited: data.body });
      updatePitchPreview(matchId);
      showToast('Pitch ready.', 'success');
    } else {
      showToast(data.error || 'Could not generate pitch.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
  finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Rewrite Pitch';
      btn.style.background = '';
      btn.style.color = '';
      btn.style.borderColor = '';
      btn.style.animation = '';
      btn.style.opacity = '';
    }
    const bodyElFinal = $(`inline-body-${matchId}`);
    if (bodyElFinal) {
      bodyElFinal.disabled = false;
      bodyElFinal.style.opacity = '';
      bodyElFinal.placeholder = 'Your pitch will appear here…';
    }
    const overlay = document.getElementById(`pitch-loading-${matchId}`);
    if (overlay) overlay.remove();
  }
}
window.rewriteInlinePitch = rewriteInlinePitch;

async function saveInlineEdits(matchId) {
  const subject = $(`inline-subject-${matchId}`)?.value || '';
  const body    = $(`inline-body-${matchId}`)?.value    || '';
  if (!subject && !body) return;
  await apiPost('/api/email/edit', { matchId, subject, body });
  updateMatchInState(matchId, { email_subject_edited: subject, email_body_edited: body });
}

async function sendFromInline(matchId) {
  if (state.demo?.active) { openUpgradeModal(); return; }
  await saveInlineEdits(matchId);
  toggleInlinePitch(matchId);
  sendMatch(matchId);
}
window.sendFromInline = sendFromInline;

async function markAsPitchedFromInline(matchId) {
  await saveInlineEdits(matchId);
  toggleInlinePitch(matchId);
  markAsPitched(matchId);
}
window.markAsPitchedFromInline = markAsPitchedFromInline;

// ── Mark as Followed Up Manually (I Sent It Myself on Pitched tab) ────
async function markAsFollowedUpManually(matchId) {
  setCardLoading(matchId, true);
  try {
    const data = await apiPost('/api/update-status', { matchId, status: 'followed_up' });
    if (data.success) {
      updateMatchInState(matchId, { status: 'followed_up' });
      renderGrid();
      updateStatBadges();
      showToast('Marked as Followed Up.', 'success');
    }
  } catch (err) {
    showToast('Could not update status.', 'error');
  } finally {
    setCardLoading(matchId, false);
  }
}
window.markAsFollowedUpManually = markAsFollowedUpManually;

// ── Inline thank you panel ────────────────────────────────────────

function toggleThankYouPanel(matchId) {
  const panel = $(`thankyou-panel-${matchId}`);
  if (!panel) return;
  const isOpen = panel.style.display === 'block';
  if (isOpen) { panel.style.display = 'none'; return; }
  document.querySelectorAll('.inline-pitch-panel').forEach(p => { if (p !== panel) p.style.display = 'none'; });
  panel.style.display = 'block';
  populateThankYouPanel(matchId);
}
window.toggleThankYouPanel = toggleThankYouPanel;

function populateThankYouPanel(matchId) {
  const match = state.matches.find(m => m.id === matchId);
  if (!match) return;
  const subjEl = $(`thankyou-subj-${matchId}`);
  const bodyEl = $(`thankyou-body-${matchId}`);
  // Auto-generate if blank
  if (!subjEl?.value && !bodyEl?.value) {
    setTimeout(() => generateThankYou(matchId), 100);
  }
}

async function generateThankYou(matchId) {
  const btn    = $(`thankyou-generate-btn-${matchId}`);
  const subjEl = $(`thankyou-subj-${matchId}`);
  const bodyEl = $(`thankyou-body-${matchId}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Writing...'; }
  if (bodyEl) { bodyEl.disabled = true; bodyEl.placeholder = 'Writing your thank you...'; }
  try {
    const data = await apiPost('/api/generate-thankyou', { matchId });
    if (data.success && data.body) {
      if (subjEl) subjEl.value = data.subject || '';
      if (bodyEl) bodyEl.value = data.body;
      showToast('Thank you drafted.', 'success');
    } else {
      showToast(data.error || 'Could not generate thank you.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate'; }
    if (bodyEl) { bodyEl.disabled = false; bodyEl.placeholder = 'Your thank you message…'; }
  }
}
window.generateThankYou = generateThankYou;

async function sendThankYouFromPanel(matchId) {
  const subjEl = $(`thankyou-subj-${matchId}`);
  const bodyEl = $(`thankyou-body-${matchId}`);
  const subject = subjEl?.value?.trim() || '';
  const body    = bodyEl?.value?.trim() || '';
  if (!subject || !body) { showToast('Add a subject and message first.', 'error'); return; }
  const btn = document.querySelector(`#thankyou-panel-${matchId} .btn-action-send`);
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const data = await apiPost('/api/send-thankyou', { matchId, subject, body });
    if (data.success) {
      showToast('Thank you sent.', 'success');
      toggleThankYouPanel(matchId);
    } else {
      showToast(data.error || 'Could not send.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Send'; } }
}
window.sendThankYouFromPanel = sendThankYouFromPanel;

// ── Social DM panel ──────────────────────────────────────────────

function showNoEmailWarning(matchId) {
  const match = state.matches.find(m => m.id === matchId);
  const hasSocial = match && (
    isValidSocialProfile(match.podcasts?.instagram_url, 'instagram') ||
    isValidSocialProfile(match.podcasts?.twitter_url, 'twitter') ||
    isValidSocialProfile(match.podcasts?.linkedin_page_url || match.podcasts?.linkedin_url, 'linkedin') ||
    isValidSocialProfile(match.podcasts?.facebook_url, 'facebook')
  );
  const existing = $('no-email-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'no-email-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9000;display:flex;align-items:center;justify-content:center;';

  const title = 'No email found';
  const body = `No contact email found for this one. ${hasSocial ? 'Try the <strong>DM Template</strong> below to reach out on social instead.' : 'You may need to find their contact info directly on their website.'}`;
  const primaryBtn = hasSocial
    ? `<button class="btn btn-xs" style="background:#fff7ed;color:#c2410c;border:1.5px solid #fed7aa;font-weight:600;" onclick="document.getElementById('no-email-modal').remove();toggleSocialDM('${matchId}')">Open DM Template</button>`
    : '';

  modal.innerHTML = `
    <div style="background:var(--bg-card);border-radius:16px;padding:28px 28px 24px;max-width:380px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.25);">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <div style="width:36px;height:36px;border-radius:8px;background:#fef3c7;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <h3 style="margin:0;font-size:16px;font-weight:700;color:var(--text-primary);">${title}</h3>
      </div>
      <p style="margin:0 0 16px;font-size:14px;color:var(--text-secondary);line-height:1.6;">${body}</p>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('no-email-modal').remove()">Close</button>
        ${primaryBtn}
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}
window.showNoEmailWarning = showNoEmailWarning;

function toggleSocialDM(matchId) {
  const panel = $(`dm-panel-${matchId}`);
  if (!panel) return;
  const isOpen = panel.style.display === 'block';
  if (isOpen) { panel.style.display = 'none'; return; }
  expandCard(matchId);
  document.querySelectorAll('.inline-pitch-panel, .social-dm-panel').forEach(p => { if (p !== panel) p.style.display = 'none'; });
  panel.style.display = 'block';
  // Auto-generate AI DM on first open (textarea still has the static placeholder)
  populateDMPanel(matchId);
}
window.toggleSocialDM = toggleSocialDM;

async function populateDMPanel(matchId) {
  const textarea = $(`dm-script-${matchId}`);
  if (!textarea) return;
  // Only auto-generate if it still contains the static fallback text (not already AI-generated)
  if (textarea.dataset.aiGenerated === '1') return;
  const btn = $(`dm-regen-btn-${matchId}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Writing…'; }
  textarea.style.opacity = '0.5';
  try {
    const data = await apiPost('/api/generate-dm', { matchId });
    if (data.body) {
      textarea.value = data.body;
      textarea.dataset.aiGenerated = '1';
    }
  } catch { /* keep static fallback already in textarea */ }
  finally {
    textarea.style.opacity = '';
    if (btn) { btn.disabled = false; btn.textContent = 'Regenerate'; }
  }
}

function buildDMScriptFromMatch(match) {
  const podcast   = match.podcasts || {};
  const fullName  = state.client?.name || '';
  const firstName = fullName.split(' ')[0] || 'I';

  // Shorten show name — take only what's before the first pipe, colon, or em dash
  const fullTitle = podcast.title || 'your show';
  const shortName = fullTitle.split(/[|:—–]/, 1)[0].trim() || fullTitle;

  const angle = match.best_pitch_angle || '';

  // Detect internal coaching notes that should NEVER appear in outreach
  const isInternalNote = /skip this|not a fit|focus your outreach|pass on this|avoid this|outreach budget|different demographic|cross-promotional/i.test(angle);

  // Convert 3rd-person client references to 1st person
  function toFirstPerson(text) {
    if (!firstName || firstName === 'I') return text;
    const fn = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text
      .replace(new RegExp(`\\b${fn}\\s+shows\\b`, 'gi'),   'I show')
      .replace(new RegExp(`\\b${fn}\\s+teaches\\b`, 'gi'), 'I teach')
      .replace(new RegExp(`\\b${fn}\\s+helps\\b`, 'gi'),   'I help')
      .replace(new RegExp(`\\b${fn}\\s+has\\b`, 'gi'),     'I have')
      .replace(new RegExp(`\\b${fn}\\s+is\\b`, 'gi'),      'I am')
      .replace(new RegExp(`\\b${fn}\\s+can\\b`, 'gi'),     'I can')
      .replace(new RegExp(`\\b${fn}\\s+works\\b`, 'gi'),   'I work')
      .replace(new RegExp(`\\b${fn}\\s+runs\\b`, 'gi'),    'I run')
      .replace(new RegExp(`\\b${fn}\\s+built\\b`, 'gi'),   'I built')
      .replace(new RegExp(`\\b${fn}\\s+spent\\b`, 'gi'),   'I spent')
      .replace(new RegExp(`\\b${fn}\\b`, 'g'),              'I');
  }

  let body;
  if (angle && !isInternalNote) {
    // Strip leading directive phrases so the angle reads naturally
    const raw = angle
      .replace(/^(Lead with\s+a?\s*|Position yourself[^—]*?—\s*|Start with\s+|Use\s+)/i, '')
      .replace(/\.$/, '')
      .slice(0, 160);
    const clean = toFirstPerson(raw);
    body = `I think there could be a strong episode angle here: ${clean.charAt(0).toLowerCase() + clean.slice(1)}.`;
  } else {
    body = `Your show's audience looks like exactly the kind of people I work with, and I think I could bring real value to your listeners.`;
  }

  // Build plain-text signature from client social links
  const c = state.client || {};
  const sigLines = [];
  if (c.website)          sigLines.push(c.website);
  if (c.social_instagram) sigLines.push(c.social_instagram);
  if (c.social_linkedin)  sigLines.push(c.social_linkedin);
  if (c.social_twitter)   sigLines.push(c.social_twitter);
  if (c.social_facebook)  sigLines.push(c.social_facebook);
  if (c.booking_link)     sigLines.push(c.booking_link);
  const sig = sigLines.length ? '\n' + sigLines.join('\n') : '';

  return `Hi ${shortName},\n\n${body}\n\nWould you be open to a quick conversation to see if there's a fit? Even 15 minutes works.\n\n${firstName}${sig}`;
}

function buildDMScript(matchId) {
  const match = state.matches.find(m => m.id === matchId);
  if (!match) return '';
  return buildDMScriptFromMatch(match);
}

function copyDMScript(matchId) {
  const textarea = $(`dm-script-${matchId}`);
  const script = textarea ? textarea.value : buildDMScript(matchId);
  navigator.clipboard.writeText(script)
    .then(() => showToast('DM copied to clipboard.', 'success'))
    .catch(() => showToast('Could not copy. Please copy manually.', 'error'));
}
window.copyDMScript = copyDMScript;

async function regenerateDMScript(matchId) {
  const btn = $(`dm-regen-btn-${matchId}`);
  const textarea = $(`dm-script-${matchId}`);
  if (!textarea) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
  try {
    const data = await apiPost('/api/generate-dm', { matchId });
    if (data.body) {
      textarea.value = data.body;
      textarea.dataset.aiGenerated = '1';
      showToast('DM generated.', 'success');
    } else {
      throw new Error(data.error || 'No body returned');
    }
  } catch {
    // Fall back to client-side builder
    const match = state.matches.find(m => m.id === matchId);
    if (match) textarea.value = buildDMScriptFromMatch(match);
    showToast('Used local template. AI unavailable.', 'info');
  }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Regenerate'; } }
}
window.regenerateDMScript = regenerateDMScript;
window.buildDMScriptFromMatch = buildDMScriptFromMatch;

// ── Email modal ───────────────────────────────────────────────────────
function openEmailModal(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;
  const podcast = match.podcasts || {};
  state.modalMatchId = matchId;

  const isAppeared = match.status === 'appeared';
  const titleEl = $('email-modal-title');
  if (titleEl) titleEl.textContent = isAppeared ? `Thank You: ${podcast.title || 'Unknown Show'}` : `Pitch Email: ${podcast.title || 'Unknown Show'}`;

  const subjectEl = $('modal-subject');
  const bodyEl    = $('modal-body-text');
  const tmplSel   = $('template-selector');

  // Three-option template selector: My Template / Soft Option / Write it Yourself
  function applyTemplateOption(option) {
    if (!subjectEl || !bodyEl) return;
    if (option === 'my') {
      // Use the user's first saved template from Template Manager
      const saved = (state.client?.email_templates || []).filter(t => t.subject || t.body);
      if (saved.length > 0) {
        subjectEl.value = saved[0].subject || '';
        bodyEl.value    = saved[0].body    || '';
        showToast(`Loaded "${saved[0].name}".`, 'success');
      } else if (state.client?.pitch_style) {
        // Fallback to pitch_style field from profile
        bodyEl.value    = state.client.pitch_style;
        subjectEl.value = '';
        showToast('Loaded your pitch style. Edit subject as needed.', 'info');
      } else {
        showToast('No saved template found. Save one in Manage Templates.', 'info');
      }
    } else if (option === 'soft') {
      // Use the match's existing AI-generated pitch (the host's template), softened
      const hostSubject = match.email_subject_edited || match.email_subject || '';
      const hostBody    = match.email_body_edited    || match.email_body    || '';
      if (hostBody && !hostBody.includes('[Write your pitch here') && !hostBody.includes("I'd love to be a guest")) {
        subjectEl.value = hostSubject;
        bodyEl.value    = hostBody;
        showToast('Loaded the AI-generated pitch for this host.', 'success');
      } else {
        // No existing pitch — use the soft fit-check preset
        const hostName = (podcast?.host_name || '').split(' ')[0] || 'there';
        const showTitle = podcast?.title || 'your show';
        const fromName = (state.client?.name || '').split(' ')[0] || '';
        subjectEl.value = `Are you booking guests on ${showTitle} right now?`;
        bodyEl.value    = `Hi ${hostName},\n\nQuick question: what kind of guests are you booking on ${showTitle} this season? I would rather ask than guess whether my angle fits.\n\nIf you are open to it, I will send a short summary of what I would bring to your audience.${fromName ? '\n\n' + fromName : ''}`;
        showToast('No pitch found — loaded a soft fit-check template.', 'success');
      }
    } else if (option === 'blank') {
      // Blank slate — user writes from scratch
      subjectEl.value = '';
      bodyEl.value    = '';
    }
    // Highlight the active button
    if (tmplSel) {
      tmplSel.querySelectorAll('.tmpl-btn').forEach(b => {
        b.style.borderColor = 'var(--border-light)';
        b.style.background  = 'var(--bg-secondary)';
        b.style.color       = 'var(--text-secondary)';
      });
      const active = tmplSel.querySelector(`.tmpl-btn[data-tmpl="${option}"]`);
      if (active) {
        active.style.borderColor = '#6366f1';
        active.style.background  = 'rgba(99,102,241,0.08)';
        active.style.color       = '#6366f1';
      }
    }
  }

  // Wire up template selector clicks (one-time delegation via the container)
  if (tmplSel && !tmplSel._wired) {
    tmplSel._wired = true;
    tmplSel.addEventListener('click', (e) => {
      const btn = e.target.closest('.tmpl-btn');
      if (btn) applyTemplateOption(btn.dataset.tmpl);
    });
  }

  const currentBody    = match.email_body_edited    || match.email_body    || '';
  const currentSubject = match.email_subject_edited || match.email_subject || '';
  const isFallback = !currentBody || currentBody.includes('[Write your pitch here') || currentBody.includes("I'd love to be a guest");

  if (subjectEl) subjectEl.value = currentSubject;
  if (bodyEl)    bodyEl.value    = isFallback ? '' : currentBody;
  if (bodyEl && isFallback) {
    bodyEl.placeholder = isAppeared
      ? 'Write a short thank you to the host. Mention something specific from the episode and leave the door open for a future connection.'
      : 'Writing your personalised pitch…';
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

  // Match insights — Why You Fit, Best Pitch Angle, Reference Episode
  const insightsEl = $('email-match-insights');
  if (insightsEl) {
    const rows = [];
    const insightLabel = 'font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:var(--text-primary);margin:0 0 8px;padding-bottom:6px;border-bottom:1px solid var(--border-subtle);';
    const insightText  = 'font-size:14px;color:var(--text-secondary);line-height:1.65;margin:0;';
    if (match.why_this_client_fits) {
      rows.push(`<div><p style="${insightLabel}">Why You Fit</p><p style="${insightText}">${esc(match.why_this_client_fits)}</p></div>`);
    }
    if (match.best_pitch_angle) {
      rows.push(`<div><p style="${insightLabel}">Best Pitch Angle</p><p style="${insightText}">${esc(match.best_pitch_angle)}</p></div>`);
    }
    if (rows.length > 0) {
      insightsEl.innerHTML = rows.join('<hr style="border:none;border-top:1px solid #e0dbff;margin:4px 0;">');
      insightsEl.style.display = 'flex';
    } else {
      insightsEl.style.display = 'none';
    }
  }

  // Show/hide buttons based on status
  const status = match.status;
  const canSend    = !['sent','followed_up','replied','booked','appeared','dismissed'].includes(status);
  const canRewrite = !['sent','followed_up','replied','booked','appeared','dismissed'].includes(status);
  const canSentMyself = ['new','dream'].includes(status);
  const canRestore    = ['new','dream'].includes(status);

  const show = (id, visible) => { const el = $(id); if (el) el.style.display = visible ? 'inline-flex' : 'none'; };
  const canRescoreStatuses = ['new','dream'];
  show('email-send-btn',        canSend);
  show('email-rewrite-btn',     canRewrite);
  show('email-sent-myself-btn', canSentMyself);
  show('email-restore-btn',     canRestore);
  show('email-approve-btn',     status === 'new');
  show('email-reenrich-btn',    canRescoreStatuses.includes(status));
  show('email-discovery-btn',   status === 'new');

  $('email-modal').style.display = 'flex';
  $('email-modal').dataset.matchId = matchId;
  document.body.style.overflow = 'hidden';

  // Hide template selector and voice intro for thank-you mode
  const tmplSelEl = $('template-selector');
  if (tmplSelEl) tmplSelEl.style.display = isAppeared ? 'none' : 'flex';
  const voiceSection = $('voice-intro-section');
  if (voiceSection) voiceSection.style.display = isAppeared ? 'none' : 'block';
  voiceIntro.loadForMatch(matchId);

  // Auto-generate pitch if no real pitch exists yet
  if (isFallback && !isAppeared && ['new','dream'].includes(match.status)) {
    setTimeout(() => $('email-rewrite-btn')?.click(), 100);
  }
}

function closeEmailModal() {
  $('email-modal').style.display = 'none';
  document.body.style.overflow = '';
  state.modalMatchId = null;
  voiceIntro.cleanupOnClose();
}

// ── Voice intro (per-host audio attachment) ────────────────────────────
const voiceIntro = (() => {
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordingTimer = null;
  let recordingStartedAt = 0;

  function showAttached({ signedUrl, filename, mime, bytes }) {
    const row = $('voice-attached-row');
    const player = $('voice-player');
    const meta = $('voice-meta');
    if (!row || !player) return;
    if (signedUrl) player.src = signedUrl;
    if (meta) {
      const kb = bytes ? Math.round(bytes / 1024) : 0;
      meta.textContent = (filename || 'voice-intro') + (kb ? ` · ${kb} KB` : '');
    }
    row.style.display = 'flex';
    const recBtn = $('voice-record-btn');
    if (recBtn) recBtn.style.display = 'none';
    const uploadLabel = $('voice-upload-input')?.parentElement;
    if (uploadLabel) uploadLabel.style.display = 'none';
  }

  function hideAttached() {
    const row = $('voice-attached-row');
    const player = $('voice-player');
    if (row) row.style.display = 'none';
    if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
    const recBtn = $('voice-record-btn');
    if (recBtn) recBtn.style.display = 'inline-flex';
    const uploadLabel = $('voice-upload-input')?.parentElement;
    if (uploadLabel) uploadLabel.style.display = 'inline-flex';
  }

  async function loadForMatch(matchId) {
    hideAttached();
    if (!matchId) return;
    try {
      const res = await fetch(`/api/audio-url/${matchId}`, { headers: { 'x-dashboard-token': state.token } });
      const data = await res.json();
      if (data?.success && data.signedUrl) {
        showAttached(data);
      }
    } catch (err) {
      console.warn('voice intro load failed', err);
    }
  }

  async function uploadBlob(blob, filename) {
    const matchId = state.modalMatchId;
    if (!matchId) return;
    const fd = new FormData();
    fd.append('audio', blob, filename || 'voice-intro.webm');
    fd.append('matchId', matchId);
    try {
      const res = await fetch('/api/upload-audio', {
        method:  'POST',
        headers: { 'x-dashboard-token': state.token },
        body:    fd,
      });
      const data = await res.json();
      if (data?.success) {
        showAttached(data);
        toast('Voice intro attached. It will be sent with this pitch.');
      } else {
        alert(data?.error || 'Upload failed.');
      }
    } catch (err) {
      console.error('voice upload error', err);
      alert('Upload failed.');
    }
  }

  async function deleteAttached() {
    const matchId = state.modalMatchId;
    if (!matchId) return;
    if (!confirm('Remove the voice intro from this pitch?')) return;
    try {
      const res = await fetch(`/api/upload-audio/${matchId}`, {
        method:  'DELETE',
        headers: { 'x-dashboard-token': state.token },
      });
      const data = await res.json();
      if (data?.success) {
        hideAttached();
        toast('Voice intro removed.');
      }
    } catch (err) {
      console.error('voice delete error', err);
    }
  }

  async function startRecording() {
    if (mediaRecorder) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('Recording is not supported in this browser. Use Upload instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
      mediaRecorder = preferredMime ? new MediaRecorder(stream, { mimeType: preferredMime }) : new MediaRecorder(stream);
      recordedChunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data?.size) recordedChunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        const type = mediaRecorder?.mimeType || 'audio/webm';
        const ext = type.includes('mp4') ? 'm4a' : 'webm';
        const blob = new Blob(recordedChunks, { type });
        recordedChunks = [];
        stream.getTracks().forEach(t => t.stop());
        mediaRecorder = null;
        showRecordingUI(false);
        await uploadBlob(blob, `voice-intro.${ext}`);
      };
      mediaRecorder.start();
      recordingStartedAt = Date.now();
      showRecordingUI(true);
      recordingTimer = setInterval(updateTimer, 250);
    } catch (err) {
      console.error('mic error', err);
      alert('Could not access the microphone. Check browser permissions.');
    }
  }

  function stopRecording() {
    if (mediaRecorder?.state === 'recording') {
      mediaRecorder.stop();
    }
  }

  function showRecordingUI(active) {
    const status = $('voice-recording-status');
    const recBtn = $('voice-record-btn');
    if (status) status.style.display = active ? 'flex' : 'none';
    if (recBtn) recBtn.style.display = active ? 'none' : 'inline-flex';
    if (!active) {
      clearInterval(recordingTimer);
      recordingTimer = null;
      const t = $('voice-recording-time');
      if (t) t.textContent = '0:00';
    }
  }

  function updateTimer() {
    const elapsed = Math.floor((Date.now() - recordingStartedAt) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const t = $('voice-recording-time');
    if (t) t.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    if (elapsed >= 180) stopRecording(); // hard cap at 3 min
  }

  function cleanupOnClose() {
    if (mediaRecorder?.state === 'recording') {
      try { mediaRecorder.stop(); } catch {}
    }
    clearInterval(recordingTimer);
    recordingTimer = null;
    showRecordingUI(false);
  }

  function init() {
    $('voice-record-btn')?.addEventListener('click', startRecording);
    $('voice-stop-btn')?.addEventListener('click', stopRecording);
    $('voice-delete-btn')?.addEventListener('click', deleteAttached);
    $('voice-upload-input')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { alert('Audio file is too large (max 5MB).'); return; }
      await uploadBlob(file, file.name);
      e.target.value = '';
    });
  }

  function toast(msg) {
    if (typeof window.showToast === 'function') return window.showToast(msg);
    console.log(msg);
  }

  return { init, loadForMatch, cleanupOnClose };
})();

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
    .catch(() => showToast('Could not copy. Please copy manually.', 'error'));
}

// ── Contact modal ─────────────────────────────────────────────────────
function openContactModal(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;
  const p = match.podcasts || {};
  state.contactModalId = matchId;

  const titleEl = $('contact-modal-title');
  if (titleEl) titleEl.textContent = p.title || 'Podcast Details';

  // Build social links — validated profiles only
  const socialLinks = [];
  if (isValidSocialProfile(p.instagram_url, 'instagram'))                            socialLinks.push(`<a href="${esc(p.instagram_url)}" target="_blank" class="social-link">Instagram</a>`);
  if (isValidSocialProfile(p.twitter_url, 'twitter'))                                socialLinks.push(`<a href="${esc(p.twitter_url)}" target="_blank" class="social-link">Twitter/X</a>`);
  if (isValidSocialProfile(p.facebook_url, 'facebook'))                              socialLinks.push(`<a href="${esc(p.facebook_url)}" target="_blank" class="social-link">Facebook</a>`);
  if (isValidSocialProfile(p.linkedin_page_url || p.linkedin_url, 'linkedin'))       socialLinks.push(`<a href="${esc(p.linkedin_page_url || p.linkedin_url)}" target="_blank" class="social-link">LinkedIn</a>`);
  if (isValidUrl(p.tiktok_url))                                                       socialLinks.push(`<a href="${esc(p.tiktok_url)}" target="_blank" class="social-link">TikTok</a>`);

  const scoreBreakdown = `
    <div style="display:flex;flex-direction:column;gap:5px;margin-top:8px;">
      ${scoreBarHtml('Relevance',   match.relevance_score)}
      ${scoreBarHtml('Audience',    match.audience_score)}
      ${scoreBarHtml('Recency',     match.recency_score)}
      ${scoreBarHtml('Reach',       match.reach_score)}
      ${scoreBarHtml('Contact',     match.contactability_score)}
      ${match.seo_score != null    ? scoreBarHtml('SEO Value',  match.seo_score) : ''}
      ${match.brand_score          ? scoreBarHtml('Brand Fit',  match.brand_score) : ''}
      ${match.guest_quality_score  ? scoreBarHtml('Guest Qual.', match.guest_quality_score) : ''}
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

  // Hide START HERE permanently after first click
  const startHereKey = `pp-start-here-gone-${state.token}`;
  if (!localStorage.getItem(startHereKey)) {
    localStorage.setItem(startHereKey, '1');
    const startHereEl = $('start-here-label');
    if (startHereEl) startHereEl.style.display = 'none';
  }

  btn.disabled = true;
  btn.style.color = '#fff';
  const pd = $('profile-dropdown'); if (pd) pd.style.display = 'none';
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
    // Increment run number each click so discovery fetches a fresh offset each time
    const runKey = `pp-run-number-${state.client.id}`;
    const runNumber = (parseInt(localStorage.getItem(runKey) || '0', 10)) + 1;
    localStorage.setItem(runKey, String(runNumber));
    const res  = await fetch(`/api/run/${state.client.id}?run=${runNumber}`, { method: 'POST', headers: { 'x-dashboard-token': state.token } });
    const data = await res.json();
    if (data.success) {
      if (data.capReached) {
        showToast(data.message, 'info');
        showUnlimitedUpsell();
        btn.textContent = 'Find a Podcast';
        btn.disabled = false;
        return;
      }
      showToast(`Pipeline complete. Checking for new matches...`, 'success');
      pollForNewMatches();
    } else if (res.status === 402 && (data.error === 'demo_locked' || data.demo_locked)) {
      // Demo prospect ran out of starter credits — funnel to upgrade
      openUpgradeModal();
    } else if (res.status === 402 && data.error === 'insufficient_credits') {
      handleInsufficientCredits(data);
    } else {
      showToast('Pipeline run failed.', 'error');
    }
  } catch { showToast('Network error running pipeline.', 'error'); }
  finally { clearInterval(stepInterval); btn.textContent = 'Find a Podcast'; btn.disabled = false; btn.style.color = ''; }
}

function pollForNewMatches() {
  const ACTIVE = ['new','sent','followed_up','replied','booked','appeared','dream'];
  const knownActiveCount = state.matches.filter(m => ACTIVE.includes(m.status)).length;
  const knownTotal = state.matches.length;
  let attempts = 0;
  const maxAttempts = 20; // poll for up to ~60s
  const interval = setInterval(async () => {
    attempts++;
    try {
      const res  = await fetch(`/api/dashboard/${state.token}`);
      const data = await res.json();
      if (data.success && data.matches) {
        const newTotal = data.matches.length;
        const newActiveCount = data.matches.filter(m => ACTIVE.includes(m.status)).length;
        // Detect new inserts OR revived-from-archive matches (active count increased)
        if (newTotal > knownTotal || newActiveCount > knownActiveCount) {
          clearInterval(interval);
          state.matches = data.matches;
          const added = newActiveCount - knownActiveCount;
          renderDashboard(data);
          showToast(`${added > 0 ? added : 'New'} podcast match${added === 1 ? '' : 'es'} added!`, 'success');
          backgroundReEnrichAll();
        }
      }
    } catch { /* silent */ }
    if (attempts >= maxAttempts) {
      clearInterval(interval);
      showToast('Your matches are up to date. No new podcasts found this run.', 'info');
    }
  }, 3000);
}

async function bulkRescore() { await refreshPipeline(); }

async function refreshPipeline() {
  if (!state.matches?.length) { showToast('No matches to refresh.', 'info'); return; }
  const btn = $('refresh-pipeline-btn');
  const btnOriginalHTML = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.style.cursor = 'default'; }

  const active = state.matches.filter(m => !['dismissed','archived'].includes(m.status));
  const total  = active.length;
  let done = 0;

  // Show a fixed progress bar banner at the top of the page
  let progressBanner = document.getElementById('refresh-progress-banner');
  if (!progressBanner) {
    progressBanner = document.createElement('div');
    progressBanner.id = 'refresh-progress-banner';
    progressBanner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#6366f1;color:#fff;font-size:13px;font-weight:600;padding:10px 20px;display:flex;align-items:center;gap:14px;box-shadow:0 2px 12px rgba(99,102,241,0.4);';
    progressBanner.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 1s linear infinite;flex-shrink:0;"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
      <span id="refresh-progress-text">Re-enriching pipeline… 0/${total}</span>
      <div style="flex:1;background:rgba(255,255,255,0.25);border-radius:999px;height:6px;overflow:hidden;">
        <div id="refresh-progress-bar" style="height:100%;background:#fff;border-radius:999px;width:0%;transition:width 0.3s ease;"></div>
      </div>
      <span id="refresh-progress-pct" style="opacity:0.85;min-width:36px;text-align:right;">0%</span>
    `;
    document.body.prepend(progressBanner);
  }

  const updateBtn = () => {
    const pct = Math.round((done / total) * 100);
    if (btn) btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 1s linear infinite"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> ${done}/${total}`;
    const txt = document.getElementById('refresh-progress-text');
    const bar = document.getElementById('refresh-progress-bar');
    const pctEl = document.getElementById('refresh-progress-pct');
    if (txt) txt.textContent = `Re-enriching pipeline… ${done}/${total}`;
    if (bar) bar.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct}%`;
  };

  updateBtn();

  const BATCH = 3;
  for (let i = 0; i < active.length; i += BATCH) {
    const batch = active.slice(i, i + BATCH);
    await Promise.all(batch.map(async m => {
      await triggerReEnrich(m.id).catch(() => {});
      done++;
      updateBtn();
    }));
    if (i + BATCH < active.length) await new Promise(r => setTimeout(r, 800));
  }

  // Remove banner, reload dashboard for clean data
  if (progressBanner) progressBanner.remove();
  showToast(`Pipeline refreshed. ${done} card${done === 1 ? '' : 's'} updated. Reloading...`, 'success');
  setTimeout(() => window.location.reload(), 1200);
}
window.refreshPipeline = refreshPipeline;

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
  if (btn) { btn.textContent = 'Generating…'; btn.disabled = true; }
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
      showToast(`Next generation available in ${data.hoursLeft}h`, 'info');
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
      // Re-render hero greeting so headshot appears next to name
      renderHeroSection();
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
$('profile-instagram').value    = c.social_instagram   || '';
  $('profile-linkedin').value     = c.social_linkedin    || '';
  $('profile-twitter').value      = c.social_twitter     || '';
  $('profile-facebook').value     = c.social_facebook    || '';
  if ($('profile-youtube')) $('profile-youtube').value = c.social_youtube || '';
  $('profile-extra-links').value  = c.extra_links        || '';
  $('profile-signature').value    = c.email_signature    || '';
  // Community toggle
  const shareEl  = $('profile-share-community');
  const trackEl  = $('community-toggle-track');
  const thumbEl  = $('community-toggle-thumb');
  if (shareEl) shareEl.checked = !!(c.share_with_community);
  if (trackEl) trackEl.style.background = c.share_with_community ? '#6366f1' : '#d1d5db';
  if (thumbEl) thumbEl.style.transform  = c.share_with_community ? 'translateX(20px)' : 'translateX(0)';
  $('profile-tone').value         = c.preferred_tone     || 'warm-professional';
  $('profile-topics').value       = (c.topics            || []).join(', ');
  $('profile-angles').value       = (c.speaking_angles   || []).join(', ');
  $('profile-audience').value     = c.target_audience    || '';
  $('profile-bio-short').value    = c.bio_short          || '';
  $('profile-bio-long').value     = c.bio_long           || '';
  $('profile-pitch-style').value  = c.pitch_style        || '';
  if ($('profile-offer'))         $('profile-offer').value         = c.lead_magnet  || '';
  if ($('profile-booking-link'))  $('profile-booking-link').value  = c.booking_link || '';
  // Pace selector
  const dailyTarget = c.daily_target || 10;
  $('profile-daily').value = dailyTarget;
  const paceSelect = $('profile-daily-select');
  if (paceSelect) paceSelect.value = dailyTarget <= 5 ? '5' : dailyTarget >= 20 ? '20' : '10';

  // Country
  const countryEl = $('profile-country');
  if (countryEl) {
    const geo = (c.geographies || [])[0];
    const GEO_TO_COUNTRY = { FR:'France', DE:'Germany', ES:'Spain', MX:'Mexico', BR:'Brazil', IT:'Italy', PT:'Portugal', NL:'Netherlands', AU:'Australia', CA:'Canada', GB:'United Kingdom', UK:'United Kingdom', IN:'India', JP:'Japan', KR:'South Korea', PL:'Poland', SE:'Sweden' };
    countryEl.value = GEO_TO_COUNTRY[geo] || 'Any';
  }

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
    social_instagram: normalizeHandle($('profile-instagram').value.trim(), 'https://instagram.com/'),
    social_linkedin:  normalizeProfileUrl($('profile-linkedin').value.trim(), 'https://linkedin.com/in/'),
    social_twitter:   normalizeHandle($('profile-twitter').value.trim(), 'https://twitter.com/'),
    social_facebook:        $('profile-facebook').value.trim(),
    social_youtube:         ($('profile-youtube')?.value || '').trim(),
    extra_links:            $('profile-extra-links').value.trim(),
    email_signature:        $('profile-signature').value.trim(),
    share_with_community:   !!($('profile-share-community')?.checked),
    preferred_tone:   $('profile-tone').value,
    daily_target:     parseInt($('profile-daily-select')?.value || $('profile-daily').value, 10) || 10,
    topics:           splitTrim($('profile-topics').value),
    speaking_angles:  splitTrim($('profile-angles').value),
    target_audience:  $('profile-audience').value.trim(),
    bio_short:        $('profile-bio-short').value.trim(),
    bio_long:         $('profile-bio-long').value.trim(),
    pitch_style:      $('profile-pitch-style').value.trim(),
    lead_magnet:      ($('profile-offer')?.value         || '').trim(),
    booking_link:     ($('profile-booking-link')?.value  || '').trim(),
    ...countryToLangGeo($('profile-country')?.value || 'Any'),
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
  showToast('Template cleared. Your default pitch template will be used.', 'info');
}

// ── Save as Template ──────────────────────────────────────────────────
async function saveAsTemplate() {
  const subject = $('modal-subject')?.value || '';
  const body = $('modal-body-text')?.value || '';
  if (!subject && !body) { showToast('Nothing to save.', 'error'); return; }
  const name = prompt('Name this template (e.g. "Intro pitch", "Follow-up"):');
  if (!name) return;

  // Determine type from current match status if available
  const matchId = $('email-modal')?.dataset.matchId || null;
  const match = matchId ? state.matches.find(m => m.id === matchId) : null;
  const type = match?.status === 'replied' ? 'followup' : (match?.status === 'appeared' ? 'thankyou' : 'pitch');

  try {
    const data = await apiPost('/api/templates', { type, name: name.trim(), subject, body });
    if (data.ok) {
      showToast(`Template "${name}" saved.`, 'success');
    } else {
      showToast('Failed to save template: ' + (data.error || 'unknown'), 'error');
    }
  } catch { showToast('Network error.', 'error'); }
}

// ── Template picker (dropdown shows saved templates) ──────────────────
async function openTemplatePicker(event) {
  event?.stopPropagation();
  const matchId = $('email-modal')?.dataset.matchId;
  if (!matchId) { showToast('Open an email first.', 'error'); return; }

  // Remove any existing picker
  document.getElementById('template-picker')?.remove();

  // Fetch templates
  let templates = [];
  try {
    const r = await fetch('/api/templates', { headers: { 'x-dashboard-token': state.token } });
    const data = await r.json();
    if (data.ok) templates = data.templates || [];
  } catch {}

  if (templates.length === 0) {
    showToast('No saved templates yet. Save one first with the "Save as My Template" button.', 'success');
    return;
  }

  // Build dropdown anchored to the button
  const btn = document.getElementById('email-apply-template-btn');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();

  const picker = document.createElement('div');
  picker.id = 'template-picker';
  picker.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.bottom + 4}px;background:var(--surface-card);border:1.5px solid var(--border-medium);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.18);z-index:99999;min-width:260px;max-width:320px;max-height:340px;overflow-y:auto;padding:6px;`;

  picker.innerHTML = templates.map(t => `
    <button onclick="applyTemplate('${esc(t.id)}', '${esc(matchId)}')" style="display:block;width:100%;text-align:left;background:none;border:none;padding:10px 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:13px;color:var(--text-primary);transition:background 0.1s;">
      <div style="font-weight:700;display:flex;align-items:center;gap:6px;">
        ${esc(t.name)}
        ${t.is_default ? '<span style="font-size:9px;font-weight:800;background:#10b981;color:#fff;padding:2px 6px;border-radius:999px;">DEFAULT</span>' : ''}
        <span style="font-size:9px;font-weight:700;background:rgba(99,102,241,0.10);color:#6366f1;padding:2px 6px;border-radius:999px;text-transform:uppercase;">${esc(t.type)}</span>
      </div>
      <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;">${t.use_count || 0} uses · ${esc((t.subject || '').slice(0, 40))}${(t.subject || '').length > 40 ? '…' : ''}</div>
    </button>
  `).join('');

  // Hover effect
  picker.querySelectorAll('button').forEach(b => {
    b.addEventListener('mouseenter', () => b.style.background = 'rgba(99,102,241,0.08)');
    b.addEventListener('mouseleave', () => b.style.background = 'none');
  });

  document.body.appendChild(picker);
  // Close on click outside
  setTimeout(() => {
    const close = (e) => {
      if (!picker.contains(e.target) && e.target !== btn) {
        picker.remove();
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
  }, 0);
}
window.openTemplatePicker = openTemplatePicker;

// ── Thread Reply: Template picker dropdown ─────────────────────────────
async function openThreadTemplatePicker() {
  const btn = document.getElementById('thread-templates-btn');
  if (!btn) return;

  // Remove any existing picker
  document.getElementById('thread-template-picker')?.remove();

  // Fetch templates
  let templates = [];
  try {
    const r = await fetch('/api/templates', { headers: { 'x-dashboard-token': state.token } });
    const data = await r.json();
    if (data.ok) templates = data.templates || [];
  } catch {}

  if (templates.length === 0) {
    showToast('No saved templates yet. Write a reply and save it as a template first.', 'info');
    return;
  }

  const rect = btn.getBoundingClientRect();

  const picker = document.createElement('div');
  picker.id = 'thread-template-picker';
  picker.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.bottom + 4}px;background:var(--surface-card);border:1.5px solid var(--border-medium);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.18);z-index:99999;min-width:260px;max-width:320px;max-height:340px;overflow-y:auto;padding:6px;`;

  picker.innerHTML = templates.map(t => `
    <button onclick="loadThreadTemplate('${esc(t.id)}')" style="display:block;width:100%;text-align:left;background:none;border:none;padding:10px 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:13px;color:var(--text-primary);transition:background 0.1s;">
      <div style="font-weight:700;display:flex;align-items:center;gap:6px;">
        ${esc(t.name)}
        ${t.is_default ? '<span style="font-size:9px;font-weight:800;background:#10b981;color:#fff;padding:2px 6px;border-radius:999px;">DEFAULT</span>' : ''}
        <span style="font-size:9px;font-weight:700;background:rgba(99,102,241,0.10);color:#6366f1;padding:2px 6px;border-radius:999px;text-transform:uppercase;">${esc(t.type)}</span>
      </div>
      <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;">${t.use_count || 0} uses · ${esc((t.subject || '').slice(0, 40))}${(t.subject || '').length > 40 ? '…' : ''}</div>
    </button>
  `).join('');

  picker.querySelectorAll('button').forEach(b => {
    b.addEventListener('mouseenter', () => b.style.background = 'rgba(99,102,241,0.08)');
    b.addEventListener('mouseleave', () => b.style.background = 'none');
  });

  document.body.appendChild(picker);
  setTimeout(() => {
    const close = (e) => {
      if (!picker.contains(e.target) && e.target !== btn) {
        picker.remove();
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
  }, 0);
}
window.openThreadTemplatePicker = openThreadTemplatePicker;

function loadThreadTemplate(templateId) {
  document.getElementById('thread-template-picker')?.remove();
  const templates = state.client.email_templates || [];
  let t = templates.find(x => x.id === templateId);
  if (!t) return;
  const subjectEl = document.getElementById('thread-reply-subject');
  const bodyEl = document.getElementById('thread-reply-body');
  if (subjectEl) subjectEl.value = t.subject || '';
  if (bodyEl) bodyEl.value = t.body || '';
  showToast(`Template "${t.name}" loaded.`, 'success');
}
window.loadThreadTemplate = loadThreadTemplate;

// ── Thread Reply: Save as Template ────────────────────────────────────
async function saveThreadTemplate() {
  const subject = document.getElementById('thread-reply-subject')?.value || '';
  const body = document.getElementById('thread-reply-body')?.value || '';
  if (!subject && !body) { showToast('Nothing to save.', 'error'); return; }
  const name = prompt('Name this template (e.g. "Intro pitch", "Follow-up"):');
  if (!name) return;

  const type = _activeThreadMatchId
    ? (() => {
        const m = state.matches.find(x => x.id === _activeThreadMatchId);
        return m?.status === 'replied' ? 'followup' : (m?.status === 'appeared' ? 'thankyou' : 'pitch');
      })()
    : 'pitch';

  try {
    const data = await apiPost('/api/templates', { type, name: name.trim(), subject, body });
    if (data.ok) {
      showToast(`Template "${name}" saved.`, 'success');
    } else {
      showToast('Failed to save template: ' + (data.error || 'unknown'), 'error');
    }
  } catch { showToast('Network error.', 'error'); }
}
window.saveThreadTemplate = saveThreadTemplate;

// ── Template Manager (profile dropdown CRUD) ──────────────────────────
function openTemplateManager() {
  $('profile-dropdown').style.display = 'none';
  const drawer = document.getElementById('template-manager-modal');
  if (!drawer) return;
  drawer.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  renderTemplateManager();
}
window.openTemplateManager = openTemplateManager;

function closeTemplateManager() {
  const drawer = document.getElementById('template-manager-modal');
  if (drawer) drawer.style.display = 'none';
  document.body.style.overflow = '';
}
window.closeTemplateManager = closeTemplateManager;

// ── Type badge helper ──────────────────────────────────────────────────
function tmTypeBadge(type) {
  const cls = type === 'followup' ? 'tm-badge-followup' :
             type === 'reply'     ? 'tm-badge-reply'   :
                                    'tm-badge-pitch';
  return `<span class="tm-badge ${cls}">${esc(type || 'pitch')}</span>`;
}

// ── New template form state ────────────────────────────────────────────
let _tmNewFormShowing = false;

function showNewTemplateForm() {
  if (_tmNewFormShowing) return;
  const body = document.getElementById('template-manager-body');
  if (!body) return;

  // Check if we need to scroll the body back up
  body.scrollTop = 0;

  const form = document.createElement('div');
  form.id = 'tm-new-form';
  form.className = 'tm-new-form';
  form.innerHTML = `
    <div class="tm-new-form-title">Create a new template</div>

    <div class="tm-new-row">
      <div>
        <label class="field-label" for="tm-new-name">Template Name</label>
        <input type="text" id="tm-new-name" class="tm-edit-field" placeholder="e.g. Intro Pitch, Follow-up" autocomplete="off" />
      </div>
      <div>
        <label class="field-label" for="tm-new-type">Type</label>
        <select id="tm-new-type" class="tm-edit-field" style="cursor:pointer;">
          <option value="pitch">Pitch</option>
          <option value="followup">Follow-up</option>
          <option value="reply">Reply</option>
        </select>
      </div>
    </div>

    <div>
      <label class="field-label" for="tm-new-subject">Subject Line</label>
      <input type="text" id="tm-new-subject" class="tm-edit-field" placeholder="Optional — leave blank to generate per-match" autocomplete="off" />
    </div>

    <div>
      <label class="field-label" for="tm-new-body">Email Body</label>
      <textarea id="tm-new-body" class="tm-edit-field tm-edit-textarea" placeholder="Use {host_name}, {podcast_title}, {client_name} as placeholders. They'll be replaced with real values when you send."></textarea>
      <div class="tm-placeholder-hint">Available placeholders: {host_name} &middot; {podcast_title} &middot; {client_name}</div>
    </div>

    <div class="tm-new-actions">
      <button class="btn btn-ghost btn-sm" onclick="cancelNewTemplate()">Cancel</button>
      <button class="btn btn-primary btn-sm" onclick="saveNewTemplate()">Save Template</button>
    </div>
  `;

  body.insertBefore(form, body.firstChild);
  _tmNewFormShowing = true;

  // Focus the name field
  setTimeout(() => document.getElementById('tm-new-name')?.focus(), 100);
}
window.showNewTemplateForm = showNewTemplateForm;

function cancelNewTemplate() {
  const form = document.getElementById('tm-new-form');
  if (form) form.remove();
  _tmNewFormShowing = false;
}
window.cancelNewTemplate = cancelNewTemplate;

async function saveNewTemplate() {
  const name    = document.getElementById('tm-new-name')?.value?.trim();
  const type    = document.getElementById('tm-new-type')?.value || 'pitch';
  const subject = document.getElementById('tm-new-subject')?.value?.trim() || '';
  const body    = document.getElementById('tm-new-body')?.value?.trim();

  if (!name) { showToast('Template name is required.', 'error'); return; }
  if (!body) { showToast('Email body is required.', 'error'); return; }

  try {
    const data = await apiPost('/api/templates', { type, name, subject, body });
    if (data.ok) {
      showToast(`Template "${name}" created.`, 'success');
      cancelNewTemplate();
      renderTemplateManager();
    } else {
      showToast('Failed to create template: ' + (data.error || 'unknown'), 'error');
    }
  } catch { showToast('Network error.', 'error'); }
}
window.saveNewTemplate = saveNewTemplate;

async function renderTemplateManager() {
  const body = document.getElementById('template-manager-body');
  if (!body) return;

  body.innerHTML = '<div style="padding:48px;text-align:center;color:var(--text-tertiary);font-size:14px;">Loading templates…</div>';

  try {
    const r = await fetch('/api/templates', { headers: { 'x-dashboard-token': state.token } });
    const data = await r.json();
    const templates = (data.ok ? data.templates : []) || [];

    if (templates.length === 0) {
      body.innerHTML = `
        <div style="padding:60px 20px;text-align:center;">
          <div style="font-size:40px;margin-bottom:16px;opacity:0.3;">&#128196;</div>
          <div style="font-size:16px;font-weight:700;color:var(--text-primary);margin-bottom:6px;">No templates yet</div>
          <p style="font-size:13px;color:var(--text-tertiary);line-height:1.6;max-width:360px;margin:0 auto 20px;">
            Write a pitch in the email composer, then save it as a template. Or click "+ New Template" to create one from scratch.
          </p>
          <button class="btn btn-primary" onclick="showNewTemplateForm()">+ Create Your First Template</button>
        </div>`;
      return;
    }

    body.innerHTML = templates.map(t => `
      <div class="tm-card" id="tm-item-${esc(t.id)}">

        <!-- View mode -->
        <div id="tm-view-${esc(t.id)}">
          <div class="tm-card-header">
            <div style="flex:1;min-width:0;">
              <div class="tm-card-title">
                ${esc(t.name)}
                ${t.is_default ? '<span class="tm-badge tm-badge-default">DEFAULT</span>' : ''}
                ${tmTypeBadge(t.type)}
              </div>
              <div class="tm-subject">
                <span class="tm-subject-label">Subject:</span> ${esc((t.subject || '(no subject)').slice(0, 80))}
              </div>
              <div class="tm-body-preview">${esc((t.body || '').slice(0, 200))}${(t.body || '').length > 200 ? '…' : ''}</div>
              <div class="tm-meta">
                <span>${t.use_count || 0} uses</span>
                ${t.updated_at ? `<span>Edited ${timeAgo(t.updated_at)}</span>` : ''}
              </div>
            </div>
            <div class="tm-card-actions">
              <button class="tm-card-btn tm-card-btn-edit" onclick="editTemplate('${esc(t.id)}')">Edit</button>
              <button class="tm-card-btn tm-card-btn-delete" onclick="deleteTemplate('${esc(t.id)}')">Delete</button>
            </div>
          </div>
        </div>

        <!-- Edit mode -->
        <div id="tm-edit-${esc(t.id)}" style="display:none;">
          <div class="tm-edit-form">
            <input type="text" id="tm-edit-name-${esc(t.id)}" class="tm-edit-field" value="${esc(t.name)}" placeholder="Template name" />
            <input type="text" id="tm-edit-subject-${esc(t.id)}" class="tm-edit-field" value="${esc(t.subject || '')}" placeholder="Subject (optional)" />
            <textarea id="tm-edit-body-${esc(t.id)}" class="tm-edit-field tm-edit-textarea" placeholder="Email body template...">${esc(t.body || '')}</textarea>
            <div class="tm-edit-actions">
              <button class="btn btn-ghost btn-sm" onclick="cancelTemplateEdit('${esc(t.id)}')">Cancel</button>
              <button class="btn btn-primary btn-sm" onclick="saveTemplateEdit('${esc(t.id)}')">Save</button>
            </div>
          </div>
        </div>

      </div>
    `).join('');

  } catch {
    body.innerHTML = '<div style="padding:48px;text-align:center;color:#ef4444;font-size:14px;">Failed to load templates. Check your connection and try again.</div>';
  }
}

// ── Simple relative time helper ────────────────────────────────────────
function timeAgo(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

async function deleteTemplate(templateId) {
  if (!window.confirm('Delete this template? This cannot be undone.')) return;

  const del = async () => {
    const r = await fetch(`/api/templates/${templateId}`, {
      method: 'DELETE',
      headers: { 'x-dashboard-token': state.token }
    });
    return r.json();
  };

  try {
    const data = await del();
    if (data.ok) {
      showToast('Template deleted.', 'success');
      renderTemplateManager();
    } else {
      showToast('Failed to delete template.', 'error');
    }
  } catch {
    showToast('Network error.', 'error');
  }
}
window.deleteTemplate = deleteTemplate;

function editTemplate(templateId) {
  document.getElementById(`tm-view-${templateId}`).style.display = 'none';
  document.getElementById(`tm-edit-${templateId}`).style.display = 'block';
}
window.editTemplate = editTemplate;

function cancelTemplateEdit(templateId) {
  document.getElementById(`tm-view-${templateId}`).style.display = '';
  document.getElementById(`tm-edit-${templateId}`).style.display = 'none';
}
window.cancelTemplateEdit = cancelTemplateEdit;

async function saveTemplateEdit(templateId) {
  const name    = document.getElementById(`tm-edit-name-${templateId}`)?.value?.trim();
  const subject = document.getElementById(`tm-edit-subject-${templateId}`)?.value?.trim() || '';
  const body    = document.getElementById(`tm-edit-body-${templateId}`)?.value?.trim() || '';
  if (!name) { showToast('Template name is required.', 'error'); return; }

  try {
    const data = await apiPatch(`/api/templates/${templateId}`, { name, subject, body });
    if (data.ok) {
      showToast('Template updated.', 'success');
      renderTemplateManager();
    } else {
      showToast('Failed to update template: ' + (data.error || 'unknown'), 'error');
    }
  } catch { showToast('Network error.', 'error'); }
}
window.saveTemplateEdit = saveTemplateEdit;

// ── Discovery email generator (alternative first-touch — probes for fit) ─
async function generateDiscoveryEmail() {
  const matchId = $('email-modal')?.dataset.matchId;
  if (!matchId) return;
  const btn = $('email-discovery-btn');
  if (!btn) return;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Drafting…';
  try {
    const data = await apiPost('/api/generate-discovery', { matchId });
    if (!data.success) throw new Error(data.error || 'generate_failed');
    const subjectEl = $('modal-subject');
    const bodyEl = $('modal-body-text');
    if (subjectEl) subjectEl.value = data.subject || '';
    if (bodyEl) {
      bodyEl.value = data.body || '';
      bodyEl.focus();
      bodyEl.setSelectionRange(bodyEl.value.length, bodyEl.value.length);
    }
    showToast('Discovery email drafted. Edit and send.', 'success');
  } catch (err) {
    showToast('Could not draft discovery email: ' + (err.message || 'error'), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}
window.generateDiscoveryEmail = generateDiscoveryEmail;

async function applyTemplate(templateId, matchId) {
  document.getElementById('template-picker')?.remove();
  if (!templateId || !matchId) return;
  try {
    const data = await apiPost(`/api/templates/${templateId}/apply/${matchId}`, {});
    if (!data.ok) throw new Error(data.error || 'apply_failed');

    // Update modal fields with the substituted content
    const subjectEl = $('modal-subject');
    const bodyEl = $('modal-body-text');
    if (subjectEl) subjectEl.value = data.subject || '';
    if (bodyEl) bodyEl.value = data.body || '';
    showToast('Template applied. Edit and send.', 'success');
  } catch (err) {
    showToast('Could not apply template: ' + (err.message || 'error'), 'error');
  }
}
window.applyTemplate = applyTemplate;

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
    // Always hide community view and restore cards grid when a tab is clicked
    if ($('leaderboard-view')) $('leaderboard-view').style.display = 'none';
    if ($('cards-grid'))       $('cards-grid').style.display = '';
    document.getElementById('leaderboard-tab')?.classList.remove('active');
    tabs.querySelectorAll('.filter-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.filter = tab.dataset.status;
    // Clear reply badge when Host Replied tab is clicked — persist seen IDs
    if (tab.dataset.status === 'replied') {
      // Mark all replied as seen — tab-count badge will go back to normal grey
      const seenKey = `seen_replied_${state.token}`;
      const allRepliedIds = state.matches.filter(m => m.status === 'replied').map(m => m.id);
      localStorage.setItem(seenKey, JSON.stringify(allRepliedIds));
      updateStatBadges(); // re-render badges so replied count goes grey
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
  voiceIntro.init();

  $('email-reenrich-btn')?.addEventListener('click', async () => {
    if (!state.modalMatchId) return;
    const matchId = state.modalMatchId;
    const btn = $('email-reenrich-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Scoring…'; }
    try {
      await triggerReEnrich(matchId);
      // Refresh insights panel with updated match data
      const match = state.matches.find(m => m.id === matchId);
      if (match) openEmailModal(matchId); // re-open refreshes all fields
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Re-score'; }
    }
  });
  $('email-save-btn')?.addEventListener('click', saveEmailDraft);
  $('email-save-template-btn')?.addEventListener('click', saveAsTemplate);
  $('email-copy-btn')?.addEventListener('click', copyEmailDraft);
  $('email-rewrite-btn')?.addEventListener('click', async () => {
    if (!state.modalMatchId) return;
    const matchId = state.modalMatchId;
    const btn = $('email-rewrite-btn');
    const bodyEl = $('modal-body-text');
    const subjectEl = $('modal-subject');
    const prevBody = bodyEl?.value || '';
    const prevSubject = subjectEl?.value || '';
    if (btn) { btn.disabled = true; btn.textContent = 'Writing…'; }
    if (bodyEl) { bodyEl.disabled = true; bodyEl.placeholder = 'Writing your pitch…'; }
    try {
      const data = await apiPost('/api/generate-pitch', { matchId });
      if (data.success) {
        if (subjectEl) subjectEl.value = data.subject || '';
        if (bodyEl)    bodyEl.value    = data.body    || '';
        updateMatchInState(matchId, { email_subject: data.subject, email_body: data.body });
        showToast('Pitch generated!', 'success');
      } else {
        if (subjectEl) subjectEl.value = prevSubject;
        if (bodyEl)    bodyEl.value    = prevBody;
        showToast(data.error || 'Could not generate pitch. Try again.', 'error');
      }
    } catch {
      if (subjectEl) subjectEl.value = prevSubject;
      if (bodyEl)    bodyEl.value    = prevBody;
      showToast('Network error. Please try again.', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Rewrite Pitch'; }
      if (bodyEl) { bodyEl.disabled = false; bodyEl.placeholder = 'Your pitch email…'; }
    }
  });
  $('email-sent-myself-btn')?.addEventListener('click', async () => {
    if (!state.modalMatchId) return;
    const id = state.modalMatchId;
    closeEmailModal();
    await markAsPitched(id);
  });
  $('email-restore-btn')?.addEventListener('click', async () => {
    if (!state.modalMatchId) return;
    const id = state.modalMatchId;
    closeEmailModal();
    await restoreMatch(id);
  });
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

  // Template manager modal
  const tmModal = document.getElementById('template-manager-modal');
  tmModal?.addEventListener('click', (e) => { if (e.target === tmModal) closeTemplateManager(); });

  // Escape key closes any open modal
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (emailModal    && emailModal.style.display    !== 'none') closeEmailModal();
    if (contactModal  && contactModal.style.display  !== 'none') closeContactModal();
    if (templateModal && templateModal.style.display !== 'none') closeTemplateModal();
    const tmModal = document.getElementById('template-manager-modal');
    if (tmModal && tmModal.style.display !== 'none') closeTemplateManager();
  });
}

// ── Share Win modal ───────────────────────────────────────────────────
function showShareModal(matchId) {
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) return;
  const podcastName = match.podcasts?.title || 'a podcast';
  const text = `Just landed a podcast appearance on ${podcastName}. Excited to share my story with their audience. Find A Podcast made it happen → findapodcast.io #podcast #entrepreneur #personalbrand`;
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
  window.open('https://www.linkedin.com/sharing/share-offsite/?url=https://findapodcast.io&summary=' + encodeURIComponent(t.value), '_blank');
}
window.shareToLinkedIn = shareToLinkedIn;

// ── Follow-up sequence presets ────────────────────────────────────────
const FOLLOWUP_SEQUENCES = {
  followup1: {
    subject: (p) => `Quick follow-up: ${p} guest spot`,
    body: (p) => `Hi [Host Name],\n\nJust wanted to follow up on my pitch to join you on ${p}.\n\nI know inboxes get busy. Happy to send any extra info that would help make the decision easier.\n\nLooking forward to potentially connecting!\n\nBest,\n[Your Name]`,
  },
  followup2: {
    subject: (p) => `One more thought: ${p}`,
    body: (p) => `Hi [Host Name],\n\nFollowing up once more on my pitch for ${p}. I wanted to share a quick thought that might be relevant for your audience:\n\n[Add a specific insight, stat, or story relevant to their show's topic]\n\nI think this angle could make for a really compelling episode. Would love to explore it with you.\n\nBest,\n[Your Name]`,
  },
  followup3: {
    subject: (p) => `Last note: ${p} collaboration`,
    body: (p) => `Hi [Host Name],\n\nI'll keep this short. Last follow-up on my pitch to appear on ${p}.\n\nIf the timing isn't right, no worries at all. If you'd ever like to revisit it down the track, I'd love to hear from you.\n\nWishing you and the show continued success!\n\nBest,\n[Your Name]`,
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

// ── Inline follow-up panel ────────────────────────────────────────────
function toggleFollowUpPanel(matchId) {
  const panel = $(`followup-panel-${matchId}`);
  if (!panel) return;
  const isOpen = panel.style.display === 'block';
  if (isOpen) { panel.style.display = 'none'; return; }
  expandCard(matchId);
  document.querySelectorAll('.inline-pitch-panel, .social-dm-panel').forEach(p => { if (p !== panel) p.style.display = 'none'; });
  panel.style.display = 'block';
  populateFollowUpPanel(matchId);
}
window.toggleFollowUpPanel = toggleFollowUpPanel;

function populateFollowUpPanel(matchId) {
  const match = state.matches.find(m => m.id === matchId);
  if (!match) return;
  const saved = localStorage.getItem(`followup_template_${matchId}`);
  let subject, body;
  if (saved) { try { ({ subject, body } = JSON.parse(saved)); } catch { subject = null; } }
  const subjEl = $(`followup-subj-${matchId}`);
  const bodyEl = $(`followup-body-${matchId}`);
  if (subject && body) {
    if (subjEl) subjEl.value = subject;
    if (bodyEl) bodyEl.value = body;
  } else {
    // No saved content — auto-generate
    setTimeout(() => rewriteFollowUp(matchId), 100);
  }
}

async function rewriteFollowUp(matchId) {
  const btn    = $(`followup-rewrite-btn-${matchId}`);
  const subjEl = $(`followup-subj-${matchId}`);
  const bodyEl = $(`followup-body-${matchId}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Writing...'; }
  if (bodyEl) { bodyEl.placeholder = 'Writing your follow-up...'; bodyEl.disabled = true; }
  try {
    const data = await apiPost('/api/generate-followup', { matchId });
    if (data.success && data.body) {
      if (subjEl) subjEl.value = data.subject || '';
      if (bodyEl) bodyEl.value = data.body;
      showToast('Follow-up ready.', 'success');
    } else {
      showToast(data.error || 'Could not generate follow-up.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate'; }
    if (bodyEl) { bodyEl.placeholder = 'Your follow-up message…'; bodyEl.disabled = false; }
  }
}
window.rewriteFollowUp = rewriteFollowUp;

function applyFollowUpSequenceInline(matchId) {
  const match = state.matches.find(m => m.id === matchId);
  const podcastName = match?.podcasts?.title || 'the podcast';
  const seq  = $(`followup-seq-${matchId}`)?.value;
  if (!seq || seq === 'custom') return;
  const preset = FOLLOWUP_SEQUENCES[seq];
  if (!preset) return;
  const subjEl = $(`followup-subj-${matchId}`);
  const bodyEl = $(`followup-body-${matchId}`);
  if (subjEl) subjEl.value = preset.subject(podcastName);
  if (bodyEl) bodyEl.value = preset.body(podcastName);
}
window.applyFollowUpSequenceInline = applyFollowUpSequenceInline;

async function sendFollowUpFromPanel(matchId) {
  const subject = $(`followup-subj-${matchId}`)?.value.trim() || '';
  const body    = $(`followup-body-${matchId}`)?.value.trim()  || '';
  if (!body) { showToast('Write your follow-up message first.', 'error'); return; }
  // Save to localStorage
  localStorage.setItem(`followup_template_${matchId}`, JSON.stringify({ subject, body }));
  const btn = $(`followup-send-btn-${matchId}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
  try {
    const data = await apiPost('/api/send-followup', { matchId, subject, body });
    if (data.success) {
      showToast(data.gmailSent ? 'Follow-up sent.' : 'Follow-up saved (Gmail not connected).', 'success');
      updateMatchInState(matchId, { status: 'followed_up' });
      updateStatBadges();
      toggleFollowUpPanel(matchId);
      switchToFilter('followed_up');
    } else {
      showToast(data.error || 'Send failed.', 'error');
    }
  } catch { showToast('Network error. Please try again.', 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Send Follow Up'; } }
}
window.sendFollowUpFromPanel = sendFollowUpFromPanel;

// ── Follow-up modal — redirected to inline panel ──────────────────────
function showFollowUpModal(matchId) {
  // Old modal replaced by inline panel — redirect silently
  toggleFollowUpPanel(matchId);
  return;
  // eslint-disable-next-line no-unreachable
  void matchId;
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
  if (!subject) subject = `Following up: ${podcastName} guest appearance`;
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
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Send Follow Up'; } }
}
window.sendFollowUp = sendFollowUp;


// ── Gmail disconnect ──────────────────────────────────────────────────
function connectGmail() {
  window.location.href = `/auth/gmail?clientId=${esc(state.client.id)}`;
}

async function disconnectGmail() {
  if (!confirm('Disconnect Gmail? Pitches will no longer send from your inbox until you reconnect.')) return;
  try {
    const data = await apiPost('/api/gmail/disconnect', {});
    if (data.success) {
      state.client.gmail_email = null;
      state.client.gmail_refresh_token = null;
      // Re-render dropdown
      const gmailItem = $('dropdown-gmail-item');
      if (gmailItem) {
        gmailItem.style.cursor = 'pointer';
        gmailItem.innerHTML = `<a href="/auth/gmail?clientId=${esc(state.client.id)}" style="color:var(--accent);text-decoration:none;font-size:13px;display:flex;align-items:center;gap:5px;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/></svg>
          Connect Gmail
        </a>`;
      }
      showToast('Gmail disconnected. Click Connect Gmail to reconnect.', 'success');
    } else {
      showToast(data.error || 'Failed to disconnect.', 'error');
    }
  } catch {
    showToast('Failed to disconnect Gmail.', 'error');
  }
}

// ── Expose globals for inline onclick handlers ────────────────────────
window.disconnectGmail   = disconnectGmail;
window.approveMatch      = approveMatch;
window.restoreMatch      = restoreMatch;
window.markAsPitched     = markAsPitched;
window.dismissMatch      = dismissMatch;
window.confirmDismiss    = confirmDismiss;
window.sendMatch         = sendMatch;
window.bookMatch         = bookMatch;
window.unbookMatch       = unbookMatch;
window.confirmUnbook     = confirmUnbook;
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
  window.open('https://findapodcast.io/review', '_blank');
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
    showToast('You\'re on the waitlist. We\'ll email you when it launches.', 'success');
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
  if (state.demo?.active) { openUpgradeModal(); return; }
  const url  = document.getElementById('add-podcast-url').value.trim();
  const name = document.getElementById('add-podcast-name').value.trim();
  if (!url && !name) { showToast('Please enter a podcast URL or name.', 'error'); return; }
  const btn = document.getElementById('add-podcast-btn');
  if (btn) { btn.textContent = 'Adding…'; btn.disabled = true; }
  try {
    const g = (id) => { const el = document.getElementById(id); return el?.value.trim() || null; };
    const data = await apiPost('/api/add-podcast', {
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
      if (data.message === 'Already in your pipeline.') {
        showToast('Already in your pipeline.', 'info');
        switchToFilter('new');
        return;
      }
      showToast('Added! Scoring compatibility. Ready in ~10 seconds.', 'info');
      // Add to state immediately as placeholder, then refresh to get real scores
      if (data.match && data.podcast) {
        state.matches.unshift({ ...data.match, podcasts: data.podcast });
        switchToFilter('new');
        renderGrid();
        updateStatBadges();
      }
      // Re-fetch dashboard after 10s so scored values appear
      setTimeout(async () => {
        try {
          const fresh = await apiFetch(`/api/dashboard/${state.token}`);
          if (fresh?.matches) {
            state.matches = fresh.matches;
            renderGrid();
            updateStatBadges();
            showToast('Scoring complete!', 'success');
          }
        } catch { /* silent */ }
      }, 10000);
      // Also kick a reply scan now — covers the workflow where the customer
      // already emailed this contact from Gmail before adding the podcast,
      // so the new 'new' match flips to 'sent' or 'replied' immediately.
      setTimeout(() => { try { checkForReplies(); } catch {} }, 1500);
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

// ── Find a Stage (Coming Soon waitlist modal) ─────────────────────────────
function openFindAStageModal() {
  const existing = document.getElementById('stage-waitlist-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'stage-waitlist-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px;';
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  const clientEmail = (state.client && state.client.email) || '';

  modal.innerHTML = `
    <div style="background:#fff;border-radius:18px;padding:36px 32px 28px;max-width:480px;width:100%;box-shadow:0 30px 80px rgba(0,0,0,0.3);">
      <div style="display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,rgba(99,102,241,0.12),rgba(139,92,246,0.12));color:#6366f1;padding:5px 12px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:0.06em;margin-bottom:16px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2l2.4 7.4H22l-6.2 4.6 2.4 7.4L12 16.8 5.8 21.4l2.4-7.4L2 9.4h7.6z"/></svg>
        FIND A STAGE · COMING SOON
      </div>
      <h2 style="font-size:22px;font-weight:900;letter-spacing:-0.02em;margin-bottom:8px;">Every Call-for-Speakers in your area.</h2>
      <p style="color:#6e6e73;font-size:14px;line-height:1.6;margin-bottom:22px;">Same verified-contact pipeline as Find A Podcast — pointed at conferences, summits, and keynote stages in your city. Drop your details below to get early access the moment it opens.</p>
      <form id="stage-waitlist-form" onsubmit="submitStageWaitlist(event)">
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">
          <label style="font-size:11px;font-weight:700;color:#6e6e73;text-transform:uppercase;letter-spacing:0.05em;">Email</label>
          <input type="email" name="email" required value="${esc(clientEmail)}" placeholder="you@example.com" style="padding:10px 14px;border:1.5px solid rgba(0,0,0,0.1);border-radius:10px;font-size:14px;font-family:inherit;" />
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">
          <label style="font-size:11px;font-weight:700;color:#6e6e73;text-transform:uppercase;letter-spacing:0.05em;">Your city</label>
          <input type="text" name="city" placeholder="e.g. Austin, TX" style="padding:10px 14px;border:1.5px solid rgba(0,0,0,0.1);border-radius:10px;font-size:14px;font-family:inherit;" />
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">
          <label style="font-size:11px;font-weight:700;color:#6e6e73;text-transform:uppercase;letter-spacing:0.05em;">Industry / niche</label>
          <input type="text" name="industry" placeholder="e.g. SaaS, fitness coaching, personal finance" style="padding:10px 14px;border:1.5px solid rgba(0,0,0,0.1);border-radius:10px;font-size:14px;font-family:inherit;" />
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px;">
          <button type="button" onclick="document.getElementById('stage-waitlist-modal').remove()" style="background:#fff;border:1.5px solid rgba(0,0,0,0.1);padding:10px 18px;border-radius:999px;font-size:14px;font-weight:700;cursor:pointer;">Close</button>
          <button type="submit" id="stage-waitlist-btn" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;padding:10px 22px;border-radius:999px;font-size:14px;font-weight:700;cursor:pointer;">Get Early Access</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(modal);
}

async function submitStageWaitlist(e) {
  e.preventDefault();
  const form = e.target;
  const btn = document.getElementById('stage-waitlist-btn');
  btn.disabled = true;
  btn.textContent = 'Joining…';
  try {
    const r = await fetch('/api/stages/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: form.email.value.trim(),
        city: form.city.value.trim(),
        industry: form.industry.value.trim(),
        clientToken: state.token || location.pathname.split('/').pop(),
      }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error);
    document.getElementById('stage-waitlist-modal').innerHTML = `
      <div style="background:#fff;border-radius:18px;padding:40px 32px;max-width:440px;width:100%;text-align:center;box-shadow:0 30px 80px rgba(0,0,0,0.3);">
        <div style="font-size:44px;margin-bottom:10px;">🎤</div>
        <h2 style="font-size:22px;font-weight:900;margin-bottom:10px;">You're in.</h2>
        <p style="color:#6e6e73;font-size:14px;line-height:1.6;margin-bottom:22px;">We'll email you the moment Find a Stage opens for your niche. You'll be first in line.</p>
        <button onclick="document.getElementById('stage-waitlist-modal').remove()" style="background:#0f172a;color:#fff;border:none;padding:10px 26px;border-radius:999px;font-size:14px;font-weight:700;cursor:pointer;">Got it</button>
      </div>`;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Get Early Access';
    alert('Could not save — try again.');
  }
}
window.openFindAStageModal = openFindAStageModal;
window.submitStageWaitlist = submitStageWaitlist;

// ── Manual reply check (bypasses visibility gate, shows feedback) ─────
async function checkRepliesNow(event) {
  if (event) event.preventDefault();
  const btn = event?.currentTarget;
  const orig = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 1s linear infinite;"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg> Checking…';
  }
  try {
    const data = await apiPost('/api/gmail/check-replies', { token: state.token });
    if (!data.gmailConnected) { showToast('Connect Gmail first.', 'error'); return; }
    const updated = (data.updated || []).length;
    if (updated > 0) {
      showToast(`Found ${updated} new repl${updated === 1 ? 'y' : 'ies'} — refreshing…`, 'success');
      const fresh = await apiFetch(`/api/dashboard/${state.token}`);
      if (fresh?.matches) state.matches = fresh.matches;
      data.updated.forEach((id) => updateMatchInState(id, { status: 'replied' }));
      renderGrid();
    } else {
      showToast('Checked — no new replies in your inbox.', 'success');
    }
  } catch {
    showToast('Could not check right now. Try again in a moment.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}
window.checkRepliesNow = checkRepliesNow;

// ── Thread modal (Phase B reply pipeline) ─────────────────────────────
let _activeThreadMatchId = null;

async function openThreadModal(matchId) {
  if (!matchId) return;
  _activeThreadMatchId = matchId;
  const modal = document.getElementById('thread-modal');
  const titleEl = document.getElementById('thread-modal-title');
  const subEl = document.getElementById('thread-modal-subtitle');
  const listEl = document.getElementById('thread-messages');
  const subjectEl = document.getElementById('thread-reply-subject');
  const bodyEl = document.getElementById('thread-reply-body');
  if (!modal || !listEl) return;

  modal.style.display = 'flex';
  listEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-tertiary);font-size:14px;">Loading conversation…</div>';
  if (subjectEl) subjectEl.value = '';
  if (bodyEl) bodyEl.value = '';

  try {
    const r = await fetch(`/api/thread/${matchId}`, { headers: { 'x-dashboard-token': state.token } });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'fetch_failed');

    const m = data.match || {};
    titleEl.textContent = m.podcast_title || 'Conversation';
    subEl.textContent = m.host_name ? `with ${m.host_name}${m.host_email ? ' · ' + m.host_email : ''}` : (m.host_email || '');

    // Hide bounce notifications — they pollute the conversation view.
    const messages = (data.messages || []).filter(m => m.message_type !== 'bounce');
    if (messages.length === 0) {
      listEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-tertiary);font-size:14px;">No messages in this thread yet.</div>';
    } else {
      listEl.innerHTML = messages.map(renderThreadMessage).join('');
      // Scroll to newest at the bottom
      listEl.scrollTop = listEl.scrollHeight;
    }

    // Pre-fill subject with Re: latest subject
    const latest = messages[messages.length - 1];
    let lastSubject = (latest?.subject || '').trim();
    // Strip bracket prefixes like [Support Ticket #123] or [Maxwell Leadership Support]
    lastSubject = lastSubject.replace(/^\[[^\]]*\]\s*/, '').trim();
    // Strip trailing colons, semicolons — they suggest a truncated or automated subject
    lastSubject = lastSubject.replace(/[;:]$/, '').trim();
    if (subjectEl) subjectEl.value = lastSubject.toLowerCase().startsWith('re:') ? lastSubject : (lastSubject ? `Re: ${lastSubject}` : '');

    // Mark as read (zero unread count + clear seen badge)
    fetch(`/api/thread/${matchId}/mark-read`, { method: 'POST', headers: { 'x-dashboard-token': state.token } }).catch(() => {});
    const seenKey = `seen_replied_${state.token}`;
    const seen = new Set(JSON.parse(localStorage.getItem(seenKey) || '[]'));
    seen.add(matchId);
    localStorage.setItem(seenKey, JSON.stringify([...seen]));
  } catch (err) {
    listEl.innerHTML = `<div style="padding:40px;text-align:center;color:#ef4444;font-size:14px;">Could not load thread (${esc(err.message || 'error')}).</div>`;
  }
}
window.openThreadModal = openThreadModal;

function closeThreadModal() {
  _activeThreadMatchId = null;
  const modal = document.getElementById('thread-modal');
  if (modal) modal.style.display = 'none';
}
window.closeThreadModal = closeThreadModal;

function renderThreadMessage(msg) {
  const isOutbound = msg.direction === 'outbound';
  const align = isOutbound ? 'flex-end' : 'flex-start';
  const bg = isOutbound ? 'linear-gradient(135deg,#6366f1,#8b5cf6)' : 'var(--surface-card)';
  const color = isOutbound ? '#fff' : 'var(--text-primary)';
  const border = isOutbound ? 'none' : '1px solid var(--border-light)';
  const fromShort = (msg.from_email || '').split('<').pop().replace('>', '').trim() || (isOutbound ? 'You' : 'Host');
  const when = msg.sent_at ? new Date(msg.sent_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  let body = (msg.body_text || '').trim();
  if (!body && msg.body_html) {
    body = msg.body_html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<p[^>]*>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  if (!body) body = '(no body captured)';
  const typeBadge = msg.message_type === 'pitch' ? 'Initial pitch'
                  : msg.message_type === 'followup' ? 'Follow-up'
                  : msg.message_type === 'host_reply' ? 'Reply from host'
                  : msg.message_type === 'customer_reply' ? 'Your reply'
                  : isOutbound ? 'Sent by you' : 'From host';

  return `
    <div style="display:flex;justify-content:${align};margin-bottom:14px;">
      <div style="max-width:86%;background:${bg};color:${color};border:${border};border-radius:14px;padding:12px 16px;box-shadow:${isOutbound ? '0 2px 8px rgba(99,102,241,0.18)' : '0 1px 2px rgba(0,0,0,0.04)'};">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:14px;margin-bottom:6px;font-size:11px;font-weight:600;opacity:0.85;">
          <span>${esc(typeBadge)}${msg.subject ? ' · ' + esc(msg.subject.slice(0, 60)) : ''}</span>
          <span style="font-weight:500;opacity:0.75;white-space:nowrap;">${esc(when)}</span>
        </div>
        <div style="font-size:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word;">${esc(body).replace(/\n/g, '<br>')}</div>
        ${!isOutbound && msg.from_email ? `<div style="margin-top:8px;font-size:11px;opacity:0.7;">${esc(fromShort)}</div>` : ''}
      </div>
    </div>
  `;
}

async function sendThreadReply() {
  if (!_activeThreadMatchId) return;
  const subjectEl = document.getElementById('thread-reply-subject');
  const bodyEl = document.getElementById('thread-reply-body');
  const sendBtn = document.getElementById('thread-send-btn');
  if (!bodyEl || !sendBtn) return;

  const body = (bodyEl.value || '').trim();
  if (!body) { showToast('Write a reply before sending.', 'error'); return; }

  sendBtn.disabled = true;
  const orig = sendBtn.innerHTML;
  sendBtn.innerHTML = 'Sending…';

  try {
    const data = await apiPost(`/api/reply/${_activeThreadMatchId}`, {
      subject: subjectEl?.value || '',
      body,
    });
    if (!data.ok) throw new Error(data.error || 'send_failed');

    showToast('Reply sent.', 'success');
    // Re-open the modal to show the new message at the bottom
    const id = _activeThreadMatchId;
    closeThreadModal();
    setTimeout(() => openThreadModal(id), 200);
  } catch (err) {
    showToast('Could not send: ' + (err.message || 'error'), 'error');
  } finally {
    sendBtn.disabled = false;
    sendBtn.innerHTML = orig;
  }
}
window.sendThreadReply = sendThreadReply;

// AI-draft reply (Phase C): Claude reads the FULL thread + customer profile
// and drafts a contextual reply responding to the latest inbound message.
async function draftReplyWithAI() {
  const btn = document.getElementById('thread-ai-draft-btn');
  if (!btn || !_activeThreadMatchId) return;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Drafting…';
  try {
    const data = await apiPost(`/api/draft-reply/${_activeThreadMatchId}`, {});
    if (!data.ok) throw new Error(data.error || 'draft_failed');
    const bodyEl = document.getElementById('thread-reply-body');
    if (bodyEl) {
      bodyEl.value = data.body || '';
      bodyEl.focus();
      bodyEl.setSelectionRange(bodyEl.value.length, bodyEl.value.length);
    }
    showToast('Draft ready. Edit and send.', 'success');
  } catch (err) {
    showToast('AI draft failed. Type your reply manually.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}
window.draftReplyWithAI = draftReplyWithAI;

// Override the openMatchDetail fallback so the Your-Move CTA opens the thread modal directly
window.openMatchDetail = function(id) { openThreadModal(id); };

// ── Credits counter (live monthly balance) ─────────────────────────────
async function loadCredits() {
  if (!state.token) return;
  try {
    const r = await fetch('/api/credits/balance', { headers: { 'x-dashboard-token': state.token } });
    if (!r.ok) return;
    const data = await r.json();
    if (!data.ok) return;

    const wrap = document.getElementById('credits-counter');
    const val  = document.getElementById('credits-counter-value');
    const lbl  = document.getElementById('credits-counter-label');
    if (!wrap || !val || !lbl) return;

    if (data.unlimited) {
      val.textContent = '∞';
      lbl.textContent = 'unlimited';
      wrap.style.background = 'linear-gradient(135deg,rgba(139,92,246,0.18),rgba(99,102,241,0.12))';
      wrap.style.borderColor = 'rgba(139,92,246,0.4)';
    } else {
      val.textContent = data.credits ?? 0;
      lbl.textContent = 'credits';
      // Color-code: green > 100, yellow 50-100, red < 50
      if (data.credits >= 100) {
        wrap.style.background = 'linear-gradient(135deg,rgba(16,185,129,0.10),rgba(99,102,241,0.08))';
        wrap.style.borderColor = 'rgba(16,185,129,0.30)';
      } else if (data.credits >= 50) {
        wrap.style.background = 'linear-gradient(135deg,rgba(245,158,11,0.10),rgba(99,102,241,0.08))';
        wrap.style.borderColor = 'rgba(245,158,11,0.35)';
      } else {
        wrap.style.background = 'linear-gradient(135deg,rgba(239,68,68,0.12),rgba(245,158,11,0.08))';
        wrap.style.borderColor = 'rgba(239,68,68,0.4)';
      }
    }
    state.credits = data;
    wrap.style.display = 'inline-flex';
  } catch {}
}
window.loadCredits = loadCredits;

// ── Credits modal (history + top-up CTA) ───────────────────────────────
function openCreditsModal() {
  const credits   = state.credits?.credits ?? 0;
  const unlimited = !!state.credits?.unlimited;
  const resetsAt  = state.credits?.resets_at;
  const resetText = resetsAt ? new Date(resetsAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : 'next month';

  const html = `
    <div style="background:var(--bg-secondary,#fff);border-radius:16px;padding:28px;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:20px;">
        <div>
          <div style="font-size:12px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.08em;">Your Credits</div>
          <div style="font-size:48px;font-weight:900;color:var(--accent,#6366f1);letter-spacing:-0.03em;line-height:1;margin-top:4px;">${unlimited ? '∞' : credits}</div>
          <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;">${unlimited ? 'Unlimited (Tour plan)' : `Resets ${resetText}`}</div>
        </div>
        <button onclick="closeCreditsModal()" style="background:none;border:none;font-size:24px;color:var(--text-tertiary);cursor:pointer;">×</button>
      </div>
      ${unlimited ? '' : `
        <div style="background:var(--bg-tertiary,rgba(99,102,241,0.05));border-radius:10px;padding:14px 16px;margin-bottom:16px;">
          <div style="font-size:12px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">What credits cost</div>
          <div style="font-size:13px;line-height:1.7;color:var(--text-secondary);">
            <div>• Send pitch / follow-up: <strong style="color:var(--text-primary);">1 credit</strong></div>
            <div>• Find more shows (10 podcasts): <strong style="color:var(--text-primary);">10 credits</strong></div>
            <div>• Unlock contact info: <strong style="color:var(--text-primary);">1 credit</strong></div>
            <div>• AI-generated pitch / interview prep: <strong style="color:var(--text-primary);">1 credit</strong></div>
          </div>
        </div>
        <div style="font-size:12px;font-weight:700;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;">Top up now — credits added the moment you pay</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px;">
          <button onclick="buyCreditPack('small')" style="background:var(--bg-tertiary,rgba(99,102,241,0.05));border:1.5px solid var(--border-light);border-radius:10px;padding:14px 6px;cursor:pointer;text-align:center;">
            <div style="font-size:18px;font-weight:900;color:var(--text-primary);">50</div>
            <div style="font-size:10px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.06em;margin-top:1px;">credits</div>
            <div style="font-size:13px;font-weight:700;color:var(--accent);margin-top:6px;">$25</div>
          </button>
          <button onclick="buyCreditPack('medium')" style="background:linear-gradient(135deg,rgba(99,102,241,0.08),rgba(139,92,246,0.08));border:1.5px solid var(--accent);border-radius:10px;padding:14px 6px;cursor:pointer;text-align:center;position:relative;">
            <span style="position:absolute;top:-7px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;font-size:9px;font-weight:800;padding:2px 8px;border-radius:999px;letter-spacing:0.05em;">BEST</span>
            <div style="font-size:18px;font-weight:900;color:var(--text-primary);">200</div>
            <div style="font-size:10px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.06em;margin-top:1px;">credits</div>
            <div style="font-size:13px;font-weight:700;color:var(--accent);margin-top:6px;">$80</div>
          </button>
          <button onclick="buyCreditPack('large')" style="background:var(--bg-tertiary,rgba(99,102,241,0.05));border:1.5px solid var(--border-light);border-radius:10px;padding:14px 6px;cursor:pointer;text-align:center;">
            <div style="font-size:18px;font-weight:900;color:var(--text-primary);">500</div>
            <div style="font-size:10px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.06em;margin-top:1px;">credits</div>
            <div style="font-size:13px;font-weight:700;color:var(--accent);margin-top:6px;">$175</div>
          </button>
        </div>
        <div style="font-size:11px;color:var(--text-tertiary);text-align:center;line-height:1.5;">Secure checkout via Stripe. Credits never expire.</div>
      `}
    </div>
  `;

  let modal = document.getElementById('credits-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'credits-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
    modal.onclick = (e) => { if (e.target === modal) closeCreditsModal(); };
    document.body.appendChild(modal);
  }
  modal.innerHTML = html;
  modal.style.display = 'flex';
}
function closeCreditsModal() {
  const modal = document.getElementById('credits-modal');
  if (modal) modal.style.display = 'none';
}
async function buyCreditPack(pack) {
  try {
    const data = await apiPost('/api/credits/topup-checkout', { pack });
    if (data.ok && data.url) {
      window.location.href = data.url;
    } else if (data.error === 'stripe_not_configured') {
      showToast('Checkout temporarily unavailable. Email hi@zacdeane.com.', 'error');
    } else {
      showToast(data.error || 'Could not start checkout. Try again.', 'error');
    }
  } catch {
    showToast('Network error. Please try again.', 'error');
  }
}
window.openCreditsModal = openCreditsModal;
window.closeCreditsModal = closeCreditsModal;
window.buyCreditPack    = buyCreditPack;
window.closeCreditsModal = closeCreditsModal;

// ── Out-of-credits handler — wired into apiPost wrapper ────────────────
function handleInsufficientCredits(data) {
  const balance = data.balance ?? 0;
  const needed  = data.needed ?? 1;
  showToast(`Out of credits (have ${balance}, need ${needed}). Top-up packs coming soon — email hi@zacdeane.com to add credits.`, 'error');
  setTimeout(() => openCreditsModal(), 800);
}
window.handleInsufficientCredits = handleInsufficientCredits;

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
      // Re-fetch fresh match data so reply_count/last_reply_at fields are up to date
      try {
        const fresh = await apiFetch(`/api/dashboard/${state.token}`);
        if (fresh?.matches) {
          state.matches = fresh.matches;
        }
      } catch { /* silent — use stale state if fetch fails */ }

      // Also apply status updates for any new-to-replied matches
      data.updated.forEach((matchId) => {
        const existing = state.matches.find((m) => m.id === matchId);
        if (existing && existing.status !== 'replied') {
          updateMatchInState(matchId, { status: 'replied' });
        }
      });

      renderGrid();
      updateStatBadges(); // tab-count badge goes red automatically via unseenRepliedCount
      updateHeaderReplyDot();
      showToast(`A host has replied to your pitch. Head to Host Replied and lock in the booking.`, 'success');
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
      showToast('Refresh failed. Try again.', 'error');
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
  const subj  = encodeURIComponent(subject || 'Support Request: Find A Podcast');
  window.location.href = `mailto:hi@findapodcast.io?subject=${subj}&body=${body}`;
  closeSupportModal();
  showToast('Opening your email client with the message pre-filled.', 'success');
}
window.openSupportModal  = openSupportModal;
window.closeSupportModal = closeSupportModal;
window.sendSupportEmail  = sendSupportEmail;
window.openProfileModal  = openProfileModal;
window.closeProfileModal = closeProfileModal;
window.saveProfile       = saveProfile;
window.toggleTheme       = toggleTheme;
window.runPipeline       = runPipeline;
window.bulkRescore       = bulkRescore;

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
  initPushNotifications();

  // Handle Stripe redirect back to dashboard
  const params = new URLSearchParams(window.location.search);
  if (params.get('boost') === 'success') {
    showToast('Content Boost purchased! Our team will be in touch shortly.', 'success');
    // Clean URL without reload
    window.history.replaceState({}, '', window.location.pathname);
  } else if (params.get('boost') === 'cancelled') {
    showToast('No worries. You can upgrade anytime from your Booked tab.', 'info');
    window.history.replaceState({}, '', window.location.pathname);
  }
}

// ── Push Notifications ────────────────────────────────────────
async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (!state.token) return;

  try {
    // Fetch VAPID public key
    const keyRes = await fetch('/api/push/vapid-key');
    const keyData = await keyRes.json();
    if (!keyData.success || !keyData.publicKey) return; // not configured yet

    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    // Check existing subscription
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      // Only ask for permission if not already denied
      if (Notification.permission === 'denied') return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
      });
    }

    // Register with backend
    await fetch('/api/push/subscribe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-dashboard-token': state.token },
      body:    JSON.stringify({ subscription: sub.toJSON() }),
    });
  } catch (_) { /* non-blocking */ }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
