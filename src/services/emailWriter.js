'use strict';

const { getClient } = require('../lib/anthropic');
const { getEmailWriterPrompt } = require('../prompts/emailWriter.prompt');
const logger = require('../lib/logger');

const MODEL = 'claude-sonnet-4-20250514';

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

  const userMessage = JSON.stringify({ client, podcast, scoring: match });

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
        subject: result.subject || `Guest pitch — ${client.name}`,
        body:    result.body    || 'Email generation returned incomplete data.',
      };
    }

    return { subject: result.subject, body: result.body };
  } catch (err) {
    logger.error('Claude email writer API call failed', {
      clientId: client.id,
      podcastTitle: podcast.title,
      error: err.message,
    });

    return {
      subject: `Guest pitch — ${client.name}`,
      body:    `Email generation failed: ${err.message}. Please write this email manually.`,
    };
  }
}

module.exports = { writeEmail };
