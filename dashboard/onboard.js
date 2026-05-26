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

// ── Topic autocomplete tag widget ──────────────────────────────
const TOPIC_SUGGESTIONS = [
  'entrepreneurship','startup','small business','business growth','leadership','management',
  'mindset','personal development','productivity','habits','sales','sales strategy','closing deals',
  'marketing','digital marketing','social media marketing','content marketing','personal branding',
  'public speaking','storytelling','health & wellness','fitness','nutrition','mental health','anxiety',
  'burnout recovery','faith','christian living','faith-based business','finance','investing',
  'wealth building','financial freedom','real estate','real estate investing','coaching','life coaching',
  'business coaching','executive coaching','parenting','relationships','marriage','family','technology',
  'ai & automation','software','content creation','podcasting','youtube','women in business',
  'diversity & inclusion','ecommerce','amazon fba','dropshipping','consulting','freelancing',
  'remote work','work-life balance','legacy building','purpose & meaning','spirituality','law',
  'healthcare','education','non-profit','sustainability',
];

let _selectedTopics = []; // canonical store for selected tags
let _activeSugIdx = -1;

function renderTopicTags() {
  const wrap = document.getElementById('topic-tag-wrap');
  if (!wrap) return;
  // Wipe existing pills (keep input + suggestions div)
  wrap.querySelectorAll('.tag-pill').forEach(p => p.remove());
  const input = document.getElementById('topic-tag-input');
  _selectedTopics.forEach((t) => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.innerHTML = `${t}<button type="button" onclick="removeTopicTag(event,'${t.replace(/'/g, "\\'")}')">&times;</button>`;
    wrap.insertBefore(pill, input);
  });
  // Save to localStorage for resume
  saveOnboardDraft();
}

function addTopicTag(value) {
  const v = (value || '').trim().toLowerCase();
  if (!v) return;
  if (_selectedTopics.includes(v)) return;
  _selectedTopics.push(v);
  renderTopicTags();
  const input = document.getElementById('topic-tag-input');
  if (input) input.value = '';
  closeTopicSuggestions();
}
window.addTopicTag = addTopicTag;

function removeTopicTag(event, value) {
  event?.stopPropagation();
  _selectedTopics = _selectedTopics.filter(t => t !== value);
  renderTopicTags();
}
window.removeTopicTag = removeTopicTag;

function closeTopicSuggestions() {
  const sug = document.getElementById('topic-tag-suggestions');
  if (sug) { sug.classList.remove('open'); sug.innerHTML = ''; }
  _activeSugIdx = -1;
}

function showTopicSuggestions(query) {
  const sug = document.getElementById('topic-tag-suggestions');
  if (!sug) return;
  const q = (query || '').trim().toLowerCase();
  if (!q) { closeTopicSuggestions(); return; }
  const matches = TOPIC_SUGGESTIONS.filter(t => t.includes(q) && !_selectedTopics.includes(t)).slice(0, 8);
  const isCustom = !TOPIC_SUGGESTIONS.includes(q) && !_selectedTopics.includes(q);
  const items = matches.map((t, i) => `<div class="tag-suggestion${i === _activeSugIdx ? ' active' : ''}" onclick="addTopicTag('${t.replace(/'/g, "\\'")}')">${t}</div>`).join('');
  const customRow = isCustom ? `<div class="tag-suggestion tag-suggestion-add" onclick="addTopicTag('${q.replace(/'/g, "\\'")}')">+ Add "${q}"</div>` : '';
  sug.innerHTML = items + customRow;
  if (items || customRow) sug.classList.add('open');
  else closeTopicSuggestions();
}

function buildTopicsValue() {
  return _selectedTopics.join(', ');
}

