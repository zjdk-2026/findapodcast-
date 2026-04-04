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
    appeared:  'Appeared',
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
  const repliedCount = state.matches.filter((m) => m.status === 'replied').length;
  const newCount     = state.matches.filter((m) => m.status === 'new').length;

  const chips = [];
  if (repliedCount > 0) {
    chips.push(`<span class="stat-chip stat-chip-blue">${repliedCount} new repl${repliedCount === 1 ? 'y' : 'ies'}</span>`);
  }
  if (bookedCount > 0) {
    chips.push(`<span class="stat-chip stat-chip-green">${bookedCount} booked</span>`);
  }
  if (newCount > 0) {
    chips.push(`<span class="stat-chip stat-chip-purple">${newCount} new match${newCount === 1 ? '' : 'es'}</span>`);
  }

  heroEl.innerHTML = `
    <div class="hero-greeting">
      <div class="hero-greeting-name">${greeting}, ${esc(name.split(' ')[0])} 👋</div>
      ${chips.length > 0 ? `<div class="hero-chips">${chips.join('')}</div>` : ''}
    </div>`;
}

// ── Stats strip (this month) — legacy kept for bookMatch calls ────────
function renderStatsStrip() {
  renderHeroSection();
}

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

function startContentBoostCheckout() {
  closeContentBoostModal();
  window.open('https://buy.stripe.com/00waEX7Dqekt8B70EL8IU0L', '_blank');
}
window.startContentBoostCheckout = startContentBoostCheckout;
window.closeContentBoostModal = closeContentBoostModal;

// ── Render stats ──────────────────────────────────────────────────────
function renderStats(stats) {
  const set = (id, val) => { const el = $(id); if (el) el.textContent = val ?? '0'; };
  set('stat-total',    stats.total);
  set('stat-high',     stats.high);
  set('stat-avg',      stats.avgScore ?? '—');
  set('stat-sent',     stats.sent);
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
  return `
    <div class="score-row">
      <span class="score-row-label" title="${esc(tip)}" style="cursor:help;">${esc(label)}${tip ? ' <span style="font-size:10px;opacity:0.5;border:1px solid currentColor;border-radius:50%;width:13px;height:13px;display:inline-flex;align-items:center;justify-content:center;margin-left:3px;">?</span>' : ''}</span>
      <div class="score-bar-track">
        <div class="score-bar-fill ${v >= 70 ? 'high' : v >= 40 ? 'mid' : 'low'}" style="width:${v}%"></div>
      </div>
      <span class="score-row-value">${v}</span>
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
  if (isValidUrl(podcast.spotify_url))       chips.push(`<a class="contact-chip" href="${esc(podcast.spotify_url)}" target="_blank" rel="noopener">Spotify</a>`);
  if (isValidUrl(podcast.apple_url))         chips.push(`<a class="contact-chip" href="${esc(podcast.apple_url)}" target="_blank" rel="noopener">Apple</a>`);

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
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="dismissMatch('${id}')">Not a Fit</button>`);
  } else if (status === 'approved') {
    if (hasEmail) {
      buttons.push(`<button class="btn btn-action-send btn-xs btn-action-primary" onclick="sendMatch('${id}')">🚀 Send Pitch</button>`);
      buttons.push(`<button class="btn btn-action-view btn-xs" onclick="openEmailModal('${id}')">Preview Email</button>`);
    } else {
      buttons.push(`<span style="font-size:12px;color:var(--text-tertiary);font-style:italic;">✍️ Writing your pitch…</span>`);
    }
    buttons.push(`<button class="btn btn-action-book btn-xs" onclick="bookMatch('${id}')">🎉 It's Booked!</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="dismissMatch('${id}')">Not a Fit</button>`);
  } else if (status === 'dream') {
    buttons.push(`<button class="btn btn-action-send btn-xs btn-action-primary" onclick="sendMatch('${id}')">🚀 Send Pitch</button>`);
    buttons.push(`<button class="btn btn-action-book btn-xs" onclick="bookMatch('${id}')">🎉 It's Booked!</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="dismissMatch('${id}')">Not a Fit</button>`);
  } else if (status === 'sent') {
    buttons.push(`<button class="btn btn-action-book btn-xs btn-action-primary" onclick="bookMatch('${id}')">🎉 It's Booked!</button>`);
    buttons.push(`<button class="btn btn-action-followup btn-xs" onclick="showFollowUpModal('${id}')">📩 Send Follow Up</button>`);
    if (hasEmail) buttons.push(`<button class="btn btn-action-view btn-xs" onclick="openEmailModal('${id}')">View Pitch</button>`);
  } else if (status === 'replied') {
    buttons.push(`<button class="btn btn-action-book btn-xs btn-action-primary" onclick="bookMatch('${id}')">🎉 It's Booked!</button>`);
    buttons.push(`<button class="btn btn-action-followup btn-xs" onclick="showFollowUpModal('${id}')">📩 Send Another Follow Up</button>`);
    if (hasEmail) buttons.push(`<button class="btn btn-action-view btn-xs" onclick="openEmailModal('${id}')">View Thread</button>`);
  } else if (status === 'booked') {
    buttons.push(`<button class="btn btn-action-prep btn-xs btn-action-primary" onclick="showInterviewPrepModal('${id}')">🎙️ Prepare for Interview</button>`);
    buttons.push(`<button class="btn btn-action-appeared btn-xs" onclick="markAppeared('${id}')">✅ Episode Aired</button>`);
    buttons.push(`<button class="btn btn-action-share btn-xs" onclick="showShareModal('${id}')">🏆 Share Win</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="dismissMatch('${id}')">❌ Not Booked</button>`);
  } else if (status === 'appeared') {
    buttons.push(`<button class="btn btn-action-share btn-xs btn-action-primary" onclick="showShareModal('${id}')">🏆 Share My Win</button>`);
    buttons.push(`<button class="btn btn-action-send btn-xs" onclick="showContentBoostModal('${id}')">🚀 Content Boost</button>`);
  } else if (status === 'dismissed') {
    buttons.push(`<button class="btn btn-restore btn-xs" onclick="restoreMatch('${id}')">↩ Restore to New</button>`);
  }

  return buttons.join('');
}

