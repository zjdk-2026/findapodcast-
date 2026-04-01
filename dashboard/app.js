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
  filter:         'all',
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
    dismissed: 'Dismissed',
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

// ── Render stats ──────────────────────────────────────────────────────
function renderStats(stats) {
  const set = (id, val) => { const el = $(id); if (el) el.textContent = val ?? '0'; };
  set('stat-total',    stats.total);
  set('stat-high',     stats.high);
  set('stat-avg',      stats.avgScore ?? '—');
  set('stat-approved', stats.approved);
  set('stat-sent',     stats.sent);
  set('stat-booked',   stats.booked);
}

// ── Score bar HTML ────────────────────────────────────────────────────
function scoreBarHtml(label, value) {
  const v   = Math.round(value || 0);
  const cls = scoreColorClass(v);
  return `
    <div class="score-row">
      <span class="score-row-label">${esc(label)}</span>
      <div class="score-bar-track">
        <div class="score-bar-fill ${cls}" style="width:${v}%"></div>
      </div>
      <span class="score-row-value" style="color:${scoreColorVar(v)}">${v}</span>
    </div>`;
}

// ── Contact chips HTML ────────────────────────────────────────────────
function contactChipsHtml(podcast) {
  const chips = [];
  if (podcast.contact_email) {
    chips.push(`<a class="contact-chip" href="mailto:${esc(podcast.contact_email)}" title="${esc(podcast.contact_email)}">✉ ${esc(podcast.contact_email)}</a>`);
  }
  if (podcast.website) {
    chips.push(`<a class="contact-chip" href="${esc(podcast.website)}" target="_blank" rel="noopener">🌐 Website</a>`);
  }
  if (podcast.booking_page_url) {
    chips.push(`<a class="contact-chip" href="${esc(podcast.booking_page_url)}" target="_blank" rel="noopener">📅 Booking</a>`);
  }
  if (podcast.guest_application_url) {
    chips.push(`<a class="contact-chip" href="${esc(podcast.guest_application_url)}" target="_blank" rel="noopener">📝 Apply</a>`);
  }
  return chips.length > 0
    ? `<div class="card-contact">${chips.join('')}</div>`
    : `<div class="card-contact"><span class="text-muted" style="font-size:12px;">No contact info found</span></div>`;
}

// ── Social chips HTML ─────────────────────────────────────────────────
function socialChipsHtml(podcast) {
  const chips = [];
  if (podcast.instagram_url)     chips.push(`<a class="contact-chip" href="${esc(podcast.instagram_url)}" target="_blank" rel="noopener">📸 Instagram</a>`);
  if (podcast.twitter_url)       chips.push(`<a class="contact-chip" href="${esc(podcast.twitter_url)}" target="_blank" rel="noopener">🐦 Twitter/X</a>`);
  if (podcast.facebook_url)      chips.push(`<a class="contact-chip" href="${esc(podcast.facebook_url)}" target="_blank" rel="noopener">👥 Facebook</a>`);
  if (podcast.linkedin_page_url) chips.push(`<a class="contact-chip" href="${esc(podcast.linkedin_page_url)}" target="_blank" rel="noopener">💼 LinkedIn</a>`);
  if (podcast.linkedin_url)      chips.push(`<a class="contact-chip" href="${esc(podcast.linkedin_url)}" target="_blank" rel="noopener">💼 LinkedIn</a>`);
  if (podcast.tiktok_url)        chips.push(`<a class="contact-chip" href="${esc(podcast.tiktok_url)}" target="_blank" rel="noopener">🎵 TikTok</a>`);
  return chips.length > 0 ? `<div class="card-contact">${chips.join('')}</div>` : '';
}

