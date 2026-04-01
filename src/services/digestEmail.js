'use strict';

const logger = require('../lib/logger');

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * Format a date as "Monday, March 31 2026"
 */
function formatDate(date = new Date()) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}

/**
 * Get badge colour class based on fit score.
 */
function scoreColor(score) {
  if (score >= 80) return '#22c55e'; // green
  if (score >= 60) return '#f59e0b'; // amber
  return '#ef4444';                  // red
}

/**
 * Build the HTML email body for the digest.
 */
function buildDigestHtml(client, matches, dashboardUrl) {
  const date = formatDate();
  const topMatches = [...matches]
    .sort((a, b) => (b.fit_score || 0) - (a.fit_score || 0))
    .slice(0, client.daily_target || 10);

  const matchRows = topMatches.map((match) => {
    const podcast = match.podcasts || match; // handle joined or flat structure
    const title   = podcast.title || 'Unknown Show';
    const host    = podcast.host_name ? `Hosted by ${podcast.host_name}` : '';
    const score   = match.fit_score || 0;
    const color   = scoreColor(score);
    const angle   = match.best_pitch_angle || 'No pitch angle available';
    const likelihood = match.booking_likelihood || 'unknown';
    const contact = podcast.contact_email || podcast.booking_page_url || podcast.guest_application_url || 'No direct contact found';
    const contactDisplay = podcast.contact_email
      ? `<a href="mailto:${podcast.contact_email}" style="color:#6366f1;">${podcast.contact_email}</a>`
      : podcast.booking_page_url
      ? `<a href="${podcast.booking_page_url}" style="color:#6366f1;">Booking Page</a>`
      : podcast.guest_application_url
      ? `<a href="${podcast.guest_application_url}" style="color:#6366f1;">Guest Application</a>`
      : '<span style="color:#9ca3af;">No direct contact found</span>';

    return `
    <div style="background:#1e1e2e;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #2d2d3f;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
        <div>
          <h3 style="margin:0 0 4px;color:#e2e8f0;font-size:16px;">${escapeHtml(title)}</h3>
          ${host ? `<p style="margin:0 0 8px;color:#94a3b8;font-size:13px;">${escapeHtml(host)}</p>` : ''}
        </div>
        <span style="background:${color};color:#fff;padding:4px 12px;border-radius:999px;font-size:13px;font-weight:700;white-space:nowrap;">
          ${score} / 100
        </span>
      </div>
      <p style="margin:8px 0 4px;color:#a5b4fc;font-size:13px;font-weight:600;">Best Pitch Angle</p>
      <p style="margin:0 0 12px;color:#cbd5e1;font-size:14px;">${escapeHtml(angle)}</p>
      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        <div>
          <span style="color:#64748b;font-size:12px;">Booking Likelihood</span><br>
          <span style="color:#e2e8f0;font-size:13px;font-weight:600;text-transform:capitalize;">${escapeHtml(likelihood)}</span>
        </div>
        <div>
          <span style="color:#64748b;font-size:12px;">Contact</span><br>
          <span style="font-size:13px;">${contactDisplay}</span>
        </div>
      </div>
    </div>`;
  }).join('');

  const totalMatches = matches.length;
  const highMatches  = matches.filter((m) => (m.fit_score || 0) >= 80).length;
  const medMatches   = matches.filter((m) => (m.fit_score || 0) >= 60 && (m.fit_score || 0) < 80).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Your Podcast Pipeline — ${date}</title>
</head>
<body style="margin:0;padding:0;background:#0f0f1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:32px 16px;">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:32px;">
      <p style="margin:0 0 8px;color:#6366f1;font-size:13px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;">Podcast Pipeline</p>
      <h1 style="margin:0 0 8px;color:#f1f5f9;font-size:28px;font-weight:800;">Your Daily Opportunities</h1>
      <p style="margin:0;color:#64748b;font-size:14px;">${date}</p>
    </div>

    <!-- Stats bar -->
    <div style="background:#1e1e2e;border-radius:12px;padding:20px;margin-bottom:32px;display:flex;justify-content:space-around;flex-wrap:wrap;gap:12px;border:1px solid #2d2d3f;">
      <div style="text-align:center;">
        <p style="margin:0;color:#6366f1;font-size:24px;font-weight:800;">${totalMatches}</p>
        <p style="margin:4px 0 0;color:#64748b;font-size:12px;">Total Matches</p>
      </div>
      <div style="text-align:center;">
        <p style="margin:0;color:#22c55e;font-size:24px;font-weight:800;">${highMatches}</p>
        <p style="margin:4px 0 0;color:#64748b;font-size:12px;">High Score (80+)</p>
      </div>
      <div style="text-align:center;">
        <p style="margin:0;color:#f59e0b;font-size:24px;font-weight:800;">${medMatches}</p>
        <p style="margin:4px 0 0;color:#64748b;font-size:12px;">Medium Score (60–79)</p>
      </div>
    </div>

    <!-- Matches -->
    <h2 style="color:#e2e8f0;font-size:18px;font-weight:700;margin:0 0 16px;">Top ${topMatches.length} Matches</h2>
    ${matchRows || '<p style="color:#64748b;">No matches found this run.</p>'}

    <!-- CTA -->
    <div style="text-align:center;margin:32px 0;">
      <a href="${dashboardUrl}"
         style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;">
        Review &amp; Approve in Dashboard →
      </a>
    </div>

    <!-- Footer -->
    <div style="border-top:1px solid #2d2d3f;padding-top:24px;text-align:center;">
      <p style="margin:0;color:#475569;font-size:12px;">
        Podcast Pipeline · Automated guest booking for ${escapeHtml(client.name)}<br>
        ${totalMatches} total match${totalMatches !== 1 ? 'es' : ''} found · ${highMatches} high-scoring opportunit${highMatches !== 1 ? 'ies' : 'y'}
      </p>
    </div>

  </div>
</body>
</html>`;
}

/**
 * Minimal HTML escape to prevent XSS in the email.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * sendDigestEmail(client, matches)
 * Sends the daily digest email to the client via Resend.
 */
async function sendDigestEmail(client, matches) {
  const apiKey   = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'pipeline@podcastpipeline.com';
  const baseUrl  = process.env.BASE_URL || 'http://localhost:3000';

  if (!apiKey) {
    logger.warn('RESEND_API_KEY not set — skipping digest email', { clientId: client.id });
    return null;
  }

  const dashboardUrl = `${baseUrl}/dashboard/${client.dashboard_token}`;
  const html = buildDigestHtml(client, matches, dashboardUrl);
  const date = formatDate();

  const payload = {
    from:    fromEmail,
    to:      [client.email],
    subject: `Your Podcast Pipeline — ${date}`,
    html,
  };

  try {
    const response = await fetch(RESEND_API_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      logger.error('Resend API error', {
        clientId:   client.id,
        status:     response.status,
        resendError: data,
      });
      return null;
    }

    logger.info('Digest email sent', {
      clientId:  client.id,
      email:     client.email,
      messageId: data.id,
      matchCount: matches.length,
    });

    return data.id;
  } catch (err) {
    logger.error('Failed to send digest email', { clientId: client.id, error: err.message });
    return null;
  }
}

module.exports = { sendDigestEmail };
