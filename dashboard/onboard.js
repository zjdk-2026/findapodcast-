'use strict';

/* ═══════════════════════════════════════════════════════════════
   Podcast Pipeline — Client Onboarding Form
   Multi-step form → POST /api/onboard
   ═══════════════════════════════════════════════════════════════ */

let currentStep = 1;
const TOTAL_STEPS = 4;
let selectedPace = 10;

const COUNTRY_MAP = {
  'Any':            { languages: ['English'],    geographies: ['US','CA','UK','AU'] },
  'Australia':      { languages: ['English'],    geographies: ['AU'] },
  'Brazil':         { languages: ['Portuguese'], geographies: ['BR'] },
  'Canada':         { languages: ['English'],    geographies: ['CA'] },
  'France':         { languages: ['French'],     geographies: ['FR'] },
  'Germany':        { languages: ['German'],     geographies: ['DE'] },
  'India':          { languages: ['Hindi'],      geographies: ['IN'] },
  'Italy':          { languages: ['Italian'],    geographies: ['IT'] },
  'Japan':          { languages: ['Japanese'],   geographies: ['JP'] },
  'Mexico':         { languages: ['Spanish'],    geographies: ['MX'] },
  'Netherlands':    { languages: ['Dutch'],      geographies: ['NL'] },
  'Poland':         { languages: ['Polish'],     geographies: ['PL'] },
  'Portugal':       { languages: ['Portuguese'], geographies: ['PT'] },
  'South Korea':    { languages: ['Korean'],     geographies: ['KR'] },
  'Spain':          { languages: ['Spanish'],    geographies: ['ES'] },
  'Sweden':         { languages: ['Swedish'],    geographies: ['SE'] },
  'United Kingdom': { languages: ['English'],    geographies: ['UK','GB'] },
};
function countryToLangGeo(country) {
  const m = COUNTRY_MAP[country] || COUNTRY_MAP['Any'];
  return { languages: m.languages, geographies: m.geographies };
}

// ── Toast ─────────────────────────────────────────────────────
let toastTimer = null;
function showToast(message, type = 'info') {
  clearTimeout(toastTimer);
  const container = document.getElementById('toast-container');
  if (!container) return;
  const existing = container.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('toast-show')));
  toastTimer = setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

// ── Step navigation ───────────────────────────────────────────
function goToStep(n) {
  if (n > currentStep) {
    if (!validateStep(currentStep)) return;
  }

  document.querySelectorAll('.step-panel').forEach((p) => p.classList.remove('active'));
  const panel = document.getElementById(`step-${n}`);
  if (panel) panel.classList.add('active');

  for (let i = 1; i <= TOTAL_STEPS; i++) {
    const ind = document.getElementById(`step-indicator-${i}`);
    if (!ind) continue;
    ind.classList.remove('active', 'done');
    if (i < n)       ind.classList.add('done');
    else if (i === n) ind.classList.add('active');
  }

  currentStep = n;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Pace selector ─────────────────────────────────────────────
function selectPace(el) {
  document.querySelectorAll('.pace-option').forEach((o) => o.classList.remove('selected'));
  el.classList.add('selected');
  selectedPace = parseInt(el.dataset.value, 10);
  const hidden = document.getElementById('f-daily-target');
  if (hidden) hidden.value = selectedPace;
}

// ── Topic dropdown ────────────────────────────────────────────
function toggleTopicDropdown() {
  const trigger = document.getElementById('topic-dropdown-trigger');
  const list = document.getElementById('topic-dropdown-list');
  const open = list.classList.toggle('open');
  trigger.classList.toggle('open', open);
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const wrap = document.getElementById('topic-dropdown-wrap');
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('topic-dropdown-list')?.classList.remove('open');
    document.getElementById('topic-dropdown-trigger')?.classList.remove('open');
  }
});

function getSelectedTopics() {
  const selected = [];
  document.querySelectorAll('#topic-dropdown-list input[type=checkbox]:checked').forEach((cb) => {
    selected.push(cb.value);
  });
  return selected;
}

function updateTopicPills() {
  const pills = document.getElementById('topic-selected-pills');
  const label = document.getElementById('topic-trigger-label');
  if (!pills) return;
  const selected = getSelectedTopics();
  pills.innerHTML = selected.map((t) =>
    `<div class="topic-selected-pill">${t}<button type="button" onclick="removeTopicPill('${t}')">&times;</button></div>`
  ).join('');
  label.textContent = selected.length > 0 ? `${selected.length} selected` : 'Select topics that apply to you';
}

