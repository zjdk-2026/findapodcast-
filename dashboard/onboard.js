'use strict';

/* ═══════════════════════════════════════════════════════════════
   Podcast Pipeline — Client Onboarding Form
   Multi-step form → POST /api/onboard
   ═══════════════════════════════════════════════════════════════ */

let currentStep = 1;
const TOTAL_STEPS = 3;

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
    // Validate before advancing
    if (!validateStep(currentStep)) return;
  }

  // Update panels
  document.querySelectorAll('.step-panel').forEach((p) => p.classList.remove('active'));
  const panel = document.getElementById(`step-${n}`);
  if (panel) panel.classList.add('active');

  // Update progress indicators
  for (let i = 1; i <= TOTAL_STEPS; i++) {
    const ind = document.getElementById(`step-indicator-${i}`);
    if (!ind) continue;
    ind.classList.remove('active', 'done');
    if (i < n)      ind.classList.add('done');
    else if (i === n) ind.classList.add('active');
  }

  currentStep = n;
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
    check('f-name',      'err-name',      (v) => v.length > 0);
    check('f-email',     'err-email',     (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
    check('f-bio-short', 'err-bio-short', (v) => v.length > 10);
  }

  if (step === 2) {
    check('f-topics', 'err-topics', (v) => v.length > 0);
  }

  return valid;
}

// ── Collect form data ─────────────────────────────────────────
function collectFormData() {
  const val = (id) => (document.getElementById(id)?.value || '').trim();

  const topicsRaw  = val('f-topics');
  const anglesRaw  = val('f-angles');

  return {
    name:             val('f-name'),
    email:            val('f-email'),
    business_name:    val('f-business')  || undefined,
    title:            val('f-title')     || undefined,
    bio_short:        val('f-bio-short'),
    bio_long:         val('f-bio-long')  || undefined,
    topics:           topicsRaw  ? topicsRaw.split(',').map((s) => s.trim()).filter(Boolean)  : [],
    speaking_angles:  anglesRaw  ? anglesRaw.split(',').map((s) => s.trim()).filter(Boolean)  : [],
    target_audience:  val('f-audience')    || undefined,
    website:          val('f-website')     || undefined,
    booking_link:     val('f-booking')     || undefined,
    lead_magnet:      val('f-lead-magnet') || undefined,
    social_instagram: val('f-instagram')   || undefined,
    social_linkedin:  val('f-linkedin')    || undefined,
    social_twitter:   val('f-twitter')     || undefined,
    preferred_tone:   val('f-tone')        || 'warm-professional',
    daily_target:     parseInt(val('f-daily-target') || '10', 10),
  };
}

// ── Submit ────────────────────────────────────────────────────
async function submitForm() {
  if (!validateStep(3)) return;

  const btn   = document.getElementById('submit-btn');
  const label = document.getElementById('submit-label');
  btn.disabled  = true;
  label.textContent = 'Submitting…';

  try {
    const payload = collectFormData();

    const res  = await fetch('/api/onboard', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      throw new Error(data.error || `Server error (${res.status})`);
    }

    showSuccess(data);
  } catch (err) {
    showToast(err.message || 'Something went wrong. Please try again.', 'error');
    btn.disabled  = false;
    label.textContent = 'Launch My Pipeline 🚀';
  }
}

// ── Show success screen ───────────────────────────────────────
function showSuccess(data) {
  const token        = data.dashboard_token || data.client?.dashboard_token || '';
  const base         = window.location.origin;
  const dashboardUrl = `${base}/dashboard/${token}`;
  const gmailUrl     = `${base}/auth/gmail?token=${token}`;

  // Update success elements
  const urlBox  = document.getElementById('success-dashboard-url');
  const dashLink= document.getElementById('success-dashboard-link');
  const gmailLink= document.getElementById('success-gmail-link');

  if (urlBox)   urlBox.textContent  = dashboardUrl;
  if (dashLink) dashLink.href       = dashboardUrl;
  if (gmailLink)gmailLink.href      = gmailUrl;

  // Switch all step panels off, show success
  document.querySelectorAll('.step-panel').forEach((p) => p.classList.remove('active'));
  document.getElementById('step-success').classList.add('active');

  // Mark all progress steps done
  for (let i = 1; i <= TOTAL_STEPS; i++) {
    const ind = document.getElementById(`step-indicator-${i}`);
    if (ind) {
      ind.classList.remove('active');
      ind.classList.add('done');
    }
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Payment confirmation banner ───────────────────────────────
function showPaymentBanner() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('paid') !== 'true') return;
  const banner = document.createElement('div');
  banner.style.cssText = [
    'background:#f0fdf4',
    'border:2px solid #22c55e',
    'color:#14532d',
    'padding:20px 28px',
    'border-radius:16px',
    'margin-bottom:28px',
    'font-size:15px',
    'font-weight:500',
    'display:flex',
    'align-items:center',
    'gap:14px',
    'box-shadow:0 2px 12px rgba(34,197,94,0.15)',
  ].join(';');
  banner.innerHTML = '<span style="font-size:28px;flex-shrink:0;">🎉</span><div><div style="font-size:17px;font-weight:700;margin-bottom:4px;">Payment confirmed — welcome aboard!</div><div style="font-size:14px;opacity:0.8;">Complete your profile below and your pipeline will be live within minutes.</div></div>';
  const wrap = document.querySelector('.onboard-wrap');
  const header = document.querySelector('.onboard-header');
  if (header) header.insertAdjacentElement('beforebegin', banner);
  else if (wrap) wrap.prepend(banner);
}

// ── Clear errors on input ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  showPaymentBanner();
  ['f-name','f-email','f-bio-short','f-topics'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      el.classList.remove('error');
      const errId = `err-${id.replace('f-', '')}`;
      const errEl = document.getElementById(errId);
      if (errEl) errEl.classList.remove('show');
    });
  });
});

// Expose to inline onclick handlers
window.goToStep   = goToStep;
window.submitForm = submitForm;
