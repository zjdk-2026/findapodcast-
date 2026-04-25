'use strict';
/**
 * Verify each seeded stage:
 *   - HEAD-check `url` and `cfp_url` (must return 200 or 3xx)
 *   - MX-check organiser email domain
 * Marks each row with verification_status in `contact_sources` and nulls
 * out fields that fail. Anything entirely unverifiable gets contact_unlocked_at = NULL
 * so the preview filter ('verified contact' checkbox) can hide it.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const dns = require('dns').promises;

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function headOk(url) {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FindAPodcastBot/1.0)' },
    });
    return [200, 301, 302, 303, 307, 308].includes(res.status);
  } catch {
    // Some servers reject HEAD — fall back to GET with timeout
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(6000),
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FindAPodcastBot/1.0)' },
      });
      return res.ok || [301, 302].includes(res.status);
    } catch {
      return false;
    }
  }
}

async function mxOk(email) {
  if (!email || !email.includes('@')) return false;
  const domain = email.split('@')[1];
  try {
    const records = await dns.resolveMx(domain);
    return records && records.length > 0;
  } catch {
    return false;
  }
}

(async () => {
  const { data: stages, error } = await s.from('stages').select('*').eq('source', 'seed');
  if (error) { console.error(error); process.exit(1); }
  console.log(`Verifying ${stages.length} seeded stages…\n`);

  let urlOk = 0, urlBad = 0, emailOk = 0, emailBad = 0, fullyKilled = 0;
  for (const stg of stages) {
    const url       = stg.url;
    const cfpUrl    = stg.cfp_url;
    const email     = stg.organizer_email;

    const urlPass    = await headOk(url);
    const cfpPass    = cfpUrl && cfpUrl !== url ? await headOk(cfpUrl) : urlPass;
    const emailPass  = email ? await mxOk(email) : null;

    const updates = {};
    const verification = {};

    if (urlPass)   { verification.url = 'head_200'; urlOk++; }
    else           { updates.url = null; verification.url = 'head_failed'; urlBad++; }

    if (cfpUrl) {
      if (cfpPass) verification.cfp_url = 'head_200';
      else         { updates.cfp_url = null; verification.cfp_url = 'head_failed'; }
    }

    if (email) {
      if (emailPass) { verification.organizer_email = 'mx_ok'; emailOk++; }
      else           { updates.organizer_email = null; verification.organizer_email = 'mx_failed'; emailBad++; }
    }

    // If nothing about the stage verifies, mark contact_unlocked_at = null so it hides
    const anyVerified = urlPass || cfpPass || emailPass;
    if (!anyVerified) {
      updates.contact_unlocked_at = null;
      updates.contact_confidence  = 'none';
      fullyKilled++;
    } else {
      updates.contact_confidence = (urlPass && emailPass) ? 'high' : urlPass || emailPass ? 'medium' : 'low';
    }

    updates.contact_sources = { ...(stg.contact_sources || {}), verification };

    await s.from('stages').update(updates).eq('id', stg.id);

    const flag = anyVerified ? '✅' : '❌';
    console.log(flag, stg.name.slice(0, 45).padEnd(45), '| url:', urlPass ? 'OK' : 'BAD', '| cfp:', cfpPass ? 'OK' : 'BAD', '| email:', email ? (emailPass ? 'OK' : 'BAD') : '—');
  }

  console.log('');
  console.log('SUMMARY');
  console.log('  URLs verified:', urlOk, '/', stages.length);
  console.log('  Emails MX-verified:', emailOk, '/', emailOk + emailBad);
  console.log('  Fully killed (no verification at all):', fullyKilled);
})();
