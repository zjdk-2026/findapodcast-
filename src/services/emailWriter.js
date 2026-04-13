'use strict';

const { getClient } = require('../lib/anthropic');
const { getEmailWriterPrompt } = require('../prompts/emailWriter.prompt');
const logger = require('../lib/logger');

const MODEL        = 'claude-sonnet-4-6';
const HUMANIZER_MODEL = 'claude-haiku-4-5-20251001';

const HUMANIZER_PROMPT = `You are an email editor. Your only job is to make pitch emails sound like a real human wrote them — not an AI. The email is written from a guest to a podcast host. It should feel warm, curious, and peer-to-peer — not persuasive or salesy.

RULES:
- Remove all em dashes (—) and replace with commas or restructure the sentence
- Remove exclamation marks
- Remove AI-sounding phrases: "I wanted to reach out", "I hope this finds you well", "I came across your podcast", "I've been following", "touch base", "circle back", "leverage", "synergy", "game-changer", "delve", "navigate", "landscape", "foster", "resonate", "align", "thought leader", "expertise"
- CRITICAL: Remove ALL phrases implying you have listened to or consumed the podcast: "I've been listening to your show", "I've been a listener", "what stands out to me from your episodes", "I noticed from your show", "I heard your episode", "I listened to", "your episode on X", "your show caught my attention", "I've been enjoying your content". If any such phrase exists, rewrite that sentence to observe the show from the outside (its mission, who it serves) — not from personal listening.
- Remove persuasive or salesy language — this email asks, it does not pitch or sell
- Fix any phrasing that sounds like a consultant or marketer — rewrite it as a curious, thoughtful person
- Keep all paragraph breaks (double newlines) exactly as they are
- Keep the exact same 5-paragraph structure — do not merge or split paragraphs
- Do not add new content or remove key facts
- Do not change the P.S. line substantially — just clean up AI language if present
- Keep it under 130 words total
- Return ONLY the cleaned email body — no explanation, no JSON, no extra text`;

function buildLinkRow(client) {
  const links = [];
  if (client.website)          links.push(`<a href="${client.website}" style="color:#6366f1;text-decoration:none;">Website</a>`);
  if (client.social_instagram) links.push(`<a href="${client.social_instagram}" style="color:#6366f1;text-decoration:none;">Instagram</a>`);
  if (client.social_linkedin)  links.push(`<a href="${client.social_linkedin}" style="color:#6366f1;text-decoration:none;">LinkedIn</a>`);
  if (client.social_facebook)  links.push(`<a href="${client.social_facebook}" style="color:#6366f1;text-decoration:none;">Facebook</a>`);
  if (client.social_twitter)   links.push(`<a href="${client.social_twitter}" style="color:#6366f1;text-decoration:none;">Twitter / X</a>`);
  if (!links.length) return null;
  return links.join(' &nbsp;|&nbsp; ');
}

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
    bio_long:        client.bio_long,
    topics:          client.topics,
    speaking_angles: client.speaking_angles,
    target_audience: client.target_audience,
    pitch_style:     client.pitch_style,
    preferred_tone:  client.preferred_tone,
  };

  const podcastForEmail = {
    title:                podcast.title,
    host_name:            podcast.host_name,
    description:          podcast.description,
    website:              podcast.website,
    contact_email:        podcast.contact_email,
    best_pitch_angle:     match.best_pitch_angle     || null,
    why_this_client_fits: match.why_this_client_fits || null,
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
    const bodyParts = [humanizedBody];
    if (signature) bodyParts.push(signature);
    // linkRow is NOT stored in body — it's injected at send time as HTML only
    return { subject: result.subject, body: bodyParts.join('\n\n'), linkRow: buildLinkRow(client) };
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

module.exports = { writeEmail, buildLinkRow, humanize };
