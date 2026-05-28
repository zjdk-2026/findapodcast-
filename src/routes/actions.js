'use strict';

const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const { sendEmail } = require('../services/resendMailService');
const { createDraft, sendDraft } = require('../services/gmailService');
const { writeEmail } = require('../services/emailWriter');
const { chargeCredits, awardPoints } = require('../lib/credits');
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
          await supabase.from('podcast_matches').update({
            email_subject:          email.subject,
            email_subject_b:        email.subject_b || null,
            email_subject_variant:  useVariantB ? 'b' : 'a',
            email_body:             email.body,
            gmail_draft_id:         null,
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

  // Demo gate: prospects in demo mode can't actually send.
  const { requireNotDemo } = require('../lib/demo');
  const demoCheck = await requireNotDemo(req.clientId);
  if (!demoCheck.allowed) return res.status(demoCheck.status).json(demoCheck.body);

  // Credit gate: pitch send costs 1 credit (skipped for unlimited Tour customers)
  const charge = await chargeCredits(req.clientId, 'pitch_send', { matchId });
  if (!charge.ok) {
    if (charge.error === 'insufficient_credits') {
      return res.status(402).json({ success: false, error: 'insufficient_credits', balance: charge.balance, needed: charge.needed });
    }
    return res.status(500).json({ success: false, error: 'credit_charge_failed' });
  }

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

    // ── SEND (Gmail preferred when connected, Resend fallback) ──────────
    const emailSubject = (match.email_subject_edited || match.email_subject || '').trim();
    const emailBody    = (match.email_body_edited    || match.email_body    || '').trim();
    const contactEmail = match.podcasts?.contact_email || null;
    if (!contactEmail?.includes('@')) {
      return res.status(400).json({ success: false, error: 'No contact email found for this podcast. Use the DM Template to reach out via social media instead.' });
    }
    if (!emailSubject) {
      return res.status(400).json({ success: false, error: 'Pitch has no subject line. Open "Write Pitch Email" to compose it first.' });
    }
    if (!emailBody) {
      return res.status(400).json({ success: false, error: 'Pitch has no body. Open "Write Pitch Email" to compose it first.' });
    }

    // Fetch audio attachment ONCE, normalize for both Gmail and Resend shapes
    let audioBuffer = null;
    let audioMime = null;
    let audioFilename = null;
    if (match.audio_attachment_path) {
      try {
        const { data: audioBlob, error: dlErr } = await supabase.storage
          .from('pitch-audio')
          .download(match.audio_attachment_path);
        if (!dlErr && audioBlob) {
          audioBuffer = Buffer.from(await audioBlob.arrayBuffer());
          audioMime = match.audio_attachment_mime || 'audio/webm';
          audioFilename = match.audio_attachment_filename || 'voice-intro.webm';
        } else if (dlErr) {
          logger.warn('Could not fetch pitch audio for send', { matchId, error: dlErr.message });
        }
      } catch (audioErr) {
        logger.warn('Audio fetch error during send', { matchId, error: audioErr.message });
      }
    }

    const gmailRefreshToken = match.clients?.gmail_refresh_token || null;
    let sentMessageId = null;
    let sentFromEmail = null;

    if (gmailRefreshToken) {
      // ── Gmail path: send from the customer's connected Gmail ──────────
      try {
        const audioAttachment = audioBuffer
          ? { buffer: audioBuffer, mime: audioMime, filename: audioFilename }
          : null;
        const draftId = await createDraft(gmailRefreshToken, contactEmail, emailSubject, emailBody, null, audioAttachment);
        const sent = await sendDraft(gmailRefreshToken, draftId);
        sentMessageId = sent.id;
        sentFromEmail = null; // Gmail sets the From header to the connected mailbox automatically
      } catch (gmailErr) {
        const msg = gmailErr.message || 'Gmail send failed';
        logger.warn('Gmail send failed', { matchId, error: msg });
        return res.status(500).json({ success: false, error: `Gmail send failed: ${msg}. Try reconnecting Gmail in Settings.` });
      }
    } else {
      // ── Resend fallback: for customers without Gmail connected ────────
      try {
        // Threading headers (only present if there are prior messages in this thread)
        let inReplyTo = null;
        let references = null;
        const { data: latestMsg } = await supabase
          .from('match_thread_messages')
          .select('rfc822_message_id')
          .eq('match_id', matchId)
          .not('rfc822_message_id', 'is', null)
          .order('sent_at', { ascending: false })
          .limit(1)
          .single();
        if (latestMsg?.rfc822_message_id) {
          inReplyTo = latestMsg.rfc822_message_id;
          references = latestMsg.rfc822_message_id;
        }

        const attachments = audioBuffer
          ? [{ filename: audioFilename, content: audioBuffer, mime: audioMime }]
          : null;

        const sentResult = await sendEmail({
          to: contactEmail,
          subject: emailSubject,
          body: emailBody,
          inReplyTo: inReplyTo || undefined,
          references: references || undefined,
          attachments: attachments || undefined,
        });
        sentMessageId = sentResult.id;
        sentFromEmail = sentResult.from || null;
      } catch (sendErr) {
        const resendDetail = sendErr.resendData?.message
          || sendErr.resendData?.error
          || sendErr.message
          || 'Unknown error';
        logger.warn('Resend send failed', { matchId, error: sendErr.message, status: sendErr.status, resendData: sendErr.resendData });
        return res.status(500).json({ success: false, error: `Email send failed: ${resendDetail}. Connect Gmail in Settings to send from your own inbox.` });
      }
    }

    // Update match with sent message info (field names stay for DB compatibility)
    const updates = {
      gmail_message_id:       sentMessageId,
      gmail_pitch_message_id: sentMessageId,
      last_message_at:        new Date().toISOString(),
      message_count:          (match.message_count || 0) + 1,
    };
    await supabase.from('podcast_matches').update(updates).eq('id', matchId);

    // Log outbound message for the thread view
    try {
      await supabase.from('match_thread_messages').insert({
        match_id:           matchId,
        gmail_message_id:   sentMessageId,
        direction:          'outbound',
        message_type:       'pitch',
        from_email:         sentFromEmail,
        to_email:           contactEmail,
        subject:            emailSubject,
        body_text:          emailBody,
        rfc822_message_id:  sentMessageId,
        audio_attached:     !!audioBuffer,
        sent_at:            new Date().toISOString(),
      });
    } catch (logErr) {
      logger.warn('match_thread_messages insert failed (table may not exist yet)', { matchId, error: logErr.message });
    }

    const { data: updated, error: updateError } = await supabase
      .from('podcast_matches')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .select()
      .single();

    if (updateError) { logger.error('Failed to mark match as sent', { matchId, error: updateError.message }); return res.status(500).json({ success: false, error: 'Failed to update match status.' }); }

    // Award voice-intro effort points if audio was attached (separate, +2 pts)
    if (match.audio_attachment_path) {
      awardPoints(req.clientId, 'voice_intro_attached', { matchId }).catch(() => {});
    }

    logger.info('Match marked as sent', { matchId });
    return res.json({ success: true, match: updated, credits_balance: charge.balance });
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

  // Credit gate: thank-you send costs 1 credit
  const charge = await chargeCredits(req.clientId, 'thankyou_send', { matchId });
  if (!charge.ok) {
    if (charge.error === 'insufficient_credits') {
      return res.status(402).json({ success: false, error: 'insufficient_credits', balance: charge.balance, needed: charge.needed });
    }
    return res.status(500).json({ success: false, error: 'credit_charge_failed' });
  }

  try {
    const { data: match, error: matchError } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(contact_email), clients(gmail_refresh_token, name)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (matchError || !match) return res.status(404).json({ success: false, error: 'Match not found.' });

    const contactEmail = match.podcasts?.contact_email || null;
    if (!contactEmail?.includes('@')) return res.status(400).json({ success: false, error: 'No contact email found for this podcast.' });

    await sendEmail({
      to: contactEmail,
      subject,
      body,
    });

    logger.info('Thank you email sent via Resend', { matchId });
    return res.json({ success: true, credits_balance: charge.balance });
  } catch (err) {
    logger.error('Send thank you error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/book
 */
router.post('/book', async (req, res) => {
  const { matchId, showName, recordingAt, notes } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  // Demo gate: prospects can't book — there's nothing to book against (host names are redacted).
  const { requireNotDemo } = require('../lib/demo');
  const demoCheck = await requireNotDemo(req.clientId);
  if (!demoCheck.allowed) return res.status(demoCheck.status).json(demoCheck.body);

  try {
    // Fetch match with podcast + client so we can send the congrats email
    const { data: matchFull, error: fetchErr } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(*), clients(*)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (fetchErr || !matchFull) return res.status(404).json({ success: false, error: 'Match not found.' });

    // Build update payload. We store recording_at + free-form notes inside
    // client_notes (no schema change required) so the dashboard timeline shows
    // when the customer is actually recording.
    const updates = { status: 'booked', booked_at: new Date().toISOString() };
    if (showName && showName.trim()) updates.booked_show_name = showName.trim();
    const noteParts = [];
    if (recordingAt) {
      try {
        const dt = new Date(recordingAt);
        if (!isNaN(dt)) noteParts.push(`Recording: ${dt.toISOString()}`);
      } catch { /* ignore */ }
    }
    if (notes && notes.trim()) noteParts.push(notes.trim());
    if (noteParts.length) updates.client_notes = noteParts.join('\n\n');

    const { data, error } = await supabase
      .from('podcast_matches')
      .update(updates)
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .select()
      .single();

    if (error) { logger.error('Failed to book match', { matchId, error: error.message }); return res.status(500).json({ success: false, error: 'Failed to book match.' }); }
    if (!data)  return res.status(404).json({ success: false, error: 'Match not found.' });

    logger.info('Match booked', { matchId });

    // Award booking outcome points (+50, no credit cost)
    awardPoints(req.clientId, 'booking_confirmed', { matchId, podcastId: matchFull.podcast_id }).catch(() => {});

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

        // Pull recording date from client_notes if the customer entered one
        let recordingLine = '';
        let icsAttachment = null;
        const recMatch = (data.client_notes || '').match(/Recording:\s*([^\n]+)/);
        if (recMatch) {
          try {
            const dt = new Date(recMatch[1].trim());
            if (!isNaN(dt)) {
              const formatted = dt.toLocaleString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
              recordingLine = `<p><strong>Recording:</strong> ${formatted}</p>`;
              // Build an .ics calendar invite — 60 min default duration
              const start = dt;
              const end   = new Date(dt.getTime() + 60 * 60 * 1000);
              const fmt   = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
              const ics = [
                'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Find A Podcast//EN', 'METHOD:PUBLISH',
                'BEGIN:VEVENT',
                `UID:${matchId}@findapodcast.io`,
                `DTSTAMP:${fmt(new Date())}`,
                `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
                `SUMMARY:Podcast recording — ${podcastTitle.replace(/[\r\n,;]/g, ' ')}`,
                `DESCRIPTION:Booked via Find A Podcast.`,
                'END:VEVENT', 'END:VCALENDAR',
              ].join('\r\n');
              icsAttachment = {
                filename: 'podcast-recording.ics',
                content:  Buffer.from(ics, 'utf8').toString('base64'),
              };
            }
          } catch { /* ignore parse errors */ }
        }

        const html = `
<p>Hi ${firstName},</p>
<p>You're booked on <strong>${podcastTitle}</strong>. Well done.</p>
${recordingLine}
<p>A few things to do now:</p>
<ul>
<li>Confirm the date and time with the host</li>
<li>Prepare your core story and your CTA</li>
<li>Think about what you want listeners to do after they hear you</li>
</ul>
<p>Want to turn this episode into 30 days of content? Our team handles the editing, captions, YouTube cut, and written posts. Reply to this email and we'll tell you how it works.</p>
<p>Keep going,<br>Zac</p>`;

        const emailBody = {
          from:    fromEmail,
          to:      [client.email],
          subject: 'You just got booked.',
          html,
        };
        if (icsAttachment) emailBody.attachments = [icsAttachment];

        await fetch('https://api.resend.com/emails', {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify(emailBody),
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

    // Award episode-aired outcome points (+200, no credit cost)
    awardPoints(req.clientId, 'episode_aired', { matchId }).catch(() => {});

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

  // Demo gate
  const { requireNotDemo } = require('../lib/demo');
  const demoCheck = await requireNotDemo(req.clientId);
  if (!demoCheck.allowed) return res.status(demoCheck.status).json(demoCheck.body);

  // Credit gate: follow-up send costs 1 credit
  const charge = await chargeCredits(req.clientId, 'followup_send', { matchId });
  if (!charge.ok) {
    if (charge.error === 'insufficient_credits') {
      return res.status(402).json({ success: false, error: 'insufficient_credits', balance: charge.balance, needed: charge.needed });
    }
    return res.status(500).json({ success: false, error: 'credit_charge_failed' });
  }

  try {
    const { data: match, error: fetchError } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(contact_email, title), clients(gmail_refresh_token)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();
    if (fetchError || !match) return res.status(404).json({ success: false, error: 'Match not found.' });

    const contactEmail = match.podcasts?.contact_email || null;
    if (!contactEmail?.includes('@')) {
      // Mark as followed-up even if no email address (so the customer can manually handle it)
      await supabase.from('podcast_matches').update({ follow_up_sent: true, status: 'followed_up' }).eq('id', matchId).eq('client_id', req.clientId);
      return res.json({ success: true, resendSent: false, credits_balance: charge.balance });
    }

    const finalSubject = subject || `Re: ${match.email_subject_edited || match.email_subject || 'Guest pitch'}`;

    // Get the latest message's RFC-822 Message-ID for In-Reply-To threading (used by both Gmail + Resend paths)
    let inReplyTo = null;
    let references = null;
    const { data: latestMsg } = await supabase
      .from('match_thread_messages')
      .select('rfc822_message_id')
      .eq('match_id', matchId)
      .not('rfc822_message_id', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(1)
      .single();

    if (latestMsg?.rfc822_message_id) {
      inReplyTo = latestMsg.rfc822_message_id;
      references = latestMsg.rfc822_message_id;
    }

    const gmailRefreshToken = match.clients?.gmail_refresh_token || null;
    const threadId = match.gmail_thread_id || null;
    let sentResult = null;

    if (gmailRefreshToken && threadId) {
      // ── Gmail path: send as a true threaded reply (Gmail groups by threadId) ──
      try {
        const { sendThreadedReply } = require('../services/gmailService');
        const sent = await sendThreadedReply({
          refreshToken: gmailRefreshToken,
          to: contactEmail,
          subject: finalSubject,
          body,
          threadId,
          inReplyTo: inReplyTo || undefined,
          references: references || undefined,
        });
        sentResult = { id: sent.id, from: null };
        logger.info('Manual follow-up sent via Gmail (threaded)', { matchId, threadId });
      } catch (gmailErr) {
        logger.warn('Manual follow-up Gmail threaded send failed', { matchId, error: gmailErr.message });
        // Don't fall through to Resend — surface the error so the customer can reconnect Gmail
        return res.status(500).json({ success: false, error: `Gmail send failed: ${gmailErr.message}. Try reconnecting Gmail in Settings.` });
      }
    } else if (gmailRefreshToken) {
      // Gmail connected but no threadId stored — send via createDraft+sendDraft.
      // Gmail will thread on the host's side via In-Reply-To header even without threadId.
      try {
        const { createDraft, sendDraft } = require('../services/gmailService');
        const draftId = await createDraft(gmailRefreshToken, contactEmail, finalSubject, body, null, null);
        const sent = await sendDraft(gmailRefreshToken, draftId);
        sentResult = { id: sent.id, from: null };
        logger.info('Manual follow-up sent via Gmail (no threadId fallback)', { matchId });
      } catch (gmailErr) {
        logger.warn('Manual follow-up Gmail (no threadId) send failed', { matchId, error: gmailErr.message });
        return res.status(500).json({ success: false, error: `Gmail send failed: ${gmailErr.message}. Try reconnecting Gmail in Settings.` });
      }
    } else {
      // ── Resend fallback (no Gmail connected) ────────────────────────────────
      try {
        sentResult = await sendEmail({
          to: contactEmail,
          subject: finalSubject,
          body,
          inReplyTo: inReplyTo || undefined,
          references: references || undefined,
        });
        logger.info('Manual follow-up sent via Resend', { matchId });
      } catch (sendErr) {
        logger.warn('Manual follow-up Resend send failed', { matchId, error: sendErr.message });
        return res.status(500).json({ success: false, error: `Email send failed: ${sendErr.message}. Connect Gmail in Settings.` });
      }
    }

    // Cache the outbound message so future follow-ups + replies thread off it
    if (sentResult?.id) {
      try {
        await supabase.from('match_thread_messages').insert({
          match_id:          matchId,
          gmail_message_id:  sentResult.id,
          direction:         'outbound',
          message_type:      'followup',
          from_email:        sentResult.from || null,
          to_email:          contactEmail,
          subject:           finalSubject,
          body_text:         body,
          rfc822_message_id: sentResult.id,
          sent_at:           new Date().toISOString(),
        });
      } catch (logErr) {
        logger.warn('Manual follow-up: thread cache insert failed', { matchId, error: logErr.message });
      }
    }

    await supabase.from('podcast_matches').update({
      follow_up_sent:             true,
      status:                    'followed_up',
      gmail_followup_message_id:  sentResult?.id || null,
      last_message_at:            new Date().toISOString(),
      message_count:              (match.message_count || 0) + 1,
    }).eq('id', matchId).eq('client_id', req.clientId);

    return res.json({ success: true, resendSent: !!sentResult, credits_balance: charge.balance });
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
