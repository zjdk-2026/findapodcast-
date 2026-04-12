'use strict';

const express    = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const supabase   = require('../lib/supabase');
const logger     = require('../lib/logger');
const { writeEmail, humanize } = require('../services/emailWriter');
const { createDraft }          = require('../services/gmailService');
const requireDashboardToken = require('../middleware/requireDashboardToken');

const router = express.Router();

/**
 * POST /api/save-pitch
 * Saves manually written subject + body, and creates/updates Gmail draft.
 */
router.post('/save-pitch', requireDashboardToken, async (req, res) => {
  const { matchId, subject, body } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data: match, error: fetchError } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(contact_email), clients(gmail_refresh_token)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (fetchError || !match) return res.status(404).json({ success: false, error: 'Match not found.' });

    // Try to create a Gmail draft so /api/send can use it
    let gmailDraftId = match.gmail_draft_id || null;
    if (match.clients?.gmail_refresh_token && body) {
      const contactEmail = match.podcasts?.contact_email || null;
      if (contactEmail?.includes('@')) {
        gmailDraftId = await createDraft(match.clients.gmail_refresh_token, contactEmail, subject || '', body).catch(() => gmailDraftId);
      }
    }

    const { error: updateError } = await supabase
      .from('podcast_matches')
      .update({ email_subject: subject || '', email_body: body || '', gmail_draft_id: gmailDraftId })
      .eq('id', matchId)
      .eq('client_id', req.clientId);

    if (updateError) return res.status(500).json({ success: false, error: 'Failed to save pitch.' });

    logger.info('Pitch saved manually', { matchId });
    return res.json({ success: true });
  } catch (err) {
    logger.error('save-pitch error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/generate-pitch
 * Regenerates the pitch email for a given match and saves it back to the DB.
 */
router.post('/generate-pitch', requireDashboardToken, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data: match, error: fetchError } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(*), clients(*)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (fetchError || !match) {
      return res.status(404).json({ success: false, error: 'Match not found.' });
    }

    const email = await writeEmail(match.clients, match, match.podcasts);

    // Don't save or return a fallback — tell the frontend to handle it gracefully
    if (email._fallback) {
      logger.warn('Email generation returned fallback — not saving to DB', { matchId, fallbackError: email._error });
      return res.status(503).json({ success: false, error: `Pitch writer error: ${email._error || 'unknown'}` });
    }

    // Guard: if body is somehow still a JSON string, parse it before saving
    let saveSubject = email.subject;
    let saveBody    = email.body;
    if (typeof saveBody === 'string' && saveBody.trim().startsWith('{')) {
      try { const p = JSON.parse(saveBody); if (p.body) { saveBody = p.body; saveSubject = p.subject || saveSubject; } } catch {}
    }

    const { error: updateError } = await supabase
      .from('podcast_matches')
      .update({ email_subject: saveSubject, email_body: saveBody })
      .eq('id', matchId);

    if (updateError) {
      logger.error('Failed to save regenerated pitch', { matchId, error: updateError.message });
      return res.status(500).json({ success: false, error: 'Failed to save pitch.' });
    }

    logger.info('Pitch regenerated', { matchId });
    return res.json({ success: true, subject: email.subject, body: email.body });
  } catch (err) {
    logger.error('generate-pitch route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/generate-followup
 * Generates an AI follow-up email using the same Claude prompt as the scheduler,
 * runs it through the humanizer, and returns { subject, body } — does NOT send.
 */
router.post('/generate-followup', requireDashboardToken, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data: match, error: fetchError } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(title, contact_email), clients(name)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (fetchError || !match) return res.status(404).json({ success: false, error: 'Match not found.' });

    const podcastName  = match.podcasts?.title || 'the podcast';
    const origSubject  = match.email_subject_edited || match.email_subject || `Guest pitch for ${podcastName}`;
    const clientName   = match.clients?.name || '';

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: `You are a podcast pitch follow-up writer. The initial pitch has already been sent. Write a short second-touch email that re-opens the conversation without being needy or repeating the original pitch verbatim.

Rules:
- Body: 60–80 words max
- Do NOT open with "Just wanted to follow up" or "Checking in"
- Open with a confident re-entry — acknowledge they're busy, then pivot back to value
- Remind them of one specific reason the episode idea fits their audience
- Close with: "Even a 15-minute call works — happy to be flexible."
- Add a one-sentence P.S. that names a result, credential, or offers to send talking points
- Tone: warm, peer-level, slightly bolder than the first email. Not apologetic. Not pushy.
- Subject line: use "Re: [original_subject]" format
- No bullet points. No exclamation marks. No em dashes. First person only.
- Sign off with the sender's name only

Return ONLY valid JSON: {"subject": "...", "body": "..."}`,
      messages: [{ role: 'user', content: JSON.stringify({
        original_subject: origSubject,
        podcast_name:     podcastName,
        sender_name:      clientName,
      }) }],
    });

    const raw     = message.content[0].text;
    const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(jsonStr); }
    catch { return res.status(500).json({ success: false, error: 'Could not parse follow-up response.' }); }

    // Run through humanizer
    const humanizedBody = await humanize(parsed.body);

    logger.info('Follow-up generated', { matchId });
    return res.json({ success: true, subject: parsed.subject, body: humanizedBody });
  } catch (err) {
    logger.error('generate-followup error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/interview-prep
 * Generates an interview prep briefing for a given match and saves it to the DB.
 */
router.post('/interview-prep', requireDashboardToken, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data: match, error: fetchError } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(*), clients(*)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (fetchError || !match) {
      return res.status(404).json({ success: false, error: 'Match not found.' });
    }

    const podcast = match.podcasts;
    const client  = match.clients;

    const prompt =
      'You are an expert podcast interview coach. Given this podcast and guest profile, create a concise interview prep briefing. ' +
      'Format as JSON with these fields: host_background (2 sentences), show_format (1 sentence), suggested_topics (array of 4 strings), ' +
      'likely_questions (array of 4 strings), talking_points (array of 3 strings), one_thing_to_avoid (1 sentence). ' +
      `Podcast: ${podcast.title}, ${podcast.category}, ${podcast.description}. ` +
      `Guest: ${client.name}, ${client.business_name || client.business || ''}, ${(client.topics || []).join(', ')}, ${client.bio_short || client.bio || ''}.`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages:   [{ role: 'user', content: prompt }],
    });

    const rawText = message.content?.[0]?.text || '';
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    let prep;
    try {
      prep = JSON.parse(cleaned);
    } catch (parseErr) {
      logger.error('Failed to parse interview prep JSON', { matchId, error: parseErr.message });
      return res.status(500).json({ success: false, error: 'Failed to parse interview prep response.' });
    }

    try {
      await supabase
        .from('podcast_matches')
        .update({ interview_prep: JSON.stringify(prep) })
        .eq('id', matchId);
    } catch (saveErr) {
      logger.warn('Could not save interview_prep (column may not exist)', { matchId, error: saveErr.message });
    }

    logger.info('Interview prep generated', { matchId });
    return res.json({ success: true, prep });
  } catch (err) {
    logger.error('interview-prep route error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/generate-dm
 * Generates a short, first-person social DM for a given match using Claude Haiku.
 */
router.post('/generate-dm', requireDashboardToken, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data: match, error: fetchError } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(title, description, category), clients(name, topics, bio_short)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (fetchError || !match) return res.status(404).json({ success: false, error: 'Match not found.' });

    const podcast    = match.podcasts || {};
    const client     = match.clients  || {};
    const firstName  = (client.name || '').split(' ')[0] || 'me';
    const fullTitle  = podcast.title || 'your show';
    const shortName  = fullTitle.split(/[|:—–]/)[0].trim() || fullTitle;
    const topics     = (client.topics || []).join(', ');
    const angle      = match.best_pitch_angle || '';
    const bio        = client.bio_short || '';

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: `You write short, first-person social media DMs from a podcast guest to a host. The message should feel like a real person reaching out — not a pitch, not a press release.

Rules:
- Open with "Hi ${shortName},"
- Body: 2 short paragraphs max, 60 words total max
- FIRST PERSON ONLY — "I", "my", "I've" — NEVER use the guest's name in the body
- Do NOT say "I've been listening to your show" or "I love your podcast" — the sender hasn't listened
- Lead with ONE specific, genuine reason this is a fit (audience, topic angle, or category)
- Close with: "Would you be open to a quick chat to see if there's a fit? Even 15 minutes works."
- Sign off with just the first name: ${firstName}
- No em dashes. No bullet points. No exclamation marks. No fluff.

Return ONLY the plain text DM — no JSON, no markdown.`,
      messages: [{ role: 'user', content: JSON.stringify({
        podcast_name:     shortName,
        podcast_category: podcast.category || '',
        podcast_description: (podcast.description || '').slice(0, 300),
        guest_first_name: firstName,
        guest_topics:     topics,
        guest_bio:        bio.slice(0, 200),
        pitch_angle:      angle.slice(0, 200),
      }) }],
    });

    const body = message.content[0].text.trim();
    logger.info('DM generated', { matchId });
    return res.json({ success: true, body });
  } catch (err) {
    logger.error('generate-dm error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
