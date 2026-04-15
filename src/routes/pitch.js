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
      .update({ email_subject: saveSubject, email_subject_b: email.subject_b || null, email_body: saveBody })
      .eq('id', matchId);

    if (updateError) {
      logger.error('Failed to save regenerated pitch', { matchId, error: updateError.message });
      return res.status(500).json({ success: false, error: 'Failed to save pitch.' });
    }

    logger.info('Pitch regenerated', { matchId });
    return res.json({ success: true, subject: email.subject, subject_b: email.subject_b || null, body: email.body });
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
      .select('*, podcasts(title, contact_email, host_name), clients(name, title, business_name, email_signature)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (fetchError || !match) return res.status(404).json({ success: false, error: 'Match not found.' });

    const podcastName  = match.podcasts?.title || 'the podcast';
    const origSubject  = match.email_subject_edited || match.email_subject || `Guest pitch for ${podcastName}`;
    const clientName   = match.clients?.name || '';
    const clientFirst  = clientName.split(' ')[0] || clientName;
    const hostName     = match.podcasts?.host_name || '';
    const hostFirst    = hostName ? hostName.split(' ')[0] : null;
    const clientTitle  = match.clients?.title || '';
    const clientBiz    = match.clients?.business_name || '';
    const storedSig    = match.clients?.email_signature?.trim();
    const autoSig      = [clientName, clientTitle, clientBiz].filter(Boolean).join('\n');
    const signature    = storedSig || autoSig;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: `You are a podcast pitch follow-up writer. The initial pitch has already been sent. Write a short second-touch email that re-opens the conversation without being needy or repeating the original pitch verbatim.

Rules:
- ALWAYS open with a greeting on its own line: "Hi ${hostFirst || '[Host]'}," — use the host's first name if provided
- Body: 60–80 words max (not counting greeting, sign-off, or P.S.)
- Do NOT open the body with "Just wanted to follow up" or "Checking in"
- Confident re-entry — acknowledge they're busy, then pivot back to value
- Remind them of one specific reason the episode idea fits their audience
- Close with a question that invites a reply — vary the phrasing, always end with a question mark
- Add a one-sentence P.S. that names a result or offers to send talking points
- Tone: warm, peer-level, slightly bolder than the first email. Not apologetic. Not pushy.
- Subject line: use "Re: [original_subject]" format
- No bullet points. No exclamation marks. No em dashes. First person only.
- Sign off format: "Best,\n[sender full name]\n[title if provided]\n[business if provided]" — use the exact signature provided
- NEVER add em dashes (—) anywhere in the email

Return ONLY valid JSON: {"subject": "...", "body": "..."}
The body field must include the greeting at the top and the full signature at the bottom.`,
      messages: [{ role: 'user', content: JSON.stringify({
        original_subject: origSubject,
        podcast_name:     podcastName,
        host_first_name:  hostFirst || '',
        sender_name:      clientName,
        sender_first:     clientFirst,
        signature,
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
      .select('*, podcasts(title, description, category), clients(name, topics, bio_short, bio_long)')
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
    const bio        = client.bio_long || client.bio_short || '';

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 400,
      system: `You write short, first-person social media DMs from a podcast guest to a host. The goal is not to sell the guest — it is to open a door with genuine curiosity about the host's work and audience.

THE MINDSET: Most DMs are self-promotional. This one is different. The guest is curious about what the host is building and who they are trying to serve. It should feel like a thoughtful peer reaching out — not a pitch, not a press release, not a fan message.

GREETING: Open with "Hi ${shortName},"

STRUCTURE — 3 short paragraphs, 75 words total max:

Paragraph 1 — One genuine observation about the show's mission, the audience it serves, or the problem it helps people solve. Draw from the show description and pitch_angle. This must read like someone who respects the work from the outside — not a listener recounting episodes. One sentence.

Paragraph 2 — Ask one specific, host-focused question: what is their audience working through right now, or what kind of conversations are they building toward? Make it feel like you are genuinely curious, not setting up a pitch.

Paragraph 3 — Offer one specific way the guest's perspective or experience could serve that audience. Frame it around the audience's outcome, not the guest's credentials. Close with a natural, low-pressure invitation to connect — something like "Would love to explore if there's a fit, if you're open to it." Vary the phrasing naturally — do not use the same closing every time.

SIGN OFF: Just the first name: ${firstName}

HARD RULES:
- FIRST PERSON ONLY — "I", "my" — NEVER use the guest's name in the body
- ABSOLUTE BAN: NEVER say "I've been listening to your show", "I love your podcast", "I've been following you", "I came across your show", "I heard your episode", "your show caught my attention", or ANY phrase implying you have personally listened to or consumed the podcast. You have NOT listened.
- No em dashes. No bullet points. No exclamation marks. No "just wanted to reach out." No fluff.
- Tone: Warm, curious, peer-level. Direct without being pushy.
- Use best_pitch_angle if provided — it is the sharpest hook available.

Return ONLY the plain text DM — no JSON, no markdown, no explanation.`,
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

    // Strip em dashes and run through humanizer
    const rawBody = message.content[0].text.trim().replace(/—/g, '-').replace(/–/g, '-');
    const body = await humanize(rawBody);
    logger.info('DM generated', { matchId });
    return res.json({ success: true, body });
  } catch (err) {
    logger.error('generate-dm error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

/**
 * POST /api/generate-thankyou
 * Generates an AI thank you email after an episode airs.
 */
router.post('/generate-thankyou', requireDashboardToken, async (req, res) => {
  const { matchId } = req.body;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId is required.' });

  try {
    const { data: match, error: fetchError } = await supabase
      .from('podcast_matches')
      .select('*, podcasts(title, host_name, contact_email), clients(name, title, business_name, email_signature, speaking_bio, target_audience, social_instagram, social_twitter, social_linkedin)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (fetchError || !match) return res.status(404).json({ success: false, error: 'Match not found.' });

    const podcastTitle  = match.podcasts?.title     || 'your show';
    const hostName      = match.podcasts?.host_name  || '';
    const hostFirst     = hostName ? hostName.split(' ')[0] : null;
    const clientName    = match.clients?.name         || '';
    const clientTitle   = match.clients?.title        || '';
    const clientBiz     = match.clients?.business_name || '';
    const speakingBio   = match.clients?.speaking_bio  || '';
    const targetAud     = match.clients?.target_audience || '';
    const hasSocial     = !!(match.clients?.social_instagram || match.clients?.social_twitter || match.clients?.social_linkedin);
    const storedSig2    = match.clients?.email_signature?.trim();
    const autoSig2      = [clientName, clientTitle, clientBiz].filter(Boolean).join('\n');
    const signature     = storedSig2 || autoSig2;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 450,
      system: `You write short, warm, human thank you emails from a podcast guest to a host, sent after the episode airs.

Structure (3 short paragraphs):
1. Genuine thanks — reference something specific about the conversation or the show's angle. One sentence.
2. What you hope the audience gets from it — connect to the guest's expertise and the listeners' world. One or two sentences.
3. ${hasSocial ? 'Offer to share the episode with your own audience and leave the door open for a return appearance.' : 'Leave the door open for a return appearance or any way you can add value to their audience.'}

Rules:
- Open with "Hi ${hostFirst || '[Host]'},"
- 80-110 words in the body (not counting greeting or sign-off)
- Warm but not gushing. Real, not performative.
- End the body immediately after the P.S. line. Do NOT add any closing word, "Best,", or the sender's name — the signature is appended automatically.
- No bullet points. No exclamation marks. No em dashes. First person only.
- Subject line format: "Thank you: [podcast title]"

Return ONLY valid JSON: {"subject": "...", "body": "..."}
The body must include the greeting at the top and full signature at the bottom.`,
      messages: [{ role: 'user', content: JSON.stringify({
        podcast_title:   podcastTitle,
        host_first_name: hostFirst || '',
        sender_name:     clientName,
        sender_title:    clientTitle,
        sender_business: clientBiz,
        speaking_bio:    speakingBio,
        target_audience: targetAud,
        pitch_angle:     match.best_pitch_angle || '',
        why_you_fit:     match.why_you_fit || '',
        signature,
      }) }],
    });

    const raw = message.content[0].text;
    const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(jsonStr); }
    catch { return res.status(500).json({ success: false, error: 'Could not parse response.' }); }

    const { humanize } = require('../services/emailWriter');
    const humanizedBody = await humanize(parsed.body);

    logger.info('Thank you email generated', { matchId });
    return res.json({ success: true, subject: parsed.subject, body: humanizedBody });
  } catch (err) {
    logger.error('generate-thankyou error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
