'use strict';

const { getClient } = require('../lib/anthropic');
const { getEmailWriterPrompt } = require('../prompts/emailWriter.prompt');
const logger = require('../lib/logger');

const MODEL        = 'claude-sonnet-4-6';
const HUMANIZER_MODEL = 'claude-haiku-4-5-20251001';

const HUMANIZER_PROMPT = `You are an email editor. Your only job is to make pitch emails sound like a real human wrote them — not an AI.

RULES:
- Remove all em dashes (—) and replace with commas or restructure the sentence
- Remove phrases like: "I wanted to reach out", "I hope this finds you well", "I came across your podcast", "I've been following", "I love what you're doing", "touch base", "circle back", "leverage", "synergy", "game-changer", "delve", "navigate", "landscape", "foster"
- Remove any exclamation marks
- Fix overly formal or stiff phrasing — make it sound like a confident peer talking to another peer
- Keep all paragraph breaks (double newlines) exactly as they are
- Keep the exact same 4-paragraph structure — do not merge or split paragraphs
- Do not add new content or remove key facts
- Do not change the P.S. line substantially — just clean up AI language if present
- Keep it under 130 words total
- Return ONLY the cleaned email body — no explanation, no JSON, no extra text`;

async function humanize(body) {
  try {
    const message = await getClient().messages.create({
      model: HUMANIZER_MODEL,
      max_tokens: 600,
      system: HUMANIZER_PROMPT,
      messages: [{ role: 'user', content: body }],
    });
    const cleaned = message.content?.[0]?.text?.trim();
    return cleaned || body;
  } catch (_) {
    return body; // non-blocking — return original if humanizer fails
  }
}

/**
 * writeEmail(client, match, podcast)
 * Calls Claude to write a personalised pitch email for the client → podcast match.
 * Returns { subject, body } on success.
 * Returns fallback values on failure rather than throwing.
 */
async function writeEmail(client, match, podcast) {
  logger.debug('Writing pitch email', {
    clientId: client.id,
    podcastTitle: podcast.title,
  });

  // Send trimmed objects with only what Claude needs for a great pitch
  const clientForEmail = {
    name:            client.name,
    title:           client.title,
    business_name:   client.business_name,
    bio_short:       client.bio_short,
    topics:          client.topics,
    speaking_angles: client.speaking_angles,
    target_audience: client.target_audience,
    website:         client.website,
    booking_link:    client.booking_link,
    pitch_style:     client.pitch_style,
    preferred_tone:  client.preferred_tone,
  };

  const podcastForEmail = {
    title:                podcast.title,
    host_name:            podcast.host_name,
    description:          podcast.description,
    website:              podcast.website,
    contact_email:        podcast.contact_email,
    // Scoring insights — these make pitches far more targeted
    best_pitch_angle:     match.best_pitch_angle     || null,
    why_this_client_fits: match.why_this_client_fits || null,
    episode_to_reference: match.episode_to_reference || null,
    show_summary:         match.show_summary         || null,
  };

  const userMessage = JSON.stringify({ client: clientForEmail, podcast: podcastForEmail });

  try {
    const message = await getClient().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: getEmailWriterPrompt(client.email_template || null),
      messages: [{ role: 'user', content: userMessage }],
    });

    const rawText = message.content?.[0]?.text || '';

    // Strip any accidental markdown code fences
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch (parseErr) {
      logger.error('Failed to parse email writer JSON', {
        podcastTitle: podcast.title,
        parseError: parseErr.message,
        rawText: rawText.slice(0, 500),
      });
      return {
        subject: `Guest idea for ${podcast.title}`,
        body:    rawText.trim() || 'Email generation failed — please write manually.',
      };
    }

    if (!result.subject || !result.body) {
      logger.warn('Email writer returned incomplete fields', { podcastTitle: podcast.title });
      return {
        subject: result.subject || `Guest idea for ${podcast.title}`,
        body:    result.body    || '',
      };
    }

    const humanizedBody = await humanize(result.body);
    const signature = client.email_signature?.trim();
    const body = signature ? `${humanizedBody}\n\n${signature}` : humanizedBody;
    return { subject: result.subject, body };
  } catch (err) {
    logger.error('Claude email writer API call failed', {
      clientId: client.id,
      podcastTitle: podcast.title,
      error: err.message,
    });

    return {
      subject:   `Guest pitch — ${client.name}`,
      body:      `Hi [Host Name],\n\nI'd love to be a guest on your show.\n\n[Write your pitch here — tell them who you are, why your topic fits their audience, and what value you'll bring to their listeners.]\n\nLooking forward to connecting.\n\n${client.name}`,
      _fallback: true,
      _error:    err.message,
    };
  }
}

module.exports = { writeEmail };
