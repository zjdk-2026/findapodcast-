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
    dismissed: 'Ignored',
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
function contactChipsHtml(podcast) {
  const chips = [];
  if (podcast.contact_email) {
    chips.push(`<a class="contact-chip" href="mailto:${esc(podcast.contact_email)}" title="${esc(podcast.contact_email)}">${esc(podcast.contact_email)}</a>`);
  }
  if (podcast.website) {
    chips.push(`<a class="contact-chip" href="${esc(podcast.website)}" target="_blank" rel="noopener">Website</a>`);
  }
  if (podcast.booking_page_url) {
    chips.push(`<a class="contact-chip" href="${esc(podcast.booking_page_url)}" target="_blank" rel="noopener">Booking Page</a>`);
  }
  if (podcast.guest_application_url) {
    chips.push(`<a class="contact-chip" href="${esc(podcast.guest_application_url)}" target="_blank" rel="noopener">Apply as Guest</a>`);
  }
  const social = socialChipsHtml(podcast);
  const all = [...chips, ...social];
  return all.length > 0
    ? `<div class="card-contact">${all.join('')}</div>`
    : `<div class="card-contact"><span class="text-muted" style="font-size:12px;">No contact info found</span></div>`;
}

// ── Social chips HTML ─────────────────────────────────────────────────
function socialChipsHtml(podcast) {
  const chips = [];
  if (podcast.apple_url)         chips.push(`<a class="contact-chip" href="${esc(podcast.apple_url)}" target="_blank" rel="noopener">Apple Podcasts</a>`);
  if (podcast.spotify_url)       chips.push(`<a class="contact-chip" href="${esc(podcast.spotify_url)}" target="_blank" rel="noopener">Spotify</a>`);
  if (podcast.youtube_url)       chips.push(`<a class="contact-chip" href="${esc(podcast.youtube_url)}" target="_blank" rel="noopener">YouTube</a>`);
  if (podcast.instagram_url)     chips.push(`<a class="contact-chip" href="${esc(podcast.instagram_url)}" target="_blank" rel="noopener">Instagram</a>`);
  if (podcast.twitter_url)       chips.push(`<a class="contact-chip" href="${esc(podcast.twitter_url)}" target="_blank" rel="noopener">Twitter/X</a>`);
  if (podcast.tiktok_url)        chips.push(`<a class="contact-chip" href="${esc(podcast.tiktok_url)}" target="_blank" rel="noopener">TikTok</a>`);
  if (podcast.facebook_url)      chips.push(`<a class="contact-chip" href="${esc(podcast.facebook_url)}" target="_blank" rel="noopener">Facebook</a>`);
  if (podcast.linkedin_page_url) chips.push(`<a class="contact-chip" href="${esc(podcast.linkedin_page_url)}" target="_blank" rel="noopener">LinkedIn</a>`);
  if (podcast.linkedin_url)      chips.push(`<a class="contact-chip" href="${esc(podcast.linkedin_url)}" target="_blank" rel="noopener">LinkedIn</a>`);
  return chips;
}

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
  if (podcast.country) tags.push(podcast.country);
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

  if (status === 'new') {
    if (hasEmail) {
      buttons.push(`<button class="btn btn-action-view btn-xs" onclick="openEmailModal('${id}')">View Email</button>`);
      buttons.push(`<button class="btn btn-action-send btn-xs" onclick="sendMatch('${id}')">Send Now</button>`);
    }
    buttons.push(`<button class="btn btn-action-pitched btn-xs" onclick="approveMatch('${id}')">Pitch Sent</button>`);
    buttons.push(`<button class="btn btn-action-book btn-xs" onclick="bookMatch('${id}')">It's Booked!</button>`);
    buttons.push(`<button class="btn btn-action-wish btn-xs" onclick="dreamMatch('${id}')">Wish List</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="dismissMatch('${id}')">Ignore</button>`);
  } else if (status === 'approved') {
    if (hasEmail) {
      buttons.push(`<button class="btn btn-action-view btn-xs" onclick="openEmailModal('${id}')">View Email</button>`);
      buttons.push(`<button class="btn btn-action-send btn-xs" onclick="sendMatch('${id}')">Send Now</button>`);
    } else {
      buttons.push(`<span style="font-size:12px;color:var(--text-tertiary);font-style:italic;">✍️ Email being written…</span>`);
    }
    buttons.push(`<button class="btn btn-action-book btn-xs" onclick="bookMatch('${id}')">It's Booked!</button>`);
    buttons.push(`<button class="btn btn-action-wish btn-xs" onclick="dreamMatch('${id}')">Wish List</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="dismissMatch('${id}')">Ignore</button>`);
  } else if (status === 'dream') {
    buttons.push(`<button class="btn btn-action-pitched btn-xs" onclick="approveMatch('${id}')">Pitch Sent</button>`);
    buttons.push(`<button class="btn btn-action-book btn-xs" onclick="bookMatch('${id}')">It's Booked!</button>`);
  } else if (status === 'sent') {
    if (hasEmail) {
      buttons.push(`<button class="btn btn-action-view btn-xs" onclick="openEmailModal('${id}')">View Email</button>`);
    }
    buttons.push(`<button class="btn btn-action-followup btn-xs" onclick="showFollowUpModal('${id}')">Follow Up</button>`);
    buttons.push(`<button class="btn btn-action-book btn-xs" onclick="bookMatch('${id}')">It's Booked!</button>`);
  } else if (status === 'replied') {
    if (hasEmail) {
      buttons.push(`<button class="btn btn-action-view btn-xs" onclick="openEmailModal('${id}')">View Email</button>`);
    }
    buttons.push(`<button class="btn btn-action-book btn-xs" onclick="bookMatch('${id}')">It's Booked!</button>`);
  } else if (status === 'booked') {
    buttons.push(`<button class="btn btn-action-prep btn-xs" onclick="showInterviewPrepModal('${id}')">Prep Me</button>`);
    buttons.push(`<button class="btn btn-action-appeared btn-xs" onclick="markAppeared('${id}')">I Appeared!</button>`);
    buttons.push(`<button class="btn btn-action-share btn-xs" onclick="showShareModal('${id}')">Share Win</button>`);
    buttons.push(`<button class="btn btn-action-ignore btn-xs" onclick="bookMatch('${id}')">↩ Undo</button>`);
  } else if (status === 'appeared') {
    buttons.push(`<button class="btn btn-action-share btn-xs" onclick="showShareModal('${id}')">🏆 Share My Win</button>`);
  } else if (status === 'dismissed') {
    buttons.push(`<button class="btn btn-action-pitched btn-xs" onclick="approveMatch('${id}')">↩ Restore</button>`);
  }

  return buttons.join('');
}