// ── Toggle card expand ────────────────────────────────────────────────
function toggleCardExpand(matchId) {
  const card = $(`card-${matchId}`);
  if (!card) return;
  const isExpanded = card.getAttribute('data-expanded') === 'true';
  card.setAttribute('data-expanded', isExpanded ? 'false' : 'true');
}
window.toggleCardExpand = toggleCardExpand;

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
          ${podcast.contact_email ? `<a class="card-link-chip" href="#" onclick="copyEmail(event,'${esc(podcast.contact_email)}')" title="Copy email"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> Email</a>` : ''}
          ${podcast.website ? `<a class="card-link-chip" href="${esc(podcast.website)}" target="_blank" rel="noopener"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Web</a>` : ''}
          ${podcast.spotify_url ? `<a class="card-link-chip" href="${esc(podcast.spotify_url)}" target="_blank" rel="noopener">Spotify</a>` : ''}
          ${podcast.apple_url ? `<a class="card-link-chip" href="${esc(podcast.apple_url)}" target="_blank" rel="noopener">Apple</a>` : ''}
          ${podcast.youtube_url ? `<a class="card-link-chip" href="${esc(podcast.youtube_url)}" target="_blank" rel="noopener">YouTube</a>` : ''}
          ${podcast.guest_application_url ? `<a class="card-link-chip card-link-chip-primary" href="${esc(podcast.guest_application_url)}" target="_blank" rel="noopener">Apply</a>` : podcast.booking_page_url ? `<a class="card-link-chip card-link-chip-primary" href="${esc(podcast.booking_page_url)}" target="_blank" rel="noopener">Book</a>` : ''}
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

    <!-- Contact chips -->
    ${contactChipsHtml(podcast)}

    <!-- Social chips -->
    ${socialHtml}

    <!-- Pitch + Notes buttons row -->
    <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;">

    <!-- Pitch section -->
    <div class="card-pitch-section" id="pitch-area-${esc(match.id)}" style="flex:1;min-width:0;">
      <button class="pitch-toggle-btn ${match.email_subject ? 'pitch-toggle-btn-saved' : ''}" onclick="togglePitchArea('${esc(match.id)}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        ${match.email_subject ? 'View / Edit Pitch Email' : 'Write My Pitch Email'}
        ${match.email_subject ? '<span class="pitch-saved-badge">Saved</span>' : '<span class="pitch-ai-badge">AI</span>'}
      </button>
      <div class="note-editor" id="pitch-editor-${esc(match.id)}" style="display:none;">
        <label class="pitch-field-label">Subject Line</label>
        <select class="subject-preset-select" id="pitch-subject-select-${esc(match.id)}" onchange="applySubjectPreset('${esc(match.id)}')" style="margin-bottom:6px;">
          <option value="">— Choose a subject line —</option>
          <option value="Guest inquiry — ${esc(podcast.title || 'your show')}">Guest inquiry — ${esc(podcast.title || 'your show')}</option>
          <option value="Enquiry: Guest appearance on ${esc(podcast.title || 'your show')}">Enquiry: Guest appearance on ${esc(podcast.title || 'your show')}</option>
          <option value="Speaker/guest pitch — ${esc(podcast.title || 'your show')}">Speaker/guest pitch — ${esc(podcast.title || 'your show')}</option>
          <option value="I'd love to be a guest on ${esc(podcast.title || 'your show')}">I'd love to be a guest on ${esc(podcast.title || 'your show')}</option>
          <option value="Guest feature request — ${esc(podcast.title || 'your show')}">Guest feature request — ${esc(podcast.title || 'your show')}</option>
          <option value="Collaboration enquiry: ${esc(podcast.title || 'your show')}">Collaboration enquiry: ${esc(podcast.title || 'your show')}</option>
          <option value="__custom__">✏️ Write my own…</option>
        </select>
        <input type="text" class="note-textarea" id="pitch-subject-custom-${esc(match.id)}" placeholder="Type your custom subject line…" style="display:none;margin-bottom:6px;padding:8px 10px;" value="${esc(match.email_subject || '')}" />
        <label class="pitch-field-label">Pitch Email Body</label>
        <textarea class="note-textarea" id="pitch-body-${esc(match.id)}" rows="7" placeholder="Your pitch email…">${esc(match.email_body || '')}</textarea>
        <div class="note-actions" style="gap:8px;flex-wrap:wrap;margin-top:10px;">
          <button class="btn btn-primary btn-xs" onclick="savePitch('${esc(match.id)}')">Save</button>
          <button class="btn btn-action-send btn-xs" onclick="sendMatch('${esc(match.id)}')">🚀 Send Pitch</button>
          <button class="btn btn-secondary btn-xs" onclick="copyPitch('${esc(match.id)}')">Copy</button>
          <button class="btn btn-outline btn-xs" onclick="regeneratePitch('${esc(match.id)}')">✦ Generate with AI</button>
          <button class="btn btn-ghost btn-xs" onclick="togglePitchArea('${esc(match.id)}')">Close</button>
        </div>
      </div>
    </div>

    <!-- Notes -->
    <div class="card-pitch-section" id="notes-area-${esc(match.id)}" style="flex-shrink:0;">
      ${match.client_notes ? `<div class="note-display">${esc(match.client_notes)}</div>` : ''}
      <button class="pitch-toggle-btn" onclick="toggleNoteArea('${esc(match.id)}')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        ${match.client_notes ? 'Edit Note' : 'Notes'}
      </button>
      <div class="note-editor" id="note-editor-${esc(match.id)}">
        <textarea class="note-textarea" id="note-text-${esc(match.id)}" rows="2" placeholder="Jot down anything — what you pitched, follow-up dates, host contact info…">${esc(match.client_notes || '')}</textarea>
        <div class="note-actions">
          <button class="btn btn-primary btn-xs" onclick="saveNote('${esc(match.id)}')">Save</button>
          <button class="btn btn-ghost btn-xs" onclick="toggleNoteArea('${esc(match.id)}')">Cancel</button>
        </div>
      </div>
    </div>

    </div><!-- /.pitch-notes-row -->

        <!-- Footer: action buttons -->
        <div class="card-footer">
          ${actionButtonsHtml(match)}
        </div>

      </div><!-- /.card-expanded-inner -->
    </div><!-- /.card-expanded -->

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
      if (mScore > eScore || (mScore === eScore && mHasData && !eHasData)) {
        byTitle.set(key, m);
      }
    }
  }
  let matches = [...byTitle.values()];

  if (state.filter !== 'all') {
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

  // Show reply badge if there are already replied matches
  const repliedCount = (matches || []).filter(m => m.status === 'replied').length;
  const badge = document.getElementById('reply-badge');
  if (badge) {
    if (repliedCount > 0) { badge.textContent = repliedCount; badge.style.display = 'inline-flex'; }
    else { badge.style.display = 'none'; }
  }

  // Client header
  const clientNameEl = $('client-name');
  const clientSubEl  = $('client-subtitle');
  if (clientNameEl) clientNameEl.textContent = client.name || 'Your Pipeline';
  if (clientSubEl) {
    clientSubEl.style.display = 'none';
  }
  const lastRunBadge = $('last-run-badge');
  if (lastRunBadge) {
    lastRunBadge.textContent = client.last_run_at
      ? `Last updated ${new Date(client.last_run_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
      : '';
  }

  // Navbar right: profile dropdown trigger
  const navbarRight = $('navbar-right');
  if (navbarRight) {
    navbarRight.innerHTML = `
      <button class="profile-trigger" id="profile-trigger" onclick="toggleProfileDropdown()">
        ${esc(client.name || 'Account')} <span style="opacity:0.5;font-size:11px;">▾</span>
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
  const themeItem = $('theme-toggle-item');
  if (themeItem) {
    const isLight = document.documentElement.classList.contains('light-mode');
    themeItem.textContent = isLight ? 'Dark Mode' : 'Light Mode';
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
  const highCount = state.matches.filter((m) => (m.fit_score || 0) >= 80).length;
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
      banner.textContent = 'Gmail connected successfully! Draft emails will now be created automatically.';
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
  renderStatsStrip();

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
    high:     m.filter((x) => (x.fit_score || 0) >= 80).length,
    avgScore: m.length > 0
      ? Math.round(m.reduce((s, x) => s + (x.fit_score || 0), 0) / m.length)
      : 0,
    approved: m.filter((x) => x.status === 'approved').length,
    sent:     m.filter((x) => x.status === 'sent').length,
    booked:   m.filter((x) => x.status === 'booked').length,
  });
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
        renderStatsStrip();
        showToast('🎉 Booked! Moved to your Booked tab.', 'success');
        showContentBoostModal();
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
      showToast('🌟 Marked as appeared!', 'success');
    } else {
      showToast(data.error || 'Failed.', 'error');
    }
  } catch { showToast('Network error.', 'error'); }
  finally { setCardLoading(matchId, false); }
}
window.markAppeared = markAppeared;

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