// Wire up the tag input + keyboard nav once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('topic-tag-input');
  if (!input) return;
  input.addEventListener('input', () => showTopicSuggestions(input.value));
  input.addEventListener('focus',  () => showTopicSuggestions(input.value));
  input.addEventListener('keydown', (e) => {
    const sug = document.getElementById('topic-tag-suggestions');
    const items = sug ? Array.from(sug.querySelectorAll('.tag-suggestion')) : [];
    if (e.key === 'Enter') {
      e.preventDefault();
      if (_activeSugIdx >= 0 && items[_activeSugIdx]) items[_activeSugIdx].click();
      else if (input.value.trim()) addTopicTag(input.value.trim());
    } else if (e.key === 'Backspace' && !input.value && _selectedTopics.length > 0) {
      _selectedTopics.pop();
      renderTopicTags();
    } else if (e.key === ',' || e.key === 'Tab') {
      if (input.value.trim()) {
        e.preventDefault();
        addTopicTag(input.value.trim());
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      _activeSugIdx = Math.min(_activeSugIdx + 1, items.length - 1);
      showTopicSuggestions(input.value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _activeSugIdx = Math.max(_activeSugIdx - 1, -1);
      showTopicSuggestions(input.value);
    } else if (e.key === 'Escape') {
      closeTopicSuggestions();
    }
  });
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('topic-tag-wrap');
    if (wrap && !wrap.contains(e.target)) closeTopicSuggestions();
  });
});

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
    // Valid if any topic tag has been added
    const hasTopics = _selectedTopics.length > 0;
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
    contrarian_belief: val('f-contrarian-belief') || undefined,
    origin_story:     val('f-origin-story')  || undefined,
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
      const baseMsg = data.error
        || (Array.isArray(data.errors) ? data.errors.join('. ') : null)
        || `Something went wrong (${res.status}). Please try again.`;
      // Surface debug payload if backend included it (helps diagnose insert failures)
      const debugMsg = data.debug?.message ? ` (${data.debug.message})` : '';
      throw new Error(baseMsg + debugMsg);
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
  // Round 4A: clear saved draft once they're successfully onboarded
  try { localStorage.removeItem(ONBOARD_DRAFT_KEY); } catch {}

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

