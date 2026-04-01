'use strict';

const { Resend } = require('resend');
const supabase   = require('../lib/supabase');
const logger     = require('../lib/logger');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM   = process.env.RESEND_FROM_EMAIL || 'hi@podcastpipeline.com';

/**
 * sendWeeklyDigest(client)
 * Sends a Monday HTML email summarising the client's week in Podcast Pipeline.
 */
async function sendWeeklyDigest(client) {
  if (!client.email) {
    logger.warn('Weekly digest: client has no email', { clientId: client.id });
    return;
  }

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch all matches for this client
  const { data: allMatches, error } = await supabase
    .from('podcast_matches')
    .select('*, podcasts(title, fit_score)')
    .eq('client_id', client.id)
    .order('fit_score', { ascending: false });

  if (error) {
    logger.error('Weekly digest: failed to fetch matches', {
      clientId: client.id,
      error:    error.message,
    });
    return;
  }

  const matches = allMatches || [];

  // This week's stats
  const sentThisWeek    = matches.filter((m) => m.status === 'sent'    && m.sent_at    >= weekAgo);
  const repliedThisWeek = matches.filter((m) => m.status === 'replied' && m.updated_at >= weekAgo);
  const bookedThisWeek  = matches.filter((m) => m.status === 'booked'  && m.updated_at >= weekAgo);

  // Top 3 awaiting approval (status = 'new', highest score)
  const topOpps = matches
    .filter((m) => m.status === 'new')
    .slice(0, 3);

  const dashboardUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/dashboard/${client.dashboard_token}`;

  const html = buildDigestHtml({
    clientName:    client.name,
    sentThisWeek,
    repliedThisWeek,
    bookedThisWeek,
    topOpps,
    dashboardUrl,
  });

  try {
    await resend.emails.send({
      from:    FROM,
      to:      client.email,
      subject: `Your week in Podcast Pipeline — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      html,
    });
    logger.info('Weekly digest sent', { clientId: client.id, email: client.email });
  } catch (err) {
    logger.error('Weekly digest: Resend failed', { clientId: client.id, error: err.message });
  }
}

function buildDigestHtml({ clientName, sentThisWeek, repliedThisWeek, bookedThisWeek, topOpps, dashboardUrl }) {
  const sentRows = sentThisWeek.map((m) =>
    `<tr><td style="padding:8px 12px;color:#f1f5f9;font-size:14px;">${esc(m.podcasts?.title || 'Unknown')}</td><td style="padding:8px 12px;color:#94a3b8;font-size:13px;">${m.sent_at ? new Date(m.sent_at).toLocaleDateString() : '—'}</td></tr>`
  ).join('');

  const oppRows = topOpps.map((m) =>
    `<tr><td style="padding:8px 12px;color:#f1f5f9;font-size:14px;">${esc(m.podcasts?.title || 'Unknown')}</td><td style="padding:8px 12px;"><span style="background:rgba(99,102,241,0.2);color:#a5b4fc;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;">${m.fit_score || 0}</span></td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#0a0a14;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a14;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:#111120;border:1px solid #252540;border-radius:16px 16px 0 0;padding:32px 40px;text-align:center;">
          <p style="color:#6366f1;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 8px;">Podcast Pipeline</p>
          <h1 style="color:#f1f5f9;font-size:26px;font-weight:800;margin:0 0 8px;letter-spacing:-0.02em;">Your Week in Review</h1>
          <p style="color:#94a3b8;font-size:14px;margin:0;">Hi ${esc(clientName)}, here's what happened this week.</p>
        </td></tr>

        <!-- Stats row -->
        <tr><td style="background:#16162a;border-left:1px solid #252540;border-right:1px solid #252540;padding:24px 40px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td align="center" style="padding:16px;background:#111120;border:1px solid #252540;border-radius:12px;width:33%;">
                <p style="color:#60a5fa;font-size:28px;font-weight:800;margin:0;line-height:1;">${sentThisWeek.length}</p>
                <p style="color:#4b5563;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin:4px 0 0;">Pitches Sent</p>
              </td>
              <td width="12"></td>
              <td align="center" style="padding:16px;background:#111120;border:1px solid #252540;border-radius:12px;width:33%;">
                <p style="color:#c084fc;font-size:28px;font-weight:800;margin:0;line-height:1;">${repliedThisWeek.length}</p>
                <p style="color:#4b5563;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin:4px 0 0;">Replies</p>
              </td>
              <td width="12"></td>
              <td align="center" style="padding:16px;background:#111120;border:1px solid #252540;border-radius:12px;width:33%;">
                <p style="color:#34d399;font-size:28px;font-weight:800;margin:0;line-height:1;">${bookedThisWeek.length}</p>
                <p style="color:#4b5563;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin:4px 0 0;">Bookings</p>
              </td>
            </tr>
          </table>
        </td></tr>

        ${sentThisWeek.length > 0 ? `
        <!-- Sent this week -->
        <tr><td style="background:#16162a;border-left:1px solid #252540;border-right:1px solid #252540;padding:0 40px 24px;">
          <p style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 12px;">Pitches Sent This Week</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#111120;border:1px solid #252540;border-radius:10px;overflow:hidden;">
            ${sentRows}
          </table>
        </td></tr>` : ''}

        ${topOpps.length > 0 ? `
        <!-- Top opportunities -->
        <tr><td style="background:#16162a;border-left:1px solid #252540;border-right:1px solid #252540;padding:0 40px 24px;">
          <p style="color:#94a3b8;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 12px;">Top Opportunities Awaiting Your Approval</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#111120;border:1px solid #252540;border-radius:10px;overflow:hidden;">
            <tr style="background:#0a0a14;">
              <th style="padding:8px 12px;text-align:left;color:#4b5563;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">Show</th>
              <th style="padding:8px 12px;text-align:left;color:#4b5563;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;">Score</th>
            </tr>
            ${oppRows}
          </table>
        </td></tr>` : ''}

        <!-- CTA -->
        <tr><td style="background:#16162a;border-left:1px solid #252540;border-right:1px solid #252540;border-bottom:1px solid #252540;border-radius:0 0 16px 16px;padding:24px 40px 36px;text-align:center;">
          <a href="${dashboardUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-size:15px;font-weight:700;letter-spacing:-0.01em;">Review Your Pipeline →</a>
          <p style="color:#4b5563;font-size:12px;margin:20px 0 0;">You're receiving this because you're a Podcast Pipeline client.<br/>Questions? Reply to this email.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { sendWeeklyDigest };
