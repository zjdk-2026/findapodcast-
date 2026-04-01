'use strict';

/* ═══════════════════════════════════════════════════════════════
   Podcast Pipeline — Operator Dashboard
   ═══════════════════════════════════════════════════════════════ */

const OPERATOR_KEY = 'pipeline2026';
let authed = false;

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

// ── Password gate ─────────────────────────────────────────────
function checkPassword() {
  const input = document.getElementById('pw-input');
  const errEl = document.getElementById('pw-error');
  const val   = (input?.value || '').trim();

  if (val === OPERATOR_KEY) {
    authed = true;
    document.getElementById('pw-gate').style.display = 'none';
    document.getElementById('op-wrap').style.display = 'block';
    loadClients();
  } else {
    if (errEl) errEl.classList.add('show');
    if (input) { input.value = ''; input.focus(); }
  }
}

// ── Fetch clients ─────────────────────────────────────────────
async function loadClients() {
  const loading = document.getElementById('table-loading');
  const table   = document.getElementById('clients-table');
  if (loading) loading.style.display = 'block';
  if (table)   table.style.display   = 'none';

  try {
    const res  = await fetch('/api/operator/clients', {
      headers: { 'x-operator-key': OPERATOR_KEY },
    });
    const data = await res.json();

    if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);

    renderTotals(data.totals || {});
    renderTable(data.clients || []);
  } catch (err) {
    showToast(`Failed to load clients: ${err.message}`, 'error');
    if (loading) loading.innerHTML = `<p style="color:var(--score-low);">Error: ${esc(err.message)}</p>`;
  }
}

// ── Render totals ─────────────────────────────────────────────
function renderTotals(totals) {
  setText('tot-clients', totals.total_clients   ?? '—');
  setText('tot-today',   totals.matches_today   ?? '—');
  setText('tot-sent',    totals.sent_this_week  ?? '—');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Render table ──────────────────────────────────────────────
function renderTable(clients) {
  const tbody   = document.getElementById('clients-tbody');
  const table   = document.getElementById('clients-table');
  const loading = document.getElementById('table-loading');

  if (!tbody) return;

  if (clients.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:40px;">No clients yet. <a href="/onboard">Add the first one →</a></td></tr>`;
  } else {
    tbody.innerHTML = clients.map(renderClientRow).join('');
  }

  if (loading) loading.style.display = 'none';
  if (table)   table.style.display   = '';
}

function renderClientRow(c) {
  const lastRun = c.last_run_at
    ? new Date(c.last_run_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Never';

  const dashUrl = `/api/operator/dashboard/${esc(c.id)}?key=${encodeURIComponent(OPERATOR_KEY)}`;

  return `<tr id="row-${esc(c.id)}">
    <td>
      <span style="font-weight:700;">${esc(c.name || '—')}</span>
    </td>
    <td class="muted">${esc(c.email || '—')}</td>
    <td class="muted">${esc(lastRun)}</td>
    <td class="count-cell">${c.total_matches ?? 0}</td>
    <td class="count-cell approved">${c.approved_count ?? 0}</td>
    <td class="count-cell sent">${c.sent_count ?? 0}</td>
    <td class="count-cell booked">${c.booked_count ?? 0}</td>
    <td>
      <label class="toggle" title="${c.is_active ? 'Active — click to deactivate' : 'Inactive — click to activate'}">
        <input type="checkbox" ${c.is_active ? 'checked' : ''} onchange="toggleActive('${esc(c.id)}', this.checked)" />
        <span class="toggle-slider"></span>
      </label>
    </td>
    <td>
      <div class="actions-cell">
        <button class="btn btn-primary btn-xs" onclick="runPipeline('${esc(c.id)}', '${esc(c.name || '')}')">Run Pipeline</button>
        <a class="btn btn-outline btn-xs" href="${dashUrl}" target="_blank">View Dashboard</a>
      </div>
    </td>
  </tr>`;
}

// ── Toggle active status ──────────────────────────────────────
async function toggleActive(clientId, isActive) {
  try {
    const res  = await fetch('/api/operator/toggle-active', {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'x-operator-key': OPERATOR_KEY,
      },
      body: JSON.stringify({ clientId, is_active: isActive }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Client ${isActive ? 'activated' : 'deactivated'}.`, 'success');
    } else {
      showToast(data.error || 'Failed to update.', 'error');
      loadClients(); // revert
    }
  } catch (err) {
    showToast('Network error.', 'error');
    loadClients();
  }
}

// ── Run pipeline ──────────────────────────────────────────────
async function runPipeline(clientId, clientName) {
  const btn = document.querySelector(`#row-${clientId} .btn-primary`);
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }

  try {
    const res  = await fetch(`/api/run/${clientId}`, {
      method:  'POST',
      headers: { 'x-operator-key': OPERATOR_KEY },
    });
    const data = await res.json();

    if (data.success) {
      showToast(`Pipeline triggered for ${clientName}.`, 'success');
    } else {
      showToast(data.error || 'Failed to run pipeline.', 'error');
    }
  } catch (err) {
    showToast('Network error.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Run Pipeline'; }
  }
}

// ── HTML escape ───────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Expose to global scope ────────────────────────────────────
window.checkPassword = checkPassword;
window.loadClients   = loadClients;
window.runPipeline   = runPipeline;
window.toggleActive  = toggleActive;
