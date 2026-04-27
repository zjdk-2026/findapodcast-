'use strict';

/**
 * Email template routes.
 *
 * GET    /api/templates                      — list all saved templates for the client
 * GET    /api/templates?type=pitch           — filter by type
 * POST   /api/templates                      — save a new template
 * PATCH  /api/templates/:id                  — update a template
 * DELETE /api/templates/:id                  — delete a template
 * POST   /api/templates/:id/apply/:matchId   — apply a template to a match
 *                                              (substitutes placeholders, writes
 *                                              to email_subject_edited / email_body_edited)
 *
 * Placeholders supported (case-insensitive):
 *   {host_name}, {host_first_name}, {podcast_title},
 *   {client_name}, {client_first_name},
 *   {one_liner}, {credential}, {business_name}
 */

const express = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const requireDashboardToken = require('../middleware/requireDashboardToken');

const router = express.Router();
router.use(requireDashboardToken);

// ── GET /api/templates ───────────────────────────────────────────────────
router.get('/templates', async (req, res) => {
  const type = req.query.type;
  let q = supabase.from('email_templates')
    .select('*')
    .eq('client_id', req.clientId)
    .order('use_count', { ascending: false });
  if (type) q = q.eq('type', type);
  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, templates: data || [] });
});

// ── POST /api/templates ──────────────────────────────────────────────────
router.post('/templates', async (req, res) => {
  const { type, name, subject, body, is_default } = req.body || {};
  if (!type || !name || !subject || !body) {
    return res.status(400).json({ ok: false, error: 'type_name_subject_body_required' });
  }
  if (!['pitch','followup','thankyou','discovery'].includes(type)) {
    return res.status(400).json({ ok: false, error: 'invalid_type' });
  }

  // If this is being marked as default, unmark any existing default for this type
  if (is_default) {
    await supabase.from('email_templates')
      .update({ is_default: false })
      .eq('client_id', req.clientId)
      .eq('type', type);
  }

  const { data, error } = await supabase.from('email_templates').insert({
    client_id:  req.clientId,
    type,
    name:       name.trim(),
    subject:    subject.trim(),
    body:       body.trim(),
    is_default: !!is_default,
  }).select().single();

  if (error) {
    logger.error('template insert failed', { error: error.message });
    return res.status(500).json({ ok: false, error: error.message });
  }
  res.json({ ok: true, template: data });
});

// ── PATCH /api/templates/:id ─────────────────────────────────────────────
router.patch('/templates/:id', async (req, res) => {
  const { id } = req.params;
  const { name, subject, body, is_default } = req.body || {};
  const patch = { updated_at: new Date().toISOString() };
  if (name !== undefined)       patch.name = name.trim();
  if (subject !== undefined)    patch.subject = subject.trim();
  if (body !== undefined)       patch.body = body.trim();
  if (is_default !== undefined) patch.is_default = !!is_default;

  // If being made default, unmark existing default of same type
  if (is_default) {
    const { data: tpl } = await supabase.from('email_templates').select('type').eq('id', id).eq('client_id', req.clientId).single();
    if (tpl) {
      await supabase.from('email_templates').update({ is_default: false }).eq('client_id', req.clientId).eq('type', tpl.type);
    }
  }

  const { data, error } = await supabase.from('email_templates')
    .update(patch).eq('id', id).eq('client_id', req.clientId).select().single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: 'template_not_found' });
  res.json({ ok: true, template: data });
});

// ── DELETE /api/templates/:id ────────────────────────────────────────────
router.delete('/templates/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('email_templates')
    .delete().eq('id', id).eq('client_id', req.clientId);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

// ── POST /api/templates/:id/apply/:matchId ───────────────────────────────
router.post('/templates/:id/apply/:matchId', async (req, res) => {
  const { id, matchId } = req.params;
  if (!id || !matchId) return res.status(400).json({ ok: false, error: 'id_and_matchId_required' });

  try {
    // Fetch template + match in parallel
    const [tplRes, matchRes] = await Promise.all([
      supabase.from('email_templates').select('*').eq('id', id).eq('client_id', req.clientId).single(),
      supabase.from('podcast_matches')
        .select('id, client_id, podcasts(title, host_name), clients(name, business_name, bio_short)')
        .eq('id', matchId).eq('client_id', req.clientId).single(),
    ]);

    if (tplRes.error || !tplRes.data)     return res.status(404).json({ ok: false, error: 'template_not_found' });
    if (matchRes.error || !matchRes.data) return res.status(404).json({ ok: false, error: 'match_not_found' });

    const tpl   = tplRes.data;
    const match = matchRes.data;
    const podcast = match.podcasts || {};
    const client  = match.clients  || {};

    const replace = (str) => (str || '').replace(/\{(\w+)\}/gi, (_, key) => {
      const k = key.toLowerCase();
      const map = {
        host_name:           podcast.host_name || '',
        host_first_name:     (podcast.host_name || '').split(' ')[0] || '',
        podcast_title:       podcast.title || '',
        client_name:         client.name || '',
        client_first_name:   (client.name || '').split(' ')[0] || '',
        one_liner:           client.bio_short || '',
        business_name:       client.business_name || '',
      };
      return map[k] !== undefined ? map[k] : `{${key}}`;
    });

    const finalSubject = replace(tpl.subject);
    const finalBody    = replace(tpl.body);

    // Write to the match's edited subject/body
    await supabase.from('podcast_matches').update({
      email_subject_edited: finalSubject,
      email_body_edited:    finalBody,
    }).eq('id', matchId).eq('client_id', req.clientId);

    // Bump use count
    await supabase.from('email_templates').update({
      use_count:    (tpl.use_count || 0) + 1,
      last_used_at: new Date().toISOString(),
    }).eq('id', id).eq('client_id', req.clientId);

    res.json({ ok: true, subject: finalSubject, body: finalBody });
  } catch (err) {
    logger.error('template apply error', { id, matchId, error: err.message });
    res.status(500).json({ ok: false, error: 'apply_failed' });
  }
});

module.exports = router;
