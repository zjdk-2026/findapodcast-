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
    loadContentBoostOrders();
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
    populateClientDropdown(data.clients || []);
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

// ── Populate client dropdown for manual add ───────────────────
function populateClientDropdown(clients) {
  const sel = document.getElementById('manual-client-id');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select client…</option>' +
    clients.map(c => `<option value="${esc(c.id)}">${esc(c.name || c.email || c.id)}</option>`).join('');
}

// ── Add Podcast Manually ──────────────────────────────────────
async function addPodcastManually() {
  const clientId    = document.getElementById('manual-client-id')?.value?.trim();
  const podcastUrl  = document.getElementById('manual-podcast-url')?.value?.trim();
  const podcastName = document.getElementById('manual-podcast-name')?.value?.trim();
  const statusEl    = document.getElementById('manual-add-status');
  const btn         = document.getElementById('manual-add-btn');

  if (!clientId) { showToast('Select a client first.', 'error'); return; }
  if (!podcastUrl && !podcastName) { showToast('Enter a podcast URL or name.', 'error'); return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
  if (statusEl) { statusEl.style.display = 'none'; }

  try {
    const res  = await fetch('/api/operator/add-podcast', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-operator-key': OPERATOR_KEY },
      body: JSON.stringify({ clientId, podcastUrl: podcastUrl || null, podcastName: podcastName || null }),
    });
    const data = await res.json();

    if (data.success) {
      const msg = data.message || `Added "${data.podcast?.title || podcastName || podcastUrl}" to pipeline.`;
      showToast(msg, 'success');
      if (statusEl) {
        statusEl.textContent = '✅ ' + msg;
        statusEl.style.color = 'var(--score-high, green)';
        statusEl.style.display = 'block';
      }
      // Clear inputs
      if (document.getElementById('manual-podcast-url')) document.getElementById('manual-podcast-url').value = '';
      if (document.getElementById('manual-podcast-name')) document.getElementById('manual-podcast-name').value = '';
    } else {
      showToast(data.error || 'Failed to add podcast.', 'error');
      if (statusEl) {
        statusEl.textContent = '❌ ' + (data.error || 'Failed to add podcast.');
        statusEl.style.color = 'var(--score-low, red)';
        statusEl.style.display = 'block';
      }
    }
  } catch (err) {
    showToast('Network error: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Add to Pipeline'; }
  }
}

// ── Content Boost Orders ──────────────────────────────────────
async function loadContentBoostOrders() {
  const el = document.getElementById('boost-orders-body');
  if (!el) return;
  el.innerHTML = '<p style="font-size:13px;color:#888;">Loading…</p>';

  try {
    const res  = await fetch('/api/operator/content-boost', { headers: { 'x-operator-key': OPERATOR_KEY } });
    const data = await res.json();
    if (!data.success || !data.orders.length) {
      el.innerHTML = '<p style="font-size:13px;color:#888;">No content boost orders yet.</p>';
      return;
    }

    const statusColor = { ordered: '#FF9F0A', completed: '#30D158', requested: '#6366f1' };
    const statusLabel = { ordered: 'Ordered — Pending', completed: 'Complete', requested: 'Awaiting Payment' };

    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="border-bottom:1px solid var(--border-subtle,#eee);">
            <th style="text-align:left;padding:8px 12px;font-weight:600;color:#888;font-size:11px;text-transform:uppercase;">Client</th>
            <th style="text-align:left;padding:8px 12px;font-weight:600;color:#888;font-size:11px;text-transform:uppercase;">Podcast</th>
            <th style="text-align:left;padding:8px 12px;font-weight:600;color:#888;font-size:11px;text-transform:uppercase;">Episode Link</th>
            <th style="text-align:left;padding:8px 12px;font-weight:600;color:#888;font-size:11px;text-transform:uppercase;">Ordered</th>
            <th style="text-align:left;padding:8px 12px;font-weight:600;color:#888;font-size:11px;text-transform:uppercase;">Status</th>
            <th style="text-align:left;padding:8px 12px;font-weight:600;color:#888;font-size:11px;text-transform:uppercase;">Action</th>
          </tr>
        </thead>
        <tbody>
          ${data.orders.map((o) => {
            const col   = statusColor[o.content_boost_status] || '#888';
            const label = statusLabel[o.content_boost_status] || o.content_boost_status;
            const orderedAt = o.content_boost_ordered_at
              ? new Date(o.content_boost_ordered_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
              : '—';
            const episodeLink = o.content_boost_episode_url
              ? `<a href="${esc(o.content_boost_episode_url)}" target="_blank" style="color:#6366f1;text-decoration:underline;">Open link</a>`
              : '<span style="color:#bbb;">Not submitted yet</span>';
            return `
              <tr style="border-bottom:1px solid var(--border-subtle,#f5f5f5);">
                <td style="padding:12px;"><div style="font-weight:600;">${esc(o.clients?.name || '—')}</div><div style="font-size:11px;color:#888;">${esc(o.clients?.email || '')}</div></td>
                <td style="padding:12px;">${esc(o.podcasts?.title || '—')}</td>
                <td style="padding:12px;">${episodeLink}</td>
                <td style="padding:12px;color:#888;">${orderedAt}</td>
                <td style="padding:12px;"><span style="background:${col}20;color:${col};font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;">${label}</span></td>
                <td style="padding:12px;">
                  ${o.content_boost_status === 'ordered'
                    ? `<button class="btn btn-success btn-sm" onclick="completeBoostOrder('${o.id}')" style="font-size:12px;padding:6px 14px;">✓ Mark Complete</button>`
                    : o.content_boost_status === 'completed'
                      ? '<span style="color:#30D158;font-size:12px;font-weight:600;">✓ Done</span>'
                      : '<span style="color:#bbb;font-size:12px;">Awaiting payment</span>'}
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    el.innerHTML = `<p style="color:red;font-size:13px;">Error: ${esc(err.message)}</p>`;
  }
}

async function completeBoostOrder(matchId) {
  if (!confirm('Mark this Content Boost as complete and email the client?')) return;
  try {
    const res  = await fetch('/api/operator/content-boost/complete', {
      method:  'POST',
      headers: { 'x-operator-key': OPERATOR_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ matchId }),
    });
    const data = await res.json();
    if (data.success) {
      showToast('Marked complete. Client has been emailed.', 'success');
      loadContentBoostOrders();
    } else {
      showToast(data.error || 'Failed.', 'error');
    }
  } catch (err) {
    showToast('Network error: ' + err.message, 'error');
  }
}
window.completeBoostOrder       = completeBoostOrder;
window.loadContentBoostOrders   = loadContentBoostOrders;

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
window.checkPassword      = checkPassword;
window.loadClients        = loadClients;
window.runPipeline        = runPipeline;
window.toggleActive       = toggleActive;
window.addPodcastManually = addPodcastManually;