function removeTopicPill(topic) {
  const cb = document.querySelector(`#topic-dropdown-list input[value="${topic}"]`);
  if (cb) { cb.checked = false; updateTopicPills(); }
}

function buildTopicsValue() {
  const chips = getSelectedTopics();
  const typed = (document.getElementById('f-topics')?.value || '').trim();
  const all = [...chips];
  if (typed) {
    typed.split(',').map((s) => s.trim()).filter(Boolean).forEach((t) => {
      if (!all.includes(t)) all.push(t);
    });
  }
  return all.join(', ');
}

// ── Validation ────────────────────────────────────────────────
function validateStep(step) {
  let valid = true;

  function check(fieldId, errorId, testFn) {
    const field = document.getElementById(fieldId);
    const errEl = document.getElementById(errorId);
    const ok    = testFn(field ? field.value.trim() : '');
    if (field)  field.classList.toggle('error', !ok);
    if (errEl)  errEl.classList.toggle('show', !ok);
    if (!ok) valid = false;
  }

  if (step === 1) {
    check('f-name',       'err-name',       (v) => v.length > 0);
    check('f-email',      'err-email',      (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
    check('f-title',      'err-title',      (v) => v.length > 0);
    check('f-credential', 'err-credential', (v) => v.length > 0);
    check('f-bio-short',  'err-bio-short',  (v) => v.length > 10);
  }

  if (step === 2) {
    // Valid if any chip selected OR text typed
    const hasTopics = getSelectedTopics().length > 0
      || (document.getElementById('f-topics')?.value || '').trim().length > 0;
    const errEl = document.getElementById('err-topics');
    if (errEl) errEl.classList.toggle('show', !hasTopics);
    if (!hasTopics) valid = false;

    check('f-audience', 'err-audience', (v) => v.length > 0);
    check('f-angles',   'err-angles',   (v) => v.length > 0);
    check('f-offer',    'err-offer',    (v) => v.length > 0);
  }

  return valid;
}

// ── Collect form data ─────────────────────────────────────────
function collectFormData() {
  const val = (id) => (document.getElementById(id)?.value || '').trim();

  const topicsStr  = buildTopicsValue();
  const anglesRaw  = val('f-angles');

  return {
    name:             val('f-name'),
    email:            val('f-email'),
    business_name:    val('f-business')     || undefined,
    title:            val('f-title')        || undefined,
    credential:       val('f-credential')   || undefined,
    past_podcasts:    val('f-past-podcasts')|| undefined,
    bio_short:        val('f-bio-short'),
    bio_long:         val('f-bio-long')     || undefined,
    topics:           topicsStr ? topicsStr.split(',').map((s) => s.trim()).filter(Boolean) : [],
    speaking_angles:  anglesRaw ? anglesRaw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : [],
    target_audience:  val('f-audience')     || undefined,
    offer:            val('f-offer')        || undefined,
    website:          val('f-website')      || undefined,
    booking_link:     val('f-booking')      || undefined,
    lead_magnet:      val('f-lead-magnet')  || undefined,
    social_instagram: val('f-instagram')    || undefined,
    social_linkedin:  val('f-linkedin')     || undefined,
    social_twitter:   val('f-twitter')      || undefined,
    social_facebook:  val('f-facebook')     || undefined,
    extra_links:      val('f-extra-links')  || undefined,
    email_signature:  val('f-email-signature') || undefined,
    pitch_style:      val('f-pitch-style')  || undefined,
    preferred_tone:   val('f-tone')         || 'warm-professional',
    daily_target:     selectedPace || 10,
    ...countryToLangGeo(val('f-country') || 'Any'),
  };
}

// ── Submit ────────────────────────────────────────────────────
function showFormError(msg) {
  let el = document.getElementById('form-submit-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'form-submit-error';
    el.style.cssText = 'background:#fff1f0;border:1.5px solid #ff4d4f;color:#cf1322;padding:12px 16px;border-radius:10px;font-size:14px;font-weight:500;margin-top:14px;';
    const nav = document.querySelector('#step-4 .form-nav');
    if (nav) nav.insertAdjacentElement('beforebegin', el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function submitForm() {
  const errEl = document.getElementById('form-submit-error');
  if (errEl) errEl.style.display = 'none';

  const termsChecked = document.getElementById('f-terms')?.checked;
  if (!termsChecked) {
    const errEl = document.getElementById('form-submit-error');
    if (errEl) { errEl.textContent = 'Please agree to the Terms of Service and Privacy Policy to continue.'; errEl.style.display = 'block'; }
    else alert('Please agree to the Terms of Service and Privacy Policy to continue.');
    return;
  }

  const btn   = document.getElementById('submit-btn');
  const label = document.getElementById('submit-label');
  btn.disabled  = true;
  label.textContent = 'Launching…';

  try {
    const payload = collectFormData();

    if (!payload.name || !payload.email || !payload.topics || payload.topics.length === 0) {
      const missing = [];
      if (!payload.name)  missing.push('Full Name (Step 1)');
      if (!payload.email) missing.push('Email (Step 1)');
      if (!payload.topics || payload.topics.length === 0) missing.push('Topics (Step 2)');
      throw new Error('Missing required fields: ' + missing.join(', ') + '. Please go back and fill them in.');
    }

    const res = await fetch('/api/onboard', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    let data;
    try { data = await res.json(); } catch (_) {
      throw new Error(`Server returned an unexpected response (${res.status}). Please try again.`);
    }

    if (!res.ok || !data.success) {
      const msg = data.error
        || (Array.isArray(data.errors) ? data.errors.join('. ') : null)
        || `Something went wrong (${res.status}). Please try again.`;
      throw new Error(msg);
    }

    // Upload photos if provided
    const token = data.dashboardToken || data.dashboard_token || data.client?.dashboard_token || '';
    await uploadPhotos(token);

    showSuccess(data);
  } catch (err) {
    const msg = err.message || 'Something went wrong. Please try again.';
    showFormError(msg);
    showToast(msg, 'error');
    btn.disabled  = false;
    label.textContent = 'Launch My Pipeline';
  }
}

// ── Photo upload ──────────────────────────────────────────────
async function uploadPhotos(token) {
  if (!token) return;
  const photoInput = document.getElementById('f-photo');

  // If user selected a file manually, use that
  if (photoInput?.files?.[0]) {
    try {
      const fd = new FormData();
      fd.append('photo', photoInput.files[0]);
      await fetch('/api/upload-photo', {
        method: 'POST',
        headers: { 'x-dashboard-token': token },
        body: fd,
      });
    } catch (_) { /* non-blocking */ }
    return;
  }

  // Otherwise use LinkedIn photo if available
  if (window._linkedInPhotoUrl) {
    try {
      await fetch('/api/upload-photo-url', {
        method: 'POST',
        headers: { 'x-dashboard-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: window._linkedInPhotoUrl }),
      });
    } catch (_) { /* non-blocking */ }
  }
}

// ── Show success screen ───────────────────────────────────────
function showSuccess(data) {
  const token        = data.dashboardToken || data.dashboard_token || data.client?.dashboard_token || '';
  const clientId     = data.clientId || data.client_id || data.client?.id || '';
  const base         = window.location.origin;
  const dashboardUrl = `${base}/dashboard/${token}`;
  const gmailUrl     = `${base}/auth/gmail?clientId=${clientId}`;

  const urlBox   = document.getElementById('success-dashboard-url');
  const dashLink = document.getElementById('success-dashboard-link');
  const gmailLink= document.getElementById('success-gmail-link');

  if (urlBox)    urlBox.textContent = dashboardUrl;
  if (dashLink)  dashLink.href      = dashboardUrl;
  if (gmailLink) gmailLink.href     = gmailUrl;

  document.querySelectorAll('.step-panel').forEach((p) => p.classList.remove('active'));
  document.getElementById('step-success').classList.add('active');

  for (let i = 1; i <= TOTAL_STEPS; i++) {
    const ind = document.getElementById(`step-indicator-${i}`);
    if (ind) { ind.classList.remove('active'); ind.classList.add('done'); }
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Payment confirmation banner ───────────────────────────────
function showPaymentBanner() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('paid') !== 'true') return;
  const banner = document.createElement('div');
  banner.style.cssText = [
    'background:#f0fdf4','border:2px solid #22c55e','color:#14532d',
    'padding:20px 28px','border-radius:16px','margin-bottom:28px',
    'font-size:15px','font-weight:500','display:flex','align-items:center',
    'gap:14px','box-shadow:0 2px 12px rgba(34,197,94,0.15)',
  ].join(';');
  banner.innerHTML = '<div><div style="font-size:17px;font-weight:700;margin-bottom:4px;">Payment confirmed — welcome aboard!</div><div style="font-size:14px;opacity:0.8;">Complete your profile below and your pipeline will be live within minutes.</div></div>';
  const header = document.querySelector('.onboard-header');
  if (header) header.insertAdjacentElement('beforebegin', banner);
}

// ── Social link helpers ───────────────────────────────────────
/**
 * Given any pasted value (full URL or @handle), normalise it to
 * what the field expects:
 *   instagram / twitter → @handle
 *   linkedin / facebook → full https URL
 * Returns null if nothing useful extracted.
 */
function normaliseSocialInput(value, platform) {
  const v = value.trim();
  if (!v) return null;

  const PATTERNS = {
    instagram: /instagram\.com\/([a-z0-9_.]{1,30})\/?(?:\?|$|#)/i,
    twitter:   /(?:twitter|x)\.com\/([a-z0-9_]{1,15})\/?(?:\?|$|#)/i,
    linkedin:  /linkedin\.com\/((?:company|in)\/[a-z0-9\-_.%]{2,})\/?(?:\?|$|#)/i,
    facebook:  /facebook\.com\/([a-zA-Z0-9.]{5,})\/?(?:\?|$|#)/i,
  };

  // If it already looks like a URL, extract the handle/path
  if (/^https?:\/\//i.test(v) || v.includes('.com/')) {
    const pattern = PATTERNS[platform];
    if (!pattern) return v;
    const m = v.match(pattern);
    if (!m) return null;
    const handle = m[1].replace(/\/$/, '').split('?')[0];
    if (platform === 'instagram' || platform === 'twitter') return '@' + handle;
    if (platform === 'linkedin') return 'https://linkedin.com/' + handle;
    if (platform === 'facebook') return 'https://facebook.com/' + handle;
  }

  // Handle-style input (@handle or plain handle)
  if (platform === 'instagram' || platform === 'twitter') {
    const handle = v.replace(/^@/, '');
    if (/^[a-z0-9_.]{1,30}$/i.test(handle)) return '@' + handle;
  }

  return null;
}

/**
 * Auto-detect social links from the user's website and pre-fill fields.
 * Shows a subtle banner so users know what was found.
 */
async function detectSocialsFromWebsite() {
  const websiteEl = document.getElementById('f-website');
  const website = websiteEl?.value?.trim();
  if (!website) return;

  // Show a loading hint
  const hint = document.getElementById('detect-socials-hint');
  if (hint) { hint.textContent = 'Scanning your website for social links...'; hint.style.display = 'block'; hint.style.color = '#6b7280'; }

  try {
    const res = await fetch('/api/detect-socials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ website }),
    });
    const data = await res.json();
    if (!data.success || !data.socials) { if (hint) hint.style.display = 'none'; return; }

    const { instagram, twitter, linkedin, facebook } = data.socials;
    const filled = [];

    function fillIfEmpty(fieldId, value, label) {
      if (!value) return;
      const el = document.getElementById(fieldId);
      if (el && !el.value.trim()) { el.value = value; filled.push(label); }
    }

    fillIfEmpty('f-instagram', instagram, 'Instagram');
    fillIfEmpty('f-twitter',   twitter,   'Twitter/X');
    fillIfEmpty('f-linkedin',  linkedin,  'LinkedIn');
    fillIfEmpty('f-facebook',  facebook,  'Facebook');

    if (hint) {
      if (filled.length > 0) {
        hint.textContent = 'Found: ' + filled.join(', ') + ' — check them below and edit if needed.';
        hint.style.color = '#059669';
        hint.style.display = 'block';
      } else {
        hint.textContent = 'No social links found on your website. Please fill them in manually.';
        hint.style.color = '#6b7280';
        hint.style.display = 'block';
        setTimeout(() => { if (hint) hint.style.display = 'none'; }, 4000);
      }
    }
  } catch (_) {
    if (hint) hint.style.display = 'none';
  }
}

// ── LinkedIn import handler ───────────────────────────────────
function handleLinkedInReturn() {
  const params = new URLSearchParams(window.location.search);

  const error = params.get('linkedin_error');
  if (error) {
    const el = document.getElementById('linkedin-import-error');
    if (el) {
      const messages = {
        denied:          'LinkedIn connection was cancelled.',
        not_configured:  'LinkedIn import is not set up yet.',
        token_failed:    'Could not connect to LinkedIn. Please try again.',
        profile_failed:  'Could not load your LinkedIn profile. Please fill in manually.',
        invalid_state:   'Session expired. Please try again.',
        server_error:    'Something went wrong. Please fill in manually.',
      };
      el.textContent = messages[error] || 'LinkedIn import failed. Please fill in manually.';
      el.style.display = 'block';
    }
    // Clean URL
    window.history.replaceState({}, '', '/onboard');
    return;
  }

  const name    = params.get('li_name');
  const email   = params.get('li_email');
  const picture = params.get('li_picture');

  if (!name && !email) return;

  // Pre-fill fields if they're empty
  if (name) {
    const nameEl = document.getElementById('f-name');
    if (nameEl && !nameEl.value.trim()) nameEl.value = name;
  }
  if (email) {
    const emailEl = document.getElementById('f-email');
    if (emailEl && !emailEl.value.trim()) emailEl.value = email;
  }

  // If we got a profile photo URL, show a preview and store for upload
  if (picture) {
    window._linkedInPhotoUrl = picture;
    // Show small preview next to the import button
    const btn = document.getElementById('linkedin-import-btn');
    if (btn) {
      const img = document.createElement('img');
      img.src = picture;
      img.style.cssText = 'width:36px;height:36px;border-radius:50%;object-fit:cover;margin-left:10px;vertical-align:middle;border:2px solid #6366f1;';
      btn.insertAdjacentElement('afterend', img);
    }
  }

  // Show success banner
  const successEl = document.getElementById('linkedin-import-success');
  if (successEl) successEl.style.display = 'block';

  // Clean URL
  window.history.replaceState({}, '', '/onboard');
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  showPaymentBanner();
  handleLinkedInReturn();

  // Clear errors on input
  ['f-name','f-email','f-bio-short'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      el.classList.remove('error');
      const errEl = document.getElementById(`err-${id.replace('f-', '')}`);
      if (errEl) errEl.classList.remove('show');
    });
  });

  // Topic dropdown checkboxes
  document.querySelectorAll('#topic-dropdown-list input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      updateTopicPills();
      const hasAny = getSelectedTopics().length > 0
        || (document.getElementById('f-topics')?.value || '').trim().length > 0;
      if (hasAny) document.getElementById('err-topics')?.classList.remove('show');
    });
  });

  // Also clear topic error when typing in the free-type box
  const topicsInput = document.getElementById('f-topics');
  if (topicsInput) {
    topicsInput.addEventListener('input', () => {
      if (topicsInput.value.trim().length > 0) {
        document.getElementById('err-topics')?.classList.remove('show');
      }
    });
  }

  // Auto-detect socials when user leaves the website field
  const websiteEl = document.getElementById('f-website');
  if (websiteEl) {
    websiteEl.addEventListener('blur', () => detectSocialsFromWebsite());
  }

  // Smart paste: normalise full URLs pasted into social fields
  const SOCIAL_FIELDS = [
    { id: 'f-instagram', platform: 'instagram' },
    { id: 'f-twitter',   platform: 'twitter'   },
    { id: 'f-linkedin',  platform: 'linkedin'  },
    { id: 'f-facebook',  platform: 'facebook'  },
  ];
  SOCIAL_FIELDS.forEach(({ id, platform }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('paste', (e) => {
      const pasted = (e.clipboardData || window.clipboardData).getData('text');
      if (!pasted.includes('.com/')) return; // Only intercept full URLs
      e.preventDefault();
      const normalised = normaliseSocialInput(pasted, platform);
      el.value = normalised || pasted;
    });
    el.addEventListener('blur', () => {
      const normalised = normaliseSocialInput(el.value, platform);
      if (normalised) el.value = normalised;
    });
  });
});

// Expose to inline onclick handlers
window.goToStep    = goToStep;
window.submitForm  = submitForm;
window.selectPace  = selectPace;
window.toggleTopicDropdown = toggleTopicDropdown;
window.removeTopicPill = removeTopicPill;
