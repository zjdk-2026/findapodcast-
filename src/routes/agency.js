'use strict';

const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const logger = require('../lib/logger');
const path = require('path');

const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'hi@findapodcast.io';
const OPERATOR_KEY      = process.env.OPERATOR_KEY || 'pipeline2026';
const BASE_URL          = process.env.BASE_URL || 'https://findapodcast.io';

// ═══════════════════════════════════════════════════════════════════════════
// Agency workspace — multi-client management for podcast agencies
// ═══════════════════════════════════════════════════════════════════════════

// GET /agency/:token — serves the agency dashboard HTML
router.get('/agency/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'dashboard', 'agency.html'));
});

// GET /api/agency/:token — returns agency info + all their clients with stats
router.get('/api/agency/:token', async (req, res) => {
  const { token } = req.params;
  if (!token || token.length < 8) return res.status(400).json({ ok: false, error: 'invalid_token' });

  const { data: agency, error: aErr } = await supabase
    .from('agencies').select('*').eq('dashboard_token', token).single();
  if (aErr || !agency) return res.status(404).json({ ok: false, error: 'agency_not_found' });

  const { data: clients } = await supabase
    .from('clients')
    .select('id,name,email,dashboard_token,created_at,last_run_at,gmail_refresh_token,gmail_email,onboarded_at,is_active')
    .eq('agency_id', agency.id)
    .order('created_at', { ascending: false });

  const stats = await Promise.all((clients || []).map(async (c) => {
    const { data: matches } = await supabase
      .from('podcast_matches')
      .select('status', { count: 'exact' })
      .eq('client_id', c.id);
    const totals = { pitched: 0, booked: 0, aired: 0, replied: 0 };
    (matches || []).forEach((m) => {
      if (['pitched','followed_up','replied','booked','aired'].includes(m.status)) totals.pitched++;
      if (m.status === 'replied') totals.replied++;
      if (m.status === 'booked' || m.status === 'aired') totals.booked++;
      if (m.status === 'aired') totals.aired++;
    });
    return { ...c, stats: totals, gmail_connected: !!c.gmail_refresh_token };
  }));

  res.json({ ok: true, agency: { id: agency.id, name: agency.name, contact_email: agency.contact_email, status: agency.status }, clients: stats });
});

// POST /api/agency/:token/request-client — agency submits a new client to onboard
router.post('/api/agency/:token/request-client', async (req, res) => {
  const { token } = req.params;
  const { client_name, client_email, notes } = req.body || {};

  if (!client_name || !client_email) return res.status(400).json({ ok: false, error: 'name_and_email_required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(client_email)) return res.status(400).json({ ok: false, error: 'invalid_email' });

  const { data: agency, error: aErr } = await supabase
    .from('agencies').select('*').eq('dashboard_token', token).single();
  if (aErr || !agency) return res.status(404).json({ ok: false, error: 'agency_not_found' });
  if (agency.status !== 'active') return res.status(403).json({ ok: false, error: 'agency_inactive' });

  const { data: request, error: rErr } = await supabase
    .from('agency_client_requests')
    .insert({
      agency_id:    agency.id,
      client_name:  client_name.trim(),
      client_email: client_email.trim().toLowerCase(),
      notes:        (notes || '').trim() || null,
    })
    .select().single();

  if (rErr) {
    logger.error('agency client request insert failed', { error: rErr.message });
    return res.status(500).json({ ok: false, error: 'save_failed' });
  }

  // Email Zac so he can onboard the client
  try {
    if (RESEND_API_KEY) {
      const html = `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:540px;margin:0 auto;padding:24px;background:#fff;color:#1d1d1f;">
          <div style="background:#6366f1;color:#fff;padding:16px 20px;border-radius:12px;margin-bottom:20px;">
            <div style="font-size:13px;opacity:0.85;font-weight:600;letter-spacing:0.05em;">NEW AGENCY CLIENT REQUEST</div>
            <div style="font-size:20px;font-weight:800;margin-top:4px;">${esc(agency.name)}</div>
          </div>
          <table style="width:100%;font-size:14px;line-height:1.6;">
            <tr><td style="padding:6px 0;color:#6e6e73;width:110px;">Client</td><td style="padding:6px 0;font-weight:600;">${esc(client_name)}</td></tr>
            <tr><td style="padding:6px 0;color:#6e6e73;">Email</td><td style="padding:6px 0;"><a href="mailto:${esc(client_email)}" style="color:#6366f1;">${esc(client_email)}</a></td></tr>
            ${notes ? `<tr><td style="padding:6px 0;color:#6e6e73;vertical-align:top;">Notes</td><td style="padding:6px 0;white-space:pre-wrap;">${esc(notes)}</td></tr>` : ''}
            <tr><td style="padding:6px 0;color:#6e6e73;">Agency contact</td><td style="padding:6px 0;"><a href="mailto:${esc(agency.contact_email)}" style="color:#6366f1;">${esc(agency.contact_email)}</a></td></tr>
          </table>
          <div style="margin-top:24px;padding:16px;background:#f5f5f7;border-radius:10px;font-size:13px;color:#6e6e73;">
            <div style="font-weight:600;color:#1d1d1f;margin-bottom:6px;">Next steps</div>
            1. Create the client record linked to this agency<br>
            2. Send them the onboarding link<br>
            3. Mark request as onboarded: <code>UPDATE agency_client_requests SET status='onboarded', handled_at=now() WHERE id='${request.id}'</code>
          </div>
          <div style="margin-top:16px;font-size:12px;color:#aeaeb2;">Request ID: ${request.id}</div>
        </div>`;
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: RESEND_FROM_EMAIL,
          to: ['hi@zacdeane.com'],
          reply_to: agency.contact_email,
          subject: `[Agency] ${agency.name} — onboard ${client_name}`,
          html,
        }),
      });
    }
  } catch (err) {
    logger.warn('agency client request email failed (saved anyway)', { error: err.message });
  }

  res.json({ ok: true, request_id: request.id });
});

// ── Operator endpoints — used by Zac to create agencies + onboard their clients
router.post('/api/operator/create-agency', async (req, res) => {
  if (req.headers['x-operator-key'] !== OPERATOR_KEY && req.query.key !== OPERATOR_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { name, contact_name, contact_email, notes } = req.body || {};
  if (!name || !contact_email) return res.status(400).json({ ok: false, error: 'name_and_email_required' });

  const token = require('crypto').randomUUID();
  const { data, error } = await supabase.from('agencies').insert({
    name, contact_name: contact_name || null, contact_email, notes: notes || null,
    dashboard_token: token, status: 'active',
  }).select().single();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, agency: data, dashboard_url: `${BASE_URL}/agency/${data.dashboard_token}` });
});

router.post('/api/operator/link-client-to-agency', async (req, res) => {
  if (req.headers['x-operator-key'] !== OPERATOR_KEY && req.query.key !== OPERATOR_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { client_id, agency_id } = req.body || {};
  if (!client_id || !agency_id) return res.status(400).json({ ok: false, error: 'client_id_and_agency_id_required' });

  const { error } = await supabase.from('clients').update({ agency_id }).eq('id', client_id);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

module.exports = router;