// ── Meta tags HTML ────────────────────────────────────────────────────
function metaTagsHtml(podcast) {
  const tags = [];
  if (podcast.total_episodes) tags.push(`${podcast.total_episodes} eps`);
  if (podcast.last_episode_date) {
    const days = Math.round((Date.now() - new Date(podcast.last_episode_date).getTime()) / 86400000);
    tags.push(`${days}d ago`);
  }
  if (podcast.language && podcast.language !== 'English') tags.push(podcast.language);
  if (podcast.country) tags.push(podcast.country);
  if (podcast.listen_score) tags.push(`LS ${podcast.listen_score}`);
  if (podcast.has_guest_history) tags.push('Has Guests');
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

  if (hasEmail) {
    buttons.push(`<button class="btn btn-outline btn-xs" onclick="openEmailModal('${id}')">View Email</button>`);
  }

  if (status === 'new') {
    buttons.push(`<button class="btn btn-secondary btn-xs" onclick="approveMatch('${id}')">Approve</button>`);
    buttons.push(`<button class="btn btn-primary btn-xs" onclick="sendMatch('${id}')">Send Now</button>`);
    buttons.push(`<button class="btn btn-ghost btn-xs" onclick="dismissMatch('${id}')">Dismiss</button>`);
    buttons.push(`<button class="btn btn-gold btn-xs" onclick="bookMatch('${id}')">Mark Booked</button>`);
  } else if (status === 'approved') {
    buttons.push(`<button class="btn btn-primary btn-xs" onclick="sendMatch('${id}')">Send Now</button>`);
    buttons.push(`<button class="btn btn-ghost btn-xs" onclick="dismissMatch('${id}')">Dismiss</button>`);
    buttons.push(`<button class="btn btn-gold btn-xs" onclick="bookMatch('${id}')">Mark Booked</button>`);
  } else if (status === 'sent') {
    buttons.push(`<span style="font-size:11px;color:var(--text-tertiary);">Sent — awaiting reply</span>`);
    buttons.push(`<button class="btn btn-gold btn-xs" onclick="bookMatch('${id}')">Mark Booked</button>`);
  } else if (status === 'replied') {
    buttons.push(`<span style="font-size:11px;color:var(--warning);font-weight:600;">Replied ↩</span>`);
    buttons.push(`<button class="btn btn-gold btn-xs" onclick="bookMatch('${id}')">Mark Booked</button>`);
  } else if (status === 'booked') {
    buttons.push(`<span class="booked-badge">★ BOOKED ✓</span>`);
    buttons.push(`<button class="btn unbook-btn btn-xs" onclick="bookMatch('${id}')">✕ Undo</button>`);
  } else if (status === 'dismissed') {
    buttons.push(`<button class="btn btn-outline btn-xs" onclick="approveMatch('${id}')">Restore</button>`);
  }

  return buttons.join('');
}

// ── Render a single match card ────────────────────────────────────────
function renderMatchCard(match) {
  const podcast    = match.podcasts || {};
  const fitScore   = match.fit_score || 0;
  const tier       = scoreTier(fitScore);
  const tierClass  = `score-tier-${tier}`;
  const likeCls    = likelihoodClass(match.booking_likelihood);

  const redFlagsHtml = (match.red_flags && match.red_flags !== 'none')
    ? `<div>
        <p class="analysis-label">⚠ Red Flags</p>
        <p class="red-flags-text">${esc(match.red_flags)}</p>
       </div>`
    : '';

  const episodeHtml = (match.episode_to_reference && match.episode_to_reference !== 'none identified')
    ? `<div>
        <p class="analysis-label">Reference Episode</p>
        <p class="analysis-text">"${esc(match.episode_to_reference)}"</p>
       </div>`
    : '';

  const socialHtml = socialChipsHtml(podcast);

  return `
  <article class="match-card status-${esc(match.status)} ${tierClass}" id="card-${esc(match.id)}" data-status="${esc(match.status)}" data-score="${fitScore}">

    <!-- Header: title + status badge -->
    <div class="card-header">
      <div class="card-title-group">
        <h2 class="card-title" title="${esc(podcast.title)}" onclick="openContactModal('${esc(match.id)}')">${esc(podcast.title) || 'Unknown Show'}</h2>
        <div class="card-host-category">
          ${podcast.host_name ? `<span class="card-host">Hosted by ${esc(podcast.host_name)}</span>` : ''}
          ${podcast.category ? `<span class="category-tag">${esc(podcast.category)}</span>` : ''}
        </div>
      </div>
      <div style="flex-shrink:0;">
        ${statusBadgeHtml(match.status)}
      </div>
    </div>

    <!-- Fit score + bar -->
    <div class="fit-score-section">
      <div class="fit-score-header">
        <span class="fit-score-label">Fit Score</span>
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="${likeCls} likelihood-badge">${esc(match.booking_likelihood || '')}</span>
          <span class="fit-score-value" style="color:${scoreColorVar(fitScore)}">${fitScore}</span>
        </div>
      </div>
      <div class="fit-score-bar-track">
        <div class="fit-score-bar-fill score-bar-fill ${tier}" style="width:${fitScore}%"></div>
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
      <div>
        <p class="analysis-label">Best Pitch Angle</p>
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

    <!-- Notes -->
    <div class="card-notes" id="notes-area-${esc(match.id)}">
      ${match.client_notes
        ? `<div class="note-display">${esc(match.client_notes)}</div>`
        : ''}
      <button class="note-toggle-btn" onclick="toggleNoteArea('${esc(match.id)}')">
        ${match.client_notes ? 'Edit note' : '+ Add a note…'}
      </button>
      <div class="note-editor" id="note-editor-${esc(match.id)}">
        <textarea class="note-textarea" id="note-text-${esc(match.id)}" rows="2" placeholder="Add a private note…">${esc(match.client_notes || '')}</textarea>
        <div class="note-actions">
          <button class="btn btn-primary btn-xs" onclick="saveNote('${esc(match.id)}')">Save</button>
          <button class="btn btn-ghost btn-xs" onclick="toggleNoteArea('${esc(match.id)}')">Cancel</button>
        </div>
      </div>
    </div>

    <!-- Footer: action buttons -->
    <div class="card-footer">
      ${actionButtonsHtml(match)}
    </div>

  </article>`;
}