async function autoGeneratePitch(matchId, bodyEl, subjectEl) {
  bodyEl.value = '';
  bodyEl.placeholder = 'Writing your pitch…';
  bodyEl.disabled = true;
  try {
    const data = await apiPost('/api/generate-pitch', { matchId });
    if (data.success) {
      if (subjectEl) subjectEl.value = data.subject || '';
      bodyEl.value = data.body || '';
      bodyEl.placeholder = 'Your pitch email…';
      updateMatchInState(matchId, { email_subject: data.subject, email_body: data.body });
    } else {
      bodyEl.placeholder = 'Could not generate — write manually or try again.';
      showToast(data.error || 'Could not generate pitch.', 'error');
    }
  } catch {
    bodyEl.placeholder = 'Network error — write manually or try again.';
    showToast('Network error generating pitch.', 'error');
  } finally {
    bodyEl.disabled = false;
  }
}

async function regeneratePitch(matchId) {
  const bodyEl   = $(`pitch-body-${matchId}`);
  const subjectEl = $(`pitch-subject-select-${matchId}`);
  if (!bodyEl) return;
  bodyEl.value = '✨ Generating pitch in your voice…';
  if (subjectEl) subjectEl.value = '';
  try {
    const data = await apiPost('/api/generate-pitch', { matchId });
    if (data.success) {
      if (subjectEl) subjectEl.value = data.subject || '';
      bodyEl.value = data.body || '';
      updateMatchInState(matchId, { email_subject: data.subject, email_body: data.body });
      showToast('Pitch generated!', 'success');
    } else {
      bodyEl.value = '';
      showToast(data.error || 'Could not generate pitch.', 'error');
    }
  } catch {
    bodyEl.value = '';
    showToast('Network error.', 'error');
  }
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
    if (podcast.guest_application_url) chips.push(`<a class="contact-chip" href="${esc(podcast.guest_application_url)}" target="_blank">Apply as Guest</a>`);
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
          ${contactRowHtml('', 'Apply', p.guest_application_url, p.guest_application_url, true)}
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

  btn.disabled = true;
  $('profile-dropdown').style.display = 'none';
  const steps = [
    'Activating AI matching engine…',
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
        btn.textContent = 'Find Me Podcasts';
        btn.disabled = false;
        return;
      }
      showToast(`Pipeline complete — checking for new matches…`, 'success');
      pollForNewMatches();
    } else {
      showToast('Pipeline run failed.', 'error');
    }
  } catch { showToast('Network error running pipeline.', 'error'); }
  finally { clearInterval(stepInterval); btn.textContent = 'Find Me Podcasts'; btn.disabled = false; }
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

