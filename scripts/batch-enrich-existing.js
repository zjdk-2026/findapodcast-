'use strict';

/**
 * Batch deep-enrich all existing podcasts for a given client.
 * Run: node scripts/batch-enrich-existing.js
 *
 * Reads env vars from process.env (set below or via Railway)
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ldyocadmkwesdwcnojjf.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CLIENT_ID = process.env.CLIENT_ID || 'ad53ebbc-5473-4116-a7f4-6e8147cdd4bf';

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  // 1. Get all podcast matches for client
  const { data: matches, error: mErr } = await supabase
    .from('podcast_matches')
    .select('podcast_id')
    .eq('client_id', CLIENT_ID);

  if (mErr) { console.error('Failed to fetch matches:', mErr.message); process.exit(1); }

  const allIds = [...new Set(matches.map(m => m.podcast_id).filter(Boolean))];
  console.log(`Total unique podcasts for client: ${allIds.length}`);

  // 2. Check which are already deep-enriched
  const { data: podcasts, error: pErr } = await supabase
    .from('podcasts')
    .select('id, title, deep_enriched_at, website')
    .in('id', allIds);

  if (pErr) { console.error('Failed to fetch podcasts:', pErr.message); process.exit(1); }

  const toEnrich = podcasts.filter(p => !p.deep_enriched_at);
  const alreadyDone = podcasts.filter(p => p.deep_enriched_at);
  console.log(`Already deep-enriched: ${alreadyDone.length}`);
  console.log(`Need deep enrich: ${toEnrich.length}`);
  console.log(`SGAI credits needed: ~${toEnrich.length * 2}`);

  if (toEnrich.length === 0) {
    console.log('Nothing to do!');
    return;
  }

  // 3. Load the enricher
  const { deepEnrichPodcastWithSGAI } = require('../src/services/sgai-enricher');

  // 4. Process one at a time
  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < toEnrich.length; i++) {
    const p = toEnrich[i];
    const idx = i + 1;
    const label = p.title || p.id.slice(0, 8);

    // Skip if no website and no directory URL
    if (!p.website) {
      // Check if has apple_url or spotify_url via separate query
      const { data: full } = await supabase
        .from('podcasts')
        .select('website, apple_url, spotify_url, url')
        .eq('id', p.id)
        .single();

      if (!full || (!full.website && !full.apple_url && !full.spotify_url)) {
        console.log(`  [${idx}/${toEnrich.length}] ⏭ SKIP ${label} — no discoverable URL`);
        skipped++;

        // Mark as enriched so we don't retry forever
        await supabase.from('podcasts').update({ deep_enriched_at: new Date().toISOString() }).eq('id', p.id);
        continue;
      }
    }

    process.stdout.write(`  [${idx}/${toEnrich.length}] ${label}... `);
    try {
      const result = await deepEnrichPodcastWithSGAI(p.id);
      if (result.ok) {
        console.log(`✅ fields: ${result.fields_found?.join(', ') || 'none'}`);
        success++;
      } else {
        console.log(`❌ ${result.error}`);
        failed++;
      }
    } catch (err) {
      console.log(`💥 ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone! ✅ ${success} enriched | ❌ ${failed} failed | ⏭ ${skipped} skipped`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