// ── Filter & sort ─────────────────────────────────────────────────────
function getFilteredSorted() {
  let matches = [...state.matches];

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

  // Client header
  const clientNameEl = $('client-name');
  const clientSubEl  = $('client-subtitle');
  if (clientNameEl) clientNameEl.textContent = client.name || 'Your Pipeline';
  if (clientSubEl) {
    const parts = [client.business_name, client.title].filter(Boolean);
    clientSubEl.textContent = parts.length > 0
      ? parts.join(' · ')
      : `${client.email || ''} · Last run: ${client.last_run_at ? new Date(client.last_run_at).toLocaleDateString() : 'Never'}`;
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
      gmailItem.innerHTML = `<span style="color:var(--success);font-size:13px;">✓ Gmail Connected</span>`;
      gmailItem.style.cursor = 'default';
    } else {
      gmailItem.innerHTML = `<a href="/auth/gmail?clientId=${esc(client.id)}" style="color:var(--accent);text-decoration:none;font-size:13px;">Connect Gmail</a>`;
    }
  }

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

  renderGrid();

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
      showToast('Match approved!', 'success');
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
      showToast('Match dismissed.', 'info');
    } else {
      showToast(data.error || 'Dismiss failed.', 'error');
    }
  } catch { showToast('Network error. Please try again.', 'error'); }
  finally  { setCardLoading(matchId, false); }
}

async function doSendMatch(matchId) {
  setCardLoading(matchId, true);
  try {
    const data = await apiPost('/api/send', { matchId });
    if (data.success) {
      updateMatchInState(matchId, { status: 'sent', sent_at: data.match?.sent_at });
      updateCard(matchId);
      updateStatBadges();
      showToast('Email sent successfully!', 'success');
    } else {
      showToast(data.error || 'Send failed.', 'error');
    }
  } catch { showToast('Network error. Please try again.', 'error'); }
  finally  { setCardLoading(matchId, false); }
}

