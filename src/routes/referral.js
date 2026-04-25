'use strict';

const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const logger = require('../lib/logger');

const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'hi@findapodcast.io';

// POST /api/referral-waitlist — captures interest in the referral program
// Saves to stage_waitlist (reusing schema since it's a generic "waitlist" pattern)
// AND emails Zac so he knows someone wants to be a referrer.
router.post('/api/referral-waitlist', async (req, res) => {
  const { clientId, email, name } = req.body || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  // Save to stage_waitlist with industry='referral_program' as a discriminator
  try {
    await supabase.from('stage_waitlist').insert({
      client_id: clientId || null,
      email: email.trim().toLowerCase(),
      industry: 'referral_program',
      notes: name ? `Name: ${name}` : null,
    });
  } catch (err) {
    logger.warn('referral waitlist insert failed (non-blocking)', { error: err.message });
  }

  // Notify Zac
  try {
    if (RESEND_API_KEY) {
      const html = `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:540px;margin:0 auto;padding:24px;background:#fff;color:#1d1d1f;">
          <div style="background:#6366f1;color:#fff;padding:16px 20px;border-radius:12px;margin-bottom:20px;">
            <div style="font-size:13px;opacity:0.85;font-weight:600;letter-spacing:0.05em;">REFER-A-FRIEND WAITLIST</div>
            <div style="font-size:20px;font-weight:800;margin-top:4px;">${esc(name || email)}</div>
          </div>
          <p style="font-size:14px;color:#1d1d1f;line-height:1.7;">An existing customer wants in on the referral program.</p>
          <table style="width:100%;font-size:14px;line-height:1.7;">
            <tr><td style="padding:4px 0;color:#6e6e73;width:90px;">Email</td><td style="padding:4px 0;"><a href="mailto:${esc(email)}" style="color:#6366f1;">${esc(email)}</a></td></tr>
            ${name ? `<tr><td style="padding:4px 0;color:#6e6e73;">Name</td><td style="padding:4px 0;">${esc(name)}</td></tr>` : ''}
            ${clientId ? `<tr><td style="padding:4px 0;color:#6e6e73;">Client ID</td><td style="padding:4px 0;font-family:monospace;font-size:12px;">${esc(clientId)}</td></tr>` : ''}
          </table>
          <div style="margin-top:18px;padding:12px;background:#f5f5f7;border-radius:10px;font-size:12.5px;color:#6e6e73;">
            Once you set up the Stripe partner / referral tracking, send them their personal link:<br>
            <code style="background:#fff;padding:2px 6px;border-radius:4px;">https://findapodcast.io?ref=&lt;their-code&gt;</code>
          </div>
        </div>`;
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: RESEND_FROM_EMAIL,
          to: ['hi@zacdeane.com'],
          reply_to: email,
          subject: `[Referral] ${name || email} wants on the program`,
          html,
        }),
      });
    }
  } catch (err) {
    logger.warn('referral waitlist email failed (saved anyway)', { error: err.message });
  }

  res.json({ ok: true });
});

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

module.exports = router;
