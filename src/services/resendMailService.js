'use strict';

const logger = require('../lib/logger');

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * sendEmail({ to, subject, body, inReplyTo, references, attachments })
 *
 * Sends an email via the Resend REST API.
 *
 * @param {Object} options
 * @param {string}  options.to           - Recipient email address
 * @param {string}  options.subject      - Email subject line
 * @param {string}  options.body         - Plain text body content
 * @param {string}  [options.html]       - Optional HTML body (if not provided, body is used as text)
 * @param {string}  [options.inReplyTo]  - RFC-822 Message-ID for In-Reply-To header (threading)
 * @param {string}  [options.references] - References header value (threading)
 * @param {Array}   [options.attachments] - Array of { filename, content (Buffer), mime } objects
 *
 * @returns {Promise<{ id: string, from: string, to: string, subject: string }>}
 */
async function sendEmail({ to, subject, body, html, inReplyTo, references, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'hi@findapodcast.io';

  if (!apiKey) {
    const err = new Error('RESEND_API_KEY is not configured');
    logger.error('Resend API key missing', {});
    throw err;
  }

  // Build headers for threading support
  const headers = {};
  if (inReplyTo) {
    headers['In-Reply-To'] = inReplyTo;
  }
  if (references) {
    headers['References'] = references;
  }

  const payload = {
    from: fromEmail,
    to: [to],
    subject,
    text: body,
  };

  // If HTML is provided, include it (Resend handles both)
  if (html) {
    payload.html = html;
  }

  // Add threading headers if present
  if (Object.keys(headers).length > 0) {
    payload.headers = headers;
  }

  // Handle attachments: Resend expects base64-encoded content
  if (attachments && Array.isArray(attachments) && attachments.length > 0) {
    payload.attachments = attachments.map((att) => ({
      filename: att.filename || 'attachment',
      content: Buffer.isBuffer(att.content)
        ? att.content.toString('base64')
        : Buffer.from(att.content).toString('base64'),
      content_type: att.mime || 'application/octet-stream',
    }));
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errMsg = data?.message || data?.error || response.statusText;
      const err = new Error(`Resend API error: ${errMsg}`);
      err.status = response.status;
      err.resendData = data;
      logger.error('Resend email send failed', {
        to,
        subject,
        status: response.status,
        error: errMsg,
        resendData: data,
      });
      throw err;
    }

    logger.info('Resend email sent', {
      id: data.id,
      from: fromEmail,
      to,
      subject,
    });

    return {
      id: data.id,
      from: fromEmail,
      to,
      subject,
    };
  } catch (err) {
    // If it's already our enriched error, rethrow
    if (err.resendData) throw err;

    logger.error('Resend email send exception', {
      to,
      subject,
      error: err.message,
    });
    throw err;
  }
}

module.exports = { sendEmail };
