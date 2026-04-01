'use strict';

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const { sendDraft } = require('../services/gmailService');
const requireDashboardToken = require('../middleware/requireDashboardToken');

const router = express.Router();

// All action routes require a valid dashboard token
router.use(requireDashboardToken);

/**
 * POST /api/approve
 */
router.post('/approve', async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .select()
      .single();

    if (error) { logger.error('Failed to approve match', { matchId, error: error.message }); return res.status(500).json({ success: false, error: 'Failed to approve match.' }); }
    if (!data)  return res.status(404).json({ success: false, error: 'Match not found.' });

    logger.info('Match approved', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Approve route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/dismiss
 */
router.post('/dismiss', async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({ status: 'dismissed' })
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .select()
      .single();

    if (error) { logger.error('Failed to dismiss match', { matchId, error: error.message }); return res.status(500).json({ success: false, error: 'Failed to dismiss match.' }); }
    if (!data)  return res.status(404).json({ success: false, error: 'Match not found.' });

    logger.info('Match dismissed', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Dismiss route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/send
 */
router.post('/send', async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data: match, error: matchError } = await supabase
      .from('podcast_matches')
      .select('*, clients(gmail_refresh_token, name)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (matchError || !match) return res.status(404).json({ success: false, error: 'Match not found.' });

    if (match.gmail_draft_id && match.clients?.gmail_refresh_token) {
      try {
        await sendDraft(match.clients.gmail_refresh_token, match.gmail_draft_id);
        logger.info('Gmail draft sent', { matchId, draftId: match.gmail_draft_id });
      } catch (gmailErr) {
        logger.warn('Gmail send failed — marking as sent anyway', { matchId, error: gmailErr.message });
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from('podcast_matches')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .select()
      .single();

    if (updateError) { logger.error('Failed to mark match as sent', { matchId, error: updateError.message }); return res.status(500).json({ success: false, error: 'Failed to update match status.' }); }

    logger.info('Match marked as sent', { matchId });
    return res.json({ success: true, match: updated });
  } catch (err) {
    logger.error('Send route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/book
 */
router.post('/book', async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({ status: 'booked', booked_at: new Date().toISOString() })
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .select()
      .single();

    if (error) { logger.error('Failed to book match', { matchId, error: error.message }); return res.status(500).json({ success: false, error: 'Failed to book match.' }); }
    if (!data)  return res.status(404).json({ success: false, error: 'Match not found.' });

    logger.info('Match booked', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Book route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/unbook
 */
router.post('/unbook', async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({ status: 'approved', booked_at: null })
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .select()
      .single();

    if (error) { logger.error('Failed to unbook match', { matchId, error: error.message }); return res.status(500).json({ success: false, error: 'Failed to unbook match.' }); }
    if (!data)  return res.status(404).json({ success: false, error: 'Match not found.' });

    logger.info('Match unbooked', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Unbook route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/notes
 */
router.post('/notes', async (req, res) => {
  const { matchId, notes } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({ client_notes: notes || null })
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .select()
      .single();

    if (error) { logger.error('Failed to save notes', { matchId, error: error.message }); return res.status(500).json({ success: false, error: 'Failed to save notes.' }); }
    if (!data)  return res.status(404).json({ success: false, error: 'Match not found.' });

    logger.info('Match notes saved', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Notes route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/email/edit
 */
router.post('/email/edit', async (req, res) => {
  const { matchId, subject, body } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({ email_subject_edited: subject || null, email_body_edited: body || null })
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .select()
      .single();

    if (error) { logger.error('Failed to save edited email', { matchId, error: error.message }); return res.status(500).json({ success: false, error: 'Failed to save email edits.' }); }
    if (!data)  return res.status(404).json({ success: false, error: 'Match not found.' });

    logger.info('Email edits saved', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Email edit route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/template
 */
router.post('/template', async (req, res) => {
  const { template } = req.body;

  try {
    const { data, error } = await supabase
      .from('clients')
      .update({ email_template: template || null })
      .eq('id', req.clientId)
      .select('id, email_template')
      .single();

    if (error) { logger.error('Failed to save template', { clientId: req.clientId, error: error.message }); return res.status(500).json({ success: false, error: 'Failed to save template.' }); }

    logger.info('Email template saved', { clientId: req.clientId });
    return res.json({ success: true, client: data });
  } catch (err) {
    logger.error('Template route error', { clientId: req.clientId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