// ── Vision Board ──────────────────────────────────────────────────────
function renderVisionBoard(client) {
  const section  = document.getElementById('vision-board-section');
  const skeleton = document.getElementById('vision-board-skeleton');
  const imgWrap  = document.getElementById('vision-board-img-wrap');
  const img      = document.getElementById('vision-board-img');
  const prompt   = document.getElementById('vision-board-prompt');
  if (!section) return;

  const hasProfileData = client.life_purpose || client.best_in_world_at;

  if (client.vision_board_url) {
    // Image ready — show it
    section.style.display = 'block';
    if (skeleton) skeleton.style.display = 'none';
    if (imgWrap)  { imgWrap.style.display = 'block'; }
    if (img)      img.src = client.vision_board_url;
    if (prompt)   prompt.style.display = 'none';

  } else if (window._visionBoardGenerating) {
    // Currently generating — show skeleton, start polling
    section.style.display = 'block';
    if (skeleton) skeleton.style.display = 'flex';
    if (imgWrap)  imgWrap.style.display = 'none';
    if (prompt)   prompt.style.display = 'none';

    if (!window._visionBoardPollTimer) {
      window._visionBoardPollTimer = setInterval(async () => {
        try {
          const res = await fetch(`/api/vision-board/status`, {
            headers: { 'x-dashboard-token': state.token }
          });
          const data = await res.json();
          if (data.imageUrl) {
            clearInterval(window._visionBoardPollTimer);
            window._visionBoardPollTimer = null;
            window._visionBoardGenerating = false;
            state.client.vision_board_url = data.imageUrl;
            renderVisionBoard(state.client);
            showToast('🎨 Your vision board is ready!', 'success');
          }
        } catch { /* keep polling */ }
      }, 8000);
    }

  } else if (hasProfileData) {
    // Has profile data but no image — auto-trigger generation
    section.style.display = 'block';
    if (skeleton) skeleton.style.display = 'flex';
    if (imgWrap)  imgWrap.style.display = 'none';
    if (prompt)   prompt.style.display = 'none';
    window._visionBoardGenerating = true;

    // Kick off generation in background
    apiPost('/api/vision-board/generate', { token: state.token }).then((data) => {
      if (data.success && data.imageUrl) {
        window._visionBoardGenerating = false;
        state.client.vision_board_url = data.imageUrl;
        renderVisionBoard(state.client);
        showToast('🎨 Your vision board is ready!', 'success');
      } else if (data.cooldown) {
        // Cooldown but no image — hide section
        window._visionBoardGenerating = false;
        section.style.display = 'none';
      } else {
        window._visionBoardGenerating = false;
        section.style.display = 'none';
      }
    }).catch(() => {
      window._visionBoardGenerating = false;
      section.style.display = 'none';
    });

  } else {
    // No profile data — show unlock prompt
    section.style.display = 'block';
    if (skeleton) skeleton.style.display = 'none';
    if (imgWrap)  imgWrap.style.display = 'none';
    if (prompt)   prompt.style.display = 'flex';
  }
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

    const res = await fetch('/api/upload-photo', { method: 'POST', body: formData });
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
  $('profile-name').value      = c.name        || '';
  $('profile-title').value     = c.title       || '';
  $('profile-business').value  = c.business_name || '';
  $('profile-website').value   = c.website     || '';
  $('profile-booking').value   = c.booking_link || '';
  $('profile-leadmagnet').value = c.lead_magnet || '';
  $('profile-instagram').value = c.social_instagram || '';
  $('profile-linkedin').value  = c.social_linkedin  || '';
  $('profile-twitter').value   = c.social_twitter   || '';
  $('profile-tone').value      = c.preferred_tone   || 'warm-professional';
  $('profile-daily').value     = c.daily_target      || 10;
  $('profile-topics').value    = (c.topics         || []).join(', ');
  $('profile-angles').value    = (c.speaking_angles || []).join(', ');
  $('profile-audience').value  = c.target_audience  || '';
  $('profile-bio-short').value = c.bio_short        || '';
  $('profile-bio-long').value  = c.bio_long         || '';

  // Vision board fields
  const bestInWorld = document.getElementById('profile-best-in-world');
  const lifePurpose = document.getElementById('profile-life-purpose');
  const unlimitedRes = document.getElementById('profile-unlimited-resources');
  const profileVisualVibe = document.getElementById('profile-visual-vibe');
  const profileColorPrimary = document.getElementById('profile-color-primary');
  const profileColorPrimaryHex = document.getElementById('profile-color-primary-hex');
  const profileColorSecondary = document.getElementById('profile-color-secondary');
  const profileColorSecondaryHex = document.getElementById('profile-color-secondary-hex');
  if (bestInWorld)   bestInWorld.value   = c.best_in_world_at    || '';
  if (lifePurpose)   lifePurpose.value   = c.life_purpose        || '';
  if (unlimitedRes)  unlimitedRes.value  = c.unlimited_resources || '';
  const currentVibe = c.visual_vibe || 'bold-professional';
  if (profileVisualVibe) profileVisualVibe.value = currentVibe;
  document.querySelectorAll('#profile-vibe-selector .vibe-pill').forEach((p) => {
    p.classList.toggle('active', p.dataset.vibe === currentVibe);
  });
  const pPrimary = c.brand_color_primary || '#6C3EFF';
  const pSecondary = c.brand_color_secondary || '#F59E0B';
  if (profileColorPrimary)    profileColorPrimary.value    = pPrimary;
  if (profileColorPrimaryHex) profileColorPrimaryHex.value = pPrimary;
  if (profileColorSecondary)    profileColorSecondary.value    = pSecondary;
  if (profileColorSecondaryHex) profileColorSecondaryHex.value = pSecondary;

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
    lead_magnet:      $('profile-leadmagnet').value.trim(),
    social_instagram: $('profile-instagram').value.trim(),
    social_linkedin:  $('profile-linkedin').value.trim(),
    social_twitter:   $('profile-twitter').value.trim(),
    preferred_tone:   $('profile-tone').value,
    daily_target:     parseInt($('profile-daily').value, 10) || 10,
    topics:           splitTrim($('profile-topics').value),
    speaking_angles:  splitTrim($('profile-angles').value),
    target_audience:  $('profile-audience').value.trim(),
    bio_short:        $('profile-bio-short').value.trim(),
    bio_long:         $('profile-bio-long').value.trim(),
    best_in_world_at:    (document.getElementById('profile-best-in-world')?.value || '').trim() || null,
    life_purpose:        (document.getElementById('profile-life-purpose')?.value   || '').trim() || null,
    unlimited_resources: (document.getElementById('profile-unlimited-resources')?.value || '').trim() || null,
    visual_vibe:         document.getElementById('profile-visual-vibe')?.value || 'bold-professional',
    brand_color_primary:   document.getElementById('profile-color-primary-hex')?.value || '#6C3EFF',
    brand_color_secondary: document.getElementById('profile-color-secondary-hex')?.value || '#F59E0B',
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
      if (trigger) trigger.innerHTML = `${esc(state.client.name)} <span style="opacity:0.5;font-size:11px;">▾</span>`;
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
  showToast('Template cleared — will use default AI template.', 'info');
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
    // Clear reply badge when Host Replied tab is clicked
    if (tab.dataset.status === 'replied') {
      const badge = document.getElementById('reply-badge');
      if (badge) badge.style.display = 'none';
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
      closeFollowUpModal();
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
  document.getElementById('add-podcast-url').value = '';
  document.getElementById('add-podcast-name').value = '';
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
    const data = await apiPost('/api/operator/add-podcast', {
      clientId: state.client?.id,
      podcastUrl: url || null,
      podcastName: name || null,
    });
    if (data.success) {
      closeAddPodcastModal();
      showToast('🎉 Podcast added to your New tab!', 'success');
      // Add to state and re-render
      if (data.match && data.podcast) {
        state.matches.unshift({ ...data.match, podcasts: data.podcast });
        switchToFilter('new');
      }
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
  try {
    const data = await apiPost('/api/gmail/check-replies', { token: state.token });
    if (data.success && data.updated?.length) {
      data.updated.forEach((matchId) => updateMatchInState(matchId, { status: 'replied' }));
      renderGrid();
      // Show red badge on Host Replied tab
      const badge = document.getElementById('reply-badge');
      if (badge) {
        badge.textContent = data.updated.length;
        badge.style.display = 'inline-flex';
      }
      // Flash toast and auto-switch to Host Replied tab
      showToast(`📬 ${data.updated.length} host${data.updated.length > 1 ? 's have' : ' has'} replied to your pitch!`, 'success');
      switchToFilter('replied');
    }
  } catch {
    // Silently fail — not critical
  }
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