// ── Drag-and-drop state ───────────────────────────────────────────────
let isDragging = false;

// ── Toggle card expand ────────────────────────────────────────────────
function toggleCardExpand(matchId) {
  if (isDragging) return;
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

  const redFlagsHtml = (match.red_flags && match.red_flags !== 'none')
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
    <div class="card-row" draggable="true" onclick="toggleCardExpand('${esc(match.id)}')" ondragstart="handleCardDragStart(event,'${esc(match.id)}')" ondragend="handleCardDragEnd(event,'${esc(match.id)}')">
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
            const ll = listenersLabel(podcast.listen_score);
            if (ll) pills.push(`<span class="inline-pill inline-pill-accent">&#127909; ${ll}</span>`);
            return pills.join('');
          })()}
        </div>
        ${podcast.host_name ? `<div class="card-row-host">Hosted by ${esc(podcast.host_name)}</div>` : ''}
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

        <!-- Header: title + status badge -->
        <div class="card-header">
          <div class="card-title-group">
            <h2 class="card-title" title="${esc(podcast.title)}" onclick="openContactModal('${esc(match.id)}')">${esc(podcast.title) || 'Unknown Show'}</h2>
            <div class="card-host-category">
              ${podcast.host_name ? `<span class="card-host">Hosted by ${esc(podcast.host_name)}</span>` : ''}
              ${podcast.category && isNaN(podcast.category) ? `<span class="category-tag">${esc(podcast.category)}</span>` : ''}
              ${listenersLabel(podcast.listen_score) ? `<span class="category-tag" style="background:var(--accent-subtle);color:var(--accent);">🎧 ${listenersLabel(podcast.listen_score)}</span>` : ''}
            </div>
          </div>
          <div style="flex-shrink:0;">
            ${statusBadgeHtml(match.status)}
          </div>
        </div>

        <!-- Opportunity score + bar -->
        <div class="fit-score-section">
          <div class="fit-score-header">
            <span class="fit-score-label">Opportunity Score</span>
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

    <!-- Pitch section -->
    <div class="card-notes" id="pitch-area-${esc(match.id)}">
      <button class="note-toggle-btn" onclick="togglePitchArea('${esc(match.id)}')">
        ✍️ ${match.email_subject ? 'View / Edit Pitch' : 'Write My Pitch'}
      </button>
      <div class="note-editor" id="pitch-editor-${esc(match.id)}" style="display:none;">
        <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px;">Subject line</label>
        <select class="subject-preset-select" id="pitch-subject-select-${esc(match.id)}" onchange="applySubjectPreset('${esc(match.id)}')" style="margin-bottom:6px;">
          <option value="">— Choose a subject line template —</option>
          <option value="Guest inquiry — ${esc(podcast.title || 'your show')}">Guest inquiry — ${esc(podcast.title || 'your show')}</option>
          <option value="Enquiry: Guest appearance on ${esc(podcast.title || 'your show')}">Enquiry: Guest appearance on ${esc(podcast.title || 'your show')}</option>
          <option value="Speaker/guest pitch — ${esc(podcast.title || 'your show')}">Speaker/guest pitch — ${esc(podcast.title || 'your show')}</option>
          <option value="I'd love to be a guest on ${esc(podcast.title || 'your show')}">I'd love to be a guest on ${esc(podcast.title || 'your show')}</option>
          <option value="Guest feature request — ${esc(podcast.title || 'your show')}">Guest feature request — ${esc(podcast.title || 'your show')}</option>
          <option value="Collaboration enquiry: ${esc(podcast.title || 'your show')}">Collaboration enquiry: ${esc(podcast.title || 'your show')}</option>
        </select>
        <textarea class="note-textarea" id="pitch-body-${esc(match.id)}" rows="6" placeholder="Your pitch email…">${esc(match.email_body || '')}</textarea>
        <div class="note-actions" style="gap:6px;flex-wrap:wrap;">
          <button class="btn btn-primary btn-xs" onclick="savePitch('${esc(match.id)}')">💾 Save</button>
          <button class="btn btn-secondary btn-xs" onclick="copyPitch('${esc(match.id)}')">📋 Copy</button>
          <button class="btn btn-ghost btn-xs" onclick="togglePitchArea('${esc(match.id)}')">Close</button>
        </div>
      </div>
    </div>

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

      </div><!-- /.card-expanded-inner -->
    </div><!-- /.card-expanded -->

  </article>`;
}

// ── Filter & sort ─────────────────────────────────────────────────────
function getFilteredSorted() {
  // Deduplicate: first by podcast_id, then by title — keep highest fit_score
  const byId    = new Map();
  const byTitle = new Map();
  for (const m of state.matches) {
    const pid   = m.podcast_id || m.podcasts?.id;
    const title = (m.podcasts?.title || '').toLowerCase().trim();
    const key   = pid || title || m.id;
    const existing = byId.get(key);
    if (!existing || (m.fit_score || 0) > (existing.fit_score || 0)) {
      byId.set(key, m);
    }
  }
  // Second pass: dedup any remaining title duplicates (different podcast_ids, same title)
  const seenTitles = new Set();
  const deduped = [];
  for (const m of byId.values()) {
    const title = (m.podcasts?.title || '').toLowerCase().trim();
    if (title && seenTitles.has(title)) continue;
    if (title) seenTitles.add(title);
    deduped.push(m);
  }
  let matches = deduped;

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
function featuredPodcastCardHtml() {
  const id = 'featured-demo';
  return `
  <article class="match-card" id="card-${id}" data-expanded="false">
    <div class="card-row" onclick="toggleCardExpand('${id}')">
      <div class="card-row-left">
        <div class="card-row-title">
          The Breakthrough Moment Podcast
          <span class="inline-pill">Entrepreneurship</span>
        </div>
        <div class="card-row-host">Hosted by Zac Deane</div>
      </div>
      <div class="card-row-right">
        <span class="score-pill high">98</span>
        <span class="status-badge status-new">New</span>
        <span class="card-chevron">&#9658;</span>
      </div>
    </div>
    <div class="card-expanded" id="card-expanded-${id}">
      <div class="why-fits-box" style="margin-top:12px;">
        <p class="why-fits-label">About the Show</p>
        <p class="why-fits-text">For successful entrepreneurs and investors sharing the mindset, strategies, and breakthroughs behind building a life of impact and freedom.</p>
      </div>
      <div class="contact-chips" style="margin-top:10px;">
        <a href="https://open.spotify.com/show/7FBW99BOy9CavEse731bK5" target="_blank" class="contact-chip">&#127925; Spotify</a>
        <a href="https://www.youtube.com/playlist?list=PLRHjY10LU557fNgJU32VrLGQQnAk8s_LP" target="_blank" class="contact-chip">&#9654;&#65039; YouTube</a>
        <a href="mailto:hi@zacdeane.com" class="contact-chip">&#9993;&#65039; hi@zacdeane.com</a>
      </div>
      <div class="card-footer" style="margin-top:12px;">
        <button class="btn btn-action-view btn-xs" onclick="window.open('https://api.leadconnectorhq.com/widget/bookings/meeting-with-zac-deane-15-minute','_blank')">&#127908; Book a Chat</button>
        <button class="btn btn-action-send btn-xs" onclick="window.open('mailto:hi@zacdeane.com','_blank')">&#9993;&#65039; Email Me</button>
        <button class="btn btn-action-prep btn-xs" onclick="window.open('https://open.spotify.com/show/7FBW99BOy9CavEse731bK5','_blank')">&#127925; Listen Now</button>
      </div>
    </div>
  </article>`;
}

function renderGrid() {
  const grid      = $('cards-grid');
  const noResults = $('no-results');
  if (!grid) return;

  const filtered = getFilteredSorted();

  const FEATURED_TITLE = 'The Breakthrough Moment Podcast';
  const deduped = filtered.filter((m) => (m.podcasts?.title || '').trim() !== FEATURED_TITLE);
  const showFeatured = state.filter === 'all';

  if (deduped.length === 0) {
    grid.innerHTML = showFeatured ? featuredPodcastCardHtml() : '';
    if (noResults) noResults.style.display = deduped.length === 0 && !showFeatured ? 'block' : 'none';
  } else {
    if (noResults) noResults.style.display = 'none';
    grid.innerHTML = (showFeatured ? featuredPodcastCardHtml() : '') + deduped.map(renderMatchCard).join('');
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
    const lastRun = client.last_run_at
      ? `Last run ${new Date(client.last_run_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
      : 'Pipeline not yet run';
    clientSubEl.textContent = parts.length > 0
      ? `${parts.join(' · ')} · ${lastRun}`
      : lastRun;
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
      gmailItem.innerHTML = `<span style="color:var(--success);font-size:13px;">Gmail Connected</span>`;
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
  const match = state.matches.find((m) => m.id === matchId);
  const showName = match?.podcasts?.title || 'this podcast';
  const showNameEl = $('confirm-send-show-name');
  if (showNameEl) showNameEl.textContent = showName;
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
        renderStatsStrip();
        showToast('Marked as booked!', 'success');
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
  // subject is stored directly in the select value — nothing extra needed
}
window.applySubjectPreset = applySubjectPreset;

// ── Pitch generator ───────────────────────────────────────────────────
function togglePitchArea(matchId) {
  const editor = $(`pitch-editor-${matchId}`);
  if (!editor) return;
  const isVisible = editor.style.display !== 'none';
  editor.style.display = isVisible ? 'none' : 'flex';
  editor.style.flexDirection = 'column';
  if (!isVisible) {
    const match = state.matches.find((m) => m.id === matchId);
    const subjectEl = $(`pitch-subject-select-${matchId}`);
    if (subjectEl && !subjectEl.value) {
      const podcastName = match?.podcasts?.title || '';
      subjectEl.value = podcastName ? `Guest inquiry — ${podcastName}` : '';
    }
  }
}
window.togglePitchArea = togglePitchArea;

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
  const subject = subjectEl?.value.trim() || '';
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
  const text = `Subject: ${subjectEl?.value || ''}\n\n${bodyEl?.value || ''}`;
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
      contentEl.innerHTML = '';
      apiPost('/api/interview-prep', { matchId }).then((data) => {
        if (data.success && contentEl) {
          const prep = data.prep;
          contentEl.innerHTML = `
            <div class="prep-section"><strong>About the host</strong><p>${esc(prep.host_background||'')}</p></div>
            <div class="prep-section"><strong>Show format</strong><p>${esc(prep.show_format||'')}</p></div>
            <div class="prep-section"><strong>Suggested topics</strong><ul>${(prep.suggested_topics||[]).map(t=>`<li>${esc(t)}</li>`).join('')}</ul></div>
            <div class="prep-section"><strong>Likely questions</strong><ul>${(prep.likely_questions||[]).map(q=>`<li>${esc(q)}</li>`).join('')}</ul></div>
            <div class="prep-section"><strong>Your talking points</strong><ul>${(prep.talking_points||[]).map(p=>`<li>${esc(p)}</li>`).join('')}</ul></div>
            <div class="prep-section" style="background:#fff8f0;border:1px solid #f59e0b;border-radius:8px;padding:12px;"><strong>⚠️ One thing to avoid</strong><p>${esc(prep.one_thing_to_avoid||'')}</p></div>`;
          updateMatchInState(matchId, { interview_prep: JSON.stringify(prep) });
        }
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
    if (podcast.contact_email)       chips.push(`<a class="contact-chip" href="mailto:${esc(podcast.contact_email)}">${esc(podcast.contact_email)}</a>`);
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
          ${contactRowHtml('', 'Email', p.contact_email, `mailto:${p.contact_email}`, false)}
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

  // Prompt to connect Gmail if not yet connected
  if (!state.client.gmail_email) {
    const go = confirm('Connect your Gmail first so pitches can be sent directly from your inbox.\n\nClick OK to connect Gmail now.');
    if (go) {
      window.location.href = `/auth/gmail?clientId=${esc(state.client.id)}`;
    }
    return;
  }

  btn.textContent = 'Running…';
  btn.disabled = true;
  $('profile-dropdown').style.display = 'none';
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
      showToast(`Pipeline complete — ${data.matchesFound} new matches found!`, 'success');
      setTimeout(() => location.reload(), 2000);
    } else {
      showToast('Pipeline run failed.', 'error');
    }
  } catch { showToast('Network error running pipeline.', 'error'); }
  finally { btn.textContent = 'Find Me Podcasts'; btn.disabled = false; }
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

// ── Drag-and-drop handlers ────────────────────────────────────────────
function handleCardDragStart(event, matchId) {
  isDragging = true;
  event.dataTransfer.setData('text/plain', matchId);
  event.dataTransfer.effectAllowed = 'move';
  event.stopPropagation();
  const card = $(`card-${matchId}`);
  if (card) card.classList.add('dragging');
}
window.handleCardDragStart = handleCardDragStart;

function handleCardDragEnd(event, matchId) {
  isDragging = false;
  const card = $(`card-${matchId}`);
  if (card) card.classList.remove('dragging');
}
window.handleCardDragEnd = handleCardDragEnd;

async function updateMatchStatus(matchId, newStatus) {
  try {
    const data = await apiPost('/api/update-status', { matchId, status: newStatus });
    if (data.success) {
      updateMatchInState(matchId, { status: newStatus });
      renderGrid();
      showToast(`Moved to ${newStatus}`, 'success');
      // Dismiss drag hint after first successful drop
      localStorage.setItem('drag-hint-dismissed', '1');
      const hint = $('drag-hint');
      if (hint) hint.style.display = 'none';
    } else {
      showToast(data.error || 'Update failed.', 'error');
    }
  } catch (err) {
    showToast('Update failed.', 'error');
  }
}

function initDragDropTabs() {
  const tabs = document.querySelectorAll('.filter-tab');
  tabs.forEach((tab) => {
    const status = tab.dataset.status;
    if (status === 'all' || status === 'dismissed') return;

    tab.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tab.classList.add('drag-over');
    });

    tab.addEventListener('dragleave', () => {
      tab.classList.remove('drag-over');
    });

    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('drag-over');
      const matchId = e.dataTransfer.getData('text/plain');
      if (matchId) updateMatchStatus(matchId, status);
    });
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
  initDragDropTabs();
  // Hide drag hint if already dismissed
  if (localStorage.getItem('drag-hint-dismissed') === '1') {
    const hint = $('drag-hint');
    if (hint) hint.style.display = 'none';
  }
  loadDashboard();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
