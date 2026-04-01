'use strict';

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const { sendDraft } = require('../services/gmailService');

const router = express.Router();

/**
 * POST /api/approve
 * Body: { matchId }
 * Sets status = 'approved', approved_at = now()
 */
router.post('/approve', async (req, res) => {
  const { matchId } = req.body;

  if (!matchId) {
    return res.status(400).json({ success: false, error: 'matchId is required.' });
  }

  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({
        status:      'approved',
        approved_at: new Date().toISOString(),
      })
      .eq('id', matchId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to approve match', { matchId, error: error.message });
      return res.status(500).json({ success: false, error: 'Failed to approve match.' });
    }

    if (!data) {
      return res.status(404).json({ success: false, error: 'Match not found.' });
    }

    logger.info('Match approved', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Approve route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/dismiss
 * Body: { matchId }
 * Sets status = 'dismissed'
 */
router.post('/dismiss', async (req, res) => {
  const { matchId } = req.body;

  if (!matchId) {
    return res.status(400).json({ success: false, error: 'matchId is required.' });
  }

  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({ status: 'dismissed' })
      .eq('id', matchId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to dismiss match', { matchId, error: error.message });
      return res.status(500).json({ success: false, error: 'Failed to dismiss match.' });
    }

    if (!data) {
      return res.status(404).json({ success: false, error: 'Match not found.' });
    }

    logger.info('Match dismissed', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Dismiss route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/send
 * Body: { matchId }
 * Sets status = 'sent', sent_at = now()
 * If gmail_draft_id exists on the match, sends the draft via Gmail API.
 */
router.post('/send', async (req, res) => {
  const { matchId } = req.body;

  if (!matchId) {
    return res.status(400).json({ success: false, error: 'matchId is required.' });
  }

  try {
    // Fetch the match with client info (for gmail token)
    const { data: match, error: matchError } = await supabase
      .from('podcast_matches')
      .select('*, clients(gmail_refresh_token, name)')
      .eq('id', matchId)
      .single();

    if (matchError || !match) {
      return res.status(404).json({ success: false, error: 'Match not found.' });
    }

    // Send Gmail draft if available
    if (match.gmail_draft_id && match.clients?.gmail_refresh_token) {
      try {
        await sendDraft(match.clients.gmail_refresh_token, match.gmail_draft_id);
        logger.info('Gmail draft sent via action', { matchId, draftId: match.gmail_draft_id });
      } catch (gmailErr) {
        logger.warn('Gmail send failed — marking as sent anyway', {
          matchId,
          error: gmailErr.message,
        });
      }
    }

    // Update status
    const { data: updated, error: updateError } = await supabase
      .from('podcast_matches')
      .update({
        status:  'sent',
        sent_at: new Date().toISOString(),
      })
      .eq('id', matchId)
      .select()
      .single();

    if (updateError) {
      logger.error('Failed to mark match as sent', { matchId, error: updateError.message });
      return res.status(500).json({ success: false, error: 'Failed to update match status.' });
    }

    logger.info('Match marked as sent', { matchId });
    return res.json({ success: true, match: updated });
  } catch (err) {
    logger.error('Send route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/book
 * Body: { matchId }
 * Sets status = 'booked', booked_at = now()
 */
router.post('/book', async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({ status: 'booked', booked_at: new Date().toISOString() })
      .eq('id', matchId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to book match', { matchId, error: error.message });
      return res.status(500).json({ success: false, error: 'Failed to book match.' });
    }
    if (!data) return res.status(404).json({ success: false, error: 'Match not found.' });

    logger.info('Match booked', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Book route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/unbook
 * Body: { matchId }
 * Reverts status back to 'approved', clears booked_at
 */
router.post('/unbook', async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({ status: 'approved', booked_at: null })
      .eq('id', matchId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to unbook match', { matchId, error: error.message });
      return res.status(500).json({ success: false, error: 'Failed to unbook match.' });
    }
    if (!data) return res.status(404).json({ success: false, error: 'Match not found.' });

    logger.info('Match unbooked', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Unbook route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/notes
 * Body: { matchId, notes }
 * Saves client_notes to the match.
 */
router.post('/notes', async (req, res) => {
  const { matchId, notes } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({ client_notes: notes || null })
      .eq('id', matchId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to save notes', { matchId, error: error.message });
      return res.status(500).json({ success: false, error: 'Failed to save notes.' });
    }
    if (!data) return res.status(404).json({ success: false, error: 'Match not found.' });

    logger.info('Match notes saved', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Notes route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/email/edit
 * Body: { matchId, subject, body }
 * Saves email_subject_edited and email_body_edited.
 */
router.post('/email/edit', async (req, res) => {
  const { matchId, subject, body } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({
        email_subject_edited: subject || null,
        email_body_edited:    body    || null,
      })
      .eq('id', matchId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to save edited email', { matchId, error: error.message });
      return res.status(500).json({ success: false, error: 'Failed to save email edits.' });
    }
    if (!data) return res.status(404).json({ success: false, error: 'Match not found.' });

    logger.info('Email edits saved', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Email edit route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/template
 * Body: { clientId, template }
 * Saves a custom email template for the client.
 */
router.post('/template', async (req, res) => {
  const { clientId, template } = req.body;
  if (!clientId) return res.status(400).json({ success: false, error: 'clientId is required.' });

  try {
    const { data, error } = await supabase
      .from('clients')
      .update({ email_template: template || null })
      .eq('id', clientId)
      .select('id, email_template')
      .single();

    if (error) {
      logger.error('Failed to save template', { clientId, error: error.message });
      return res.status(500).json({ success: false, error: 'Failed to save template.' });
    }

    logger.info('Email template saved', { clientId });
    return res.json({ success: true, client: data });
  } catch (err) {
    logger.error('Template route error', { clientId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
