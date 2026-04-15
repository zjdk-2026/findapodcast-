'use strict';

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const { sendDraft, createDraft } = require('../services/gmailService');
const { writeEmail } = require('../services/emailWriter');
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
    // Fetch match + podcast + client for email writing
    const { data: match, error: fetchError } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(*), clients(*, gmail_refresh_token)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (fetchError || !match) return res.status(404).json({ success: false, error: 'Match not found.' });

    // Mark approved
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .select()
      .single();

    if (error) { logger.error('Failed to approve match', { matchId, error: error.message }); return res.status(500).json({ success: false, error: 'Failed to approve match.' }); }

    // Write email now (fire-and-forget so response is instant)
    if (!match.email_subject) {
      (async () => {
        try {
          const email = await writeEmail(match.clients, match, match.podcasts);
          // A/B: randomly assign which subject variant to use for this draft
          const useVariantB = email.subject_b && Math.random() < 0.5;
          const chosenSubject = useVariantB ? email.subject_b : email.subject;
          let gmailDraftId = null;
          if (match.clients?.gmail_refresh_token) {
            const contactEmail = match.podcasts?.contact_email || null;
            if (contactEmail?.includes('@')) {
              gmailDraftId = await createDraft(match.clients.gmail_refresh_token, contactEmail, chosenSubject, email.body, null).catch(() => null);
            }
          }
          await supabase.from('podcast_matches').update({
            email_subject:          email.subject,
            email_subject_b:        email.subject_b || null,
            email_subject_variant:  useVariantB ? 'b' : 'a',
            email_body:             email.body,
            gmail_draft_id:         gmailDraftId,
          }).eq('id', matchId);
          logger.info('Email written on approve', { matchId });
        } catch (err) {
          logger.warn('Email write on approve failed', { matchId, error: err.message });
        }
      })();
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
 * POST /api/restore
 * Moves a dismissed match back to 'new' status.
 */
router.post('/restore', async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({ status: 'new', restored_at: new Date().toISOString() })
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .select()
      .single();

    if (error) { logger.error('Failed to restore match', { matchId, error: error.message }); return res.status(500).json({ success: false, error: 'Failed to restore match.' }); }
    if (!data)  return res.status(404).json({ success: false, error: 'Match not found.' });

    logger.info('Match restored to new', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Restore route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/dream
 */
router.post('/dream', async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });
  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({ status: 'dream' })
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .select()
      .single();
    if (error) { logger.error('Failed to dream match', { matchId, error: error.message }); return res.status(500).json({ success: false, error: 'Failed.' }); }
    if (!data) return res.status(404).json({ success: false, error: 'Match not found.' });
    logger.info('Match added to dream', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Dream route error', { matchId, error: err.message });
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
      .select('*, podcasts(contact_email), clients(gmail_refresh_token, name)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (matchError || !match) {
      logger.warn('/api/send match lookup failed', { matchId, clientId: req.clientId, supabaseError: matchError?.message });
      return res.status(404).json({ success: false, error: 'Match not found.' });
    }

    if (match.clients?.gmail_refresh_token) {
      try {
        let draftId = match.gmail_draft_id;
        // No draft yet but we have email content — create one now
        const emailSubject = match.email_subject_edited || match.email_subject || '';
        const emailBody    = match.email_body_edited    || match.email_body    || '';
        const contactEmail = match.podcasts?.contact_email || null;
        if (!contactEmail?.includes('@')) {
          return res.status(400).json({ success: false, error: 'No contact email found for this podcast. Use the DM Template to reach out via social media instead.' });
        }
        if (!draftId && emailBody) {
          draftId = await createDraft(match.clients.gmail_refresh_token, contactEmail, emailSubject, emailBody, null);
        }
        if (!draftId) {
          return res.status(400).json({ success: false, error: 'Pitch email not ready. Write your pitch first then try again.' });
        }
        const sentMsg = await sendDraft(match.clients.gmail_refresh_token, draftId);
        logger.info('Gmail draft sent', { matchId, draftId });
        if (sentMsg?.threadId) {
          await supabase.from('podcast_matches').update({ gmail_thread_id: sentMsg.threadId }).eq('id', matchId);
        }
      } catch (gmailErr) {
        logger.warn('Gmail send failed', { matchId, error: gmailErr.message });
        return res.status(500).json({ success: false, error: 'Gmail send failed. Make sure your Gmail is connected and try again.' });
      }
    } else {
      return res.status(400).json({ success: false, error: 'Gmail not connected. Connect your Gmail account first to send emails.' });
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
 * POST /api/send-thankyou
 * Sends a thank you email via Gmail without changing match status (stays 'appeared')
 */
router.post('/send-thankyou', async (req, res) => {
  const { matchId, subject, body } = req.body;
  if (!matchId || !subject || !body) return res.status(400).json({ success: false, error: 'matchId, subject, and body are required.' });

  try {
    const { data: match, error: matchError } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(contact_email), clients(gmail_refresh_token, name)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (matchError || !match) return res.status(404).json({ success: false, error: 'Match not found.' });
    if (!match.clients?.gmail_refresh_token) return res.status(400).json({ success: false, error: 'Gmail not connected. Connect your Gmail account first to send emails.' });

    const contactEmail = match.podcasts?.contact_email || null;
    if (!contactEmail?.includes('@')) return res.status(400).json({ success: false, error: 'No contact email found for this podcast.' });

    const draftId = await createDraft(match.clients.gmail_refresh_token, contactEmail, subject, body, null).catch(() => null);
    if (!draftId) return res.status(500).json({ success: false, error: 'Could not create draft. Try again.' });

    await sendDraft(match.clients.gmail_refresh_token, draftId);
    logger.info('Thank you email sent', { matchId });
    return res.json({ success: true });
  } catch (err) {
    logger.error('Send thank you error', { matchId, error: err.message });
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
    // Fetch match with podcast + client so we can send the congrats email
    const { data: matchFull, error: fetchErr } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(*), clients(*)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (fetchErr || !matchFull) return res.status(404).json({ success: false, error: 'Match not found.' });

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

    // Send congrats email via Resend (fire-and-forget)
    (async () => {
      try {
        const apiKey   = process.env.RESEND_API_KEY;
        const fromEmail = process.env.RESEND_FROM_EMAIL || 'hi@zacdeane.com';
        if (!apiKey) return;

        const client = matchFull.clients || {};
        const podcast = matchFull.podcasts || {};
        if (!client.email) return;

        const firstName = (client.name || '').split(' ')[0] || 'there';
        const podcastTitle = podcast.title || 'the podcast';

        const html = `
<p>Hi ${firstName},</p>
<p>You're booked on <strong>${podcastTitle}</strong>. Well done.</p>
<p>A few things to do now:</p>
<ul>
<li>Confirm the date and time with the host</li>
<li>Prepare your core story and your CTA</li>
<li>Think about what you want listeners to do after they hear you</li>
</ul>
<p>Want to turn this episode into 30 days of content? Our team handles the editing, captions, YouTube cut, and written posts. Reply to this email and we'll tell you how it works.</p>
<p>Keep going,<br>Zac</p>`;

        await fetch('https://api.resend.com/emails', {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            from:    fromEmail,
            to:      [client.email],
            subject: 'You just got booked.',
            html,
          }),
        });
        logger.info('Booking congrats email sent', { matchId, clientEmail: client.email });
      } catch (emailErr) {
        logger.warn('Booking congrats email failed', { matchId, error: emailErr.message });
      }
    })();

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
      .update({ status: 'sent', booked_at: null })
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
 * POST /api/appeared
 */
router.post('/appeared', async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });
  try {
    const { data, error } = await supabase
      .from('podcast_matches')
      .update({ status: 'appeared' })
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .select()
      .single();
    if (error) return res.status(500).json({ success: false, error: 'Failed to update status.' });
    if (!data)  return res.status(404).json({ success: false, error: 'Match not found.' });
    logger.info('Match marked as appeared', { matchId });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Appeared route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/update-status
 * Generic status update used by drag-and-drop.
 */
const VALID_STATUSES = ['new', 'sent', 'followed_up', 'replied', 'booked', 'appeared', 'dream', 'dismissed'];
router.post('/update-status', async (req, res) => {
  const { matchId, status } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'Invalid status.' });
  try {
    const updateFields = { status };
    if (status === 'sent') updateFields.sent_at = new Date().toISOString();
    if (status === 'booked') updateFields.booked_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('podcast_matches')
      .update(updateFields)
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .select()
      .single();
    if (error) return res.status(500).json({ success: false, error: 'Failed to update status.' });
    if (!data)  return res.status(404).json({ success: false, error: 'Match not found.' });
    logger.info('Match status updated', { matchId, status });
    return res.json({ success: true, match: data });
  } catch (err) {
    logger.error('Update-status route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/send-followup
 * Sends a manually composed follow-up email via Gmail.
 */
router.post('/send-followup', async (req, res) => {
  const { matchId, subject, body } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });
  if (!body)    return res.status(400).json({ success: false, error: 'Email body is required.' });
  try {
    const { data: match, error: fetchError } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(contact_email, title), clients(gmail_refresh_token)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();
    if (fetchError || !match) return res.status(404).json({ success: false, error: 'Match not found.' });

    let gmailSent = false;
    if (match.clients?.gmail_refresh_token) {
      const contactEmail = match.podcasts?.contact_email || null;
      if (contactEmail?.includes('@')) {
        try {
          const draftId = await createDraft(match.clients.gmail_refresh_token, contactEmail, subject || `Following up: ${match.podcasts?.title || 'your show'}`, body);
          await sendDraft(match.clients.gmail_refresh_token, draftId);
          gmailSent = true;
          logger.info('Follow-up email sent', { matchId });
        } catch (gmailErr) {
          logger.warn('Follow-up Gmail send failed', { matchId, error: gmailErr.message });
        }
      }
    }

    await supabase.from('podcast_matches').update({ follow_up_sent: true, status: 'followed_up' }).eq('id', matchId).eq('client_id', req.clientId);
    return res.json({ success: true, gmailSent });
  } catch (err) {
    logger.error('Send-followup route error', { matchId, error: err.message });
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
