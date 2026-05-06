'use strict';

/**
 * Retry failed deep-enrich with 5s delay between calls to respect SGAI rate limits.
 */
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ldyocadmkwesdwcnojjf.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CLIENT_ID = process.env.CLIENT_ID || 'ad53ebbc-5473-4116-a7f4-6e8147cdd4bf';

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { deepEnrichPodcastWithSGAI } = require('../src/services/sgai-enricher');

async function main() {
  // 1. Get all podcast matches for client
  const { data: matches, error: mErr } = await supabase
    .from('podcast_matches')
    .select('podcast_id')
    .eq('client_id', CLIENT_ID);
  if (mErr) { console.error('Failed to fetch matches:', mErr.message); process.exit(1); }

  const allIds = [...new Set(matches.map(m => m.podcast_id).filter(Boolean))];

  // 2. Find ones still not deep-enriched
  const { data: podcasts, error: pErr } = await supabase
    .from('podcasts')
    .select('id, title, deep_enriched_at, website, apple_url, spotify_url')
    .in('id', allIds);
  if (pErr) { console.error('Failed to fetch podcasts:', pErr.message); process.exit(1); }

  const toEnrich = podcasts.filter(p => !p.deep_enriched_at);
  console.log(`Already deep-enriched: ${podcasts.length - toEnrich.length}`);
  console.log(`Remaining to enrich: ${toEnrich.length}`);

  if (toEnrich.length === 0) {
    console.log('All done!');
    return;
  }

  let success = 0;
  let failed = 0;

  for (let i = 0; i < toEnrich.length; i++) {
    const p = toEnrich[i];
    const idx = i + 1;
    const label = p.title || p.id.slice(0, 8);

    process.stdout.write(`  [${idx}/${toEnrich.length}] ${label}... `);
    try {
      const result = await deepEnrichPodcastWithSGAI(p.id);
      if (result.ok) {
        console.log(`✅ fields: ${result.fields_found?.join(', ') || 'none'}`);
        success++;
      } else {
        console.log(`❌ ${result.error}`);
        failed++;
        // If rate limited, wait longer before retry
        if (result.error?.includes('429')) {
          console.log('     Rate limited — waiting 10s...');
          await new Promise(r => setTimeout(r, 10000));
          // Retry once
          process.stdout.write(`     Retry ${label}... `);
          const retry = await deepEnrichPodcastWithSGAI(p.id);
          if (retry.ok) {
            console.log(`✅ fields: ${retry.fields_found?.join(', ') || 'none'}`);
            failed--;
            success++;
          } else {
            console.log(`❌ ${retry.error}`);
          }
        }
      }
    } catch (err) {
      console.log(`💥 ${err.message}`);
      failed++;
    }

    // 5-second delay between each podcast
    if (i < toEnrich.length - 1) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log(`\nDone! ✅ ${success} enriched | ❌ ${failed} failed`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