function sendMatch(matchId) {
  // Show confirm modal, then send on confirm
  const overlay = $('confirm-modal');
  if (!overlay) { doSendMatch(matchId); return; }
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const confirmBtn = $('confirm-send-btn');
  // Remove any previous listener by cloning
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
        updateCard(matchId);
        updateStatBadges();
        showToast('Marked as booked!', 'success');
      } else {
        showToast(data.error || 'Book failed.', 'error');
      }
    }
  } catch { showToast('Network error. Please try again.', 'error'); }
  finally  { setCardLoading(matchId, false); }
}

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

  // Contact info row
  const contactRow = $('email-contact-row');
  if (contactRow) {
    const chips = [];
    if (podcast.contact_email)       chips.push(`<a class="contact-chip" href="mailto:${esc(podcast.contact_email)}">✉ ${esc(podcast.contact_email)}</a>`);
    if (podcast.website)             chips.push(`<a class="contact-chip" href="${esc(podcast.website)}" target="_blank">🌐 Website</a>`);
    if (podcast.booking_page_url)    chips.push(`<a class="contact-chip" href="${esc(podcast.booking_page_url)}" target="_blank">📅 Booking</a>`);
    if (podcast.guest_application_url) chips.push(`<a class="contact-chip" href="${esc(podcast.guest_application_url)}" target="_blank">📝 Apply</a>`);
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

function copyEmail() {
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
  if (p.instagram_url)     socialLinks.push(`<a href="${esc(p.instagram_url)}" target="_blank" class="social-link">📸 Instagram</a>`);
  if (p.twitter_url)       socialLinks.push(`<a href="${esc(p.twitter_url)}" target="_blank" class="social-link">🐦 Twitter/X</a>`);
  if (p.facebook_url)      socialLinks.push(`<a href="${esc(p.facebook_url)}" target="_blank" class="social-link">👥 Facebook</a>`);
  if (p.linkedin_page_url) socialLinks.push(`<a href="${esc(p.linkedin_page_url)}" target="_blank" class="social-link">💼 LinkedIn</a>`);
  if (p.linkedin_url)      socialLinks.push(`<a href="${esc(p.linkedin_url)}" target="_blank" class="social-link">💼 LinkedIn</a>`);
  if (p.tiktok_url)        socialLinks.push(`<a href="${esc(p.tiktok_url)}" target="_blank" class="social-link">🎵 TikTok</a>`);

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
          ${contactRowHtml('✉', 'Email', p.contact_email, `mailto:${p.contact_email}`, false)}
          ${contactRowHtml('🌐', 'Website', p.website, p.website, true)}
          ${contactRowHtml('📅', 'Booking', p.booking_page_url, p.booking_page_url, true)}
          ${contactRowHtml('📝', 'Apply', p.guest_application_url, p.guest_application_url, true)}
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
          ${p.total_episodes    ? `<span class="meta-tag">${p.total_episodes} episodes</span>` : ''}
          ${p.last_episode_date ? `<span class="meta-tag">Last: ${new Date(p.last_episode_date).toLocaleDateString()}</span>` : ''}
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

function toggleTheme() {
  const isLight = document.documentElement.classList.toggle('light-mode');
  localStorage.setItem('pp-theme', isLight ? 'light' : 'dark');
  const themeItem = $('theme-toggle-item');
  if (themeItem) themeItem.textContent = isLight ? 'Dark Mode' : 'Light Mode';
  $('profile-dropdown').style.display = 'none';
}

function copyDashboardLink() {
  navigator.clipboard.writeText(window.location.href)
    .then(() => showToast('Dashboard link copied!', 'success'))
    .catch(() => showToast('Could not copy link.', 'error'));
  $('profile-dropdown').style.display = 'none';
}

async function runPipeline() {
  const btn = $('header-run-pipeline');
  if (!btn || !state.client) return;
  btn.textContent = 'Running…';
  btn.disabled = true;
  $('profile-dropdown').style.display = 'none';
  try {
    const res  = await fetch(`/api/run/${state.client.id}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      if (data.capReached) {
        showToast(data.message, 'info');
        showUnlimitedUpsell();
        btn.textContent = 'Run Pipeline';
        btn.disabled = false;
        return;
      }
      showToast(`Pipeline complete — ${data.matchesFound} new matches found!`, 'success');
      setTimeout(() => location.reload(), 2000);
    } else {
      showToast('Pipeline run failed.', 'error');
    }
  } catch { showToast('Network error running pipeline.', 'error'); }
  finally { btn.textContent = 'Run Pipeline'; btn.disabled = false; }
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
  };
  try {
    const data = await apiPatch(`/api/onboard/${state.client.id}`, updates);
    if (data.success) {
      state.client = { ...state.client, ...data.client };
      showToast('Profile saved!', 'success');
      closeProfileModal();
      // Update name in nav
      const trigger = $('profile-trigger');
      if (trigger) trigger.innerHTML = `${esc(state.client.name)} <span style="opacity:0.5;font-size:11px;">▾</span>`;
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
  $('email-copy-btn')?.addEventListener('click', copyEmail);
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

// ── Expose globals for inline onclick handlers ────────────────────────
window.approveMatch      = approveMatch;
window.dismissMatch      = dismissMatch;
window.sendMatch         = sendMatch;
window.bookMatch         = bookMatch;
window.openEmailModal    = openEmailModal;
window.openContactModal  = openContactModal;
window.openTemplateModal = openTemplateModal;
window.toggleNoteArea    = toggleNoteArea;
window.saveNote          = saveNote;
window.showToast         = showToast;

// ── Init ──────────────────────────────────────────────────────────────
function init() {
  initFilterTabs();
  initSortSelect();
  initExtraFilters();
  initModals();
  loadDashboard();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