// ── Auto-fill from website (Claude scrapes + pre-fills the form) ──────
async function prefillFromWebsite() {
  const urlEl = document.getElementById('f-website');
  const btnEl = document.getElementById('prefill-btn');
  const statusEl = document.getElementById('prefill-status');
  if (!urlEl || !btnEl || !statusEl) return;

  const url = (urlEl.value || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    statusEl.style.cssText = 'display:block;background:#fff1f0;border:1px solid #fecaca;color:#991b1b;margin-top:10px;padding:10px 14px;border-radius:10px;font-size:13px;';
    statusEl.textContent = 'Please enter a valid URL (must start with https://).';
    return;
  }

  btnEl.disabled = true;
  btnEl.textContent = 'Reading your site…';
  statusEl.style.cssText = 'display:block;background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;margin-top:10px;padding:10px 14px;border-radius:10px;font-size:13px;';
  statusEl.textContent = 'Reading your website with AI… this takes ~10 seconds.';

  try {
    const r = await fetch('/api/onboard/prefill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'Prefill failed');

    // Fill in any empty fields with what Claude found
    const setIf = (id, val) => {
      if (!val) return;
      const el = document.getElementById(id);
      if (el && !el.value.trim()) el.value = val;
    };
    const p = data.profile || {};
    setIf('f-name',        p.name);
    setIf('f-title',       p.title);
    setIf('f-business',    p.business);
    setIf('f-bio-short',   p.bio_short);
    setIf('f-credential',  p.credential);
    setIf('f-bio-long',    p.bio_long);
    setIf('f-audience',    p.audience);
    setIf('f-instagram',   p.instagram);
    setIf('f-linkedin',    p.linkedin);
    setIf('f-twitter',     p.twitter);
    setIf('f-facebook',    p.facebook);

    // Auto-tick any topic checkboxes Claude returned
    if (Array.isArray(p.topics)) {
      // Add each AI-suggested topic to the selected tags
      p.topics.forEach(t => {
        const v = (t || '').toLowerCase().trim();
        if (v && !_selectedTopics.includes(v)) _selectedTopics.push(v);
      });
      renderTopicTags();
    }

    // Check if we actually filled anything useful
    const filledCount = [p.name, p.title, p.business, p.bio_short, p.credential, p.instagram, p.linkedin, p.twitter, p.facebook].filter(Boolean).length;
    if (data.degraded && filledCount === 0) {
      statusEl.style.cssText = 'display:block;background:#fefce8;border:1px solid #fde68a;color:#92400e;margin-top:10px;padding:10px 14px;border-radius:10px;font-size:13px;';
      statusEl.textContent = 'Could not pre-fill from that URL. Please fill in the fields below manually.';
    } else if (data.degraded && filledCount > 0) {
      statusEl.style.cssText = 'display:block;background:#fefce8;border:1px solid #fde68a;color:#92400e;margin-top:10px;padding:10px 14px;border-radius:10px;font-size:13px;';
      statusEl.textContent = `Partially filled (${filledCount} fields). AI enrichment is currently unavailable — please fill remaining fields manually.`;
    } else {
      statusEl.style.cssText = 'display:block;background:#f0fdf4;border:1px solid #bbf7d0;color:#065f46;margin-top:10px;padding:10px 14px;border-radius:10px;font-size:13px;';
      statusEl.textContent = `Pre-filled what we could find. Review the fields below and edit anything that's off.`;
    }
  } catch (err) {
    statusEl.style.cssText = 'display:block;background:#fff1f0;border:1px solid #fecaca;color:#991b1b;margin-top:10px;padding:10px 14px;border-radius:10px;font-size:13px;';
    statusEl.textContent = 'Could not read that URL. Fill in the fields below manually.';
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = 'Auto-fill →';
  }
}
window.prefillFromWebsite = prefillFromWebsite;

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  showPaymentBanner();

  // ── Round 4A: Resume saved draft if any ──────────────
  const draft = loadOnboardDraft();
  if (draft) {
    applyOnboardDraft(draft);
    showResumeBanner(draft);
  }

  // ── Round 4A: Auto-save on every input ──────────────
  // Debounced 400ms so we don't hammer localStorage
  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveOnboardDraft, 400);
  };
  ONBOARD_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', scheduleSave);
  });

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

  // ── Round 4B: Email-domain smart prefill ────────────
  const emailEl = document.getElementById('f-email');
  if (emailEl) {
    emailEl.addEventListener('blur', () => maybeFireDomainPrefill(emailEl.value));
  }

  // Topic tags — clear error as soon as one is added
  const topicInput = document.getElementById('topic-tag-input');
  if (topicInput) {
    topicInput.addEventListener('input', () => {
      if (_selectedTopics.length > 0) document.getElementById('err-topics')?.classList.remove('show');
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
// (removeTopicPill / getSelectedTopics / toggleTopicDropdown removed — replaced with autocomplete tag widget)

// ── Inline ✨ Suggest from bio (Round 3D) ─────────────────────
async function suggestField(field) {
  const fieldMap = { audience: 'f-audience', angles: 'f-angles' };
  const targetEl = document.getElementById(fieldMap[field]);
  if (!targetEl) return;

  const bio = (document.getElementById('f-bio-long')?.value || document.getElementById('f-bio-short')?.value || '').trim();
  if (bio.length < 30) {
    showToast('Add a bio first (Step 1) — we need ~30 characters minimum to generate a draft.', 'error');
    return;
  }

  const btn = event?.target?.closest('.ai-suggest-btn');
  const orig = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Drafting…'; }

  try {
    const r = await fetch('/api/onboard/suggest-field', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field,
        bio,
        business: document.getElementById('f-business')?.value || '',
        title:    document.getElementById('f-title')?.value || '',
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || 'suggest_failed');
    targetEl.value = data.suggestion || '';
    targetEl.focus();
    targetEl.setSelectionRange(targetEl.value.length, targetEl.value.length);
    showToast('Draft ready. Edit before submitting.', 'success');
  } catch (err) {
    showToast('Could not generate suggestion. Type it manually.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}
window.suggestField = suggestField;

// ── Save-and-resume (Round 4A) ────────────────────────────────
// Auto-persists every form field to localStorage on every keystroke.
// On page load: if a draft exists, show a resume banner. User can resume or reset.
const ONBOARD_DRAFT_KEY = 'pp-onboard-draft-v2';
const ONBOARD_FIELDS = [
  'f-name','f-email','f-title','f-business','f-bio-short','f-credential','f-bio-long','f-contrarian-belief','f-origin-story',
  'f-website','f-instagram','f-linkedin','f-twitter','f-facebook','f-extra-links',
  'f-audience','f-angles','f-offer','f-past-podcasts','f-country','f-tone','f-email-signature',
];

function saveOnboardDraft() {
  try {
    const draft = { topics: _selectedTopics, savedAt: Date.now() };
    ONBOARD_FIELDS.forEach(id => { const el = document.getElementById(id); if (el) draft[id] = el.value; });
    localStorage.setItem(ONBOARD_DRAFT_KEY, JSON.stringify(draft));
  } catch {}
}
window.saveOnboardDraft = saveOnboardDraft;

function loadOnboardDraft() {
  try {
    const raw = localStorage.getItem(ONBOARD_DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw);
    // Drafts older than 30 days are stale
    if (draft.savedAt && Date.now() - draft.savedAt > 30 * 24 * 60 * 60 * 1000) {
      localStorage.removeItem(ONBOARD_DRAFT_KEY);
      return null;
    }
    return draft;
  } catch { return null; }
}

function applyOnboardDraft(draft) {
  if (!draft) return;
  ONBOARD_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el && draft[id]) el.value = draft[id];
  });
  if (Array.isArray(draft.topics)) {
    _selectedTopics = draft.topics.filter(Boolean);
    renderTopicTags();
  }
}

function clearOnboardDraft() {
  localStorage.removeItem(ONBOARD_DRAFT_KEY);
  const banner = document.getElementById('resume-banner');
  if (banner) banner.remove();
}
window.clearOnboardDraft = clearOnboardDraft;

function showResumeBanner(draft) {
  const ago = (() => {
    const m = Math.floor((Date.now() - draft.savedAt) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
    const d = Math.floor(h / 24);
    return `${d} day${d > 1 ? 's' : ''} ago`;
  })();
  const wrap = document.querySelector('.form-card');
  if (!wrap || document.getElementById('resume-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'resume-banner';
  banner.className = 'resume-banner';
  banner.innerHTML = `
    <div>
      <strong>Welcome back.</strong> We saved your draft from ${ago}. Picking up where you left off.
    </div>
    <button onclick="if(confirm('Discard saved draft and start fresh?')){clearOnboardDraft();location.reload();}">Start fresh</button>
  `;
  wrap.insertBefore(banner, wrap.firstChild);
}

// ── Email-domain smart prefill (Round 4B) ──────────────────────
// When user types email, extract domain, fire prefill on https://domain
// IF website field is empty AND name field is empty (i.e. first time).
let _domainPrefillFired = false;
async function maybeFireDomainPrefill(email) {
  if (_domainPrefillFired) return;
  if (!email || !email.includes('@')) return;
  const domain = email.split('@')[1]?.trim().toLowerCase();
  if (!domain) return;
  // Skip generic providers
  const generic = ['gmail.com','outlook.com','hotmail.com','yahoo.com','icloud.com','me.com','aol.com','proton.me','protonmail.com','live.com','msn.com'];
  if (generic.includes(domain)) return;
  const websiteEl = document.getElementById('f-website');
  const nameEl = document.getElementById('f-name');
  if (websiteEl?.value || nameEl?.value) return; // user already typing — don't overwrite
  _domainPrefillFired = true;
  const url = `https://${domain}`;
  if (websiteEl) websiteEl.value = url;
  // Fire prefill in background
  try {
    const r = await fetch('/api/onboard/prefill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) return;
    const setIf = (id, val) => { if (!val) return; const el = document.getElementById(id); if (el && !el.value.trim()) el.value = val; };
    const p = data.profile || {};
    setIf('f-name', p.name);
    setIf('f-title', p.title);
    setIf('f-business', p.business);
    setIf('f-bio-short', p.bio_short);
    setIf('f-credential', p.credential);
    setIf('f-bio-long', p.bio_long);
    setIf('f-audience', p.audience);
    setIf('f-instagram', p.instagram);
    setIf('f-linkedin', p.linkedin);
    setIf('f-twitter', p.twitter);
    setIf('f-facebook', p.facebook);
    if (Array.isArray(p.topics)) {
      p.topics.forEach(t => { const v = (t || '').toLowerCase().trim(); if (v && !_selectedTopics.includes(v)) _selectedTopics.push(v); });
      renderTopicTags();
    }
    if (data.degraded) {
      const filledCount = [p.name, p.title, p.business, p.bio_short, p.credential, p.instagram, p.linkedin, p.twitter, p.facebook].filter(Boolean).length;
      if (filledCount > 0) {
        showToast(`Partially filled ${filledCount} fields from ${domain} (AI enrichment unavailable).`, 'info');
      }
      // If nothing filled, no toast — silent fail is better than confusing
    } else {
      showToast(`Pre-filled from ${domain}. Review the fields below.`, 'success');
    }
    saveOnboardDraft();
  } catch {}
}
