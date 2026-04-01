'use strict';

const axios = require('axios');
const listennotes = require('../lib/listennotes');
const supabase = require('../lib/supabase');
const logger = require('../lib/logger');

/**
 * Hardcoded map of common topics to Listen Notes genre IDs.
 * https://www.listennotes.com/api/docs/#get-api-v2-genres
 */
const TOPIC_TO_GENRE = {
  entrepreneurship:      93,
  entrepreneur:          93,
  business:              67,
  technology:           127,
  tech:                 127,
  health:                88,
  wellness:              88,
  marketing:             97,
  leadership:            93,
  finance:               98,
  money:                 98,
  'personal-development': 111,
  'personal development': 111,
  education:            111,
  science:              107,
  sports:               122,
  'true crime':          135,
  comedy:                68,
  news:                  99,
  politics:              99,
  religion:             125,
  arts:                  68,
  fiction:              168,
  history:               125,
  travel:               122,
  food:                  71,
  investing:             98,
  'real estate':         98,
  mindset:              111,
  productivity:         111,
  parenting:             88,
  relationships:         88,
};

const GOOGLE_SEARCH_BASE = 'https://www.googleapis.com/customsearch/v1';
const currentYear = new Date().getFullYear();

/**
 * Run Google Custom Search queries to supplement discovery.
 * Returns an array of result items (with link and title) found in results.
 */
async function googleSearch(query) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;

  if (!apiKey || !cx) {
    logger.warn('Google Custom Search not configured — skipping', { query });
    return [];
  }

  try {
    const response = await axios.get(GOOGLE_SEARCH_BASE, {
      params: { key: apiKey, cx, q: query, num: 10 },
      timeout: 10000,
    });

    const items = response.data?.items || [];
    return items.filter(Boolean);
  } catch (err) {
    logger.error('Google Custom Search failed', { query, message: err.message });
    return [];
  }
}

/**
 * Build a normalised raw podcast object from a Listen Notes search result item.
 */
function normalisePodcast(item) {
  return {
    external_id:             item.id,
    title:                   item.title_original || item.title || 'Untitled',
    host_name:               item.publisher_original || item.publisher || null,
    description:             item.description_original || item.description || null,
    website:                 item.website || null,
    apple_url:               item.listennotes_url ? null : null, // enriched later
    spotify_url:             null,
    youtube_url:             null,
    category:                item.genre_ids?.[0]?.toString() || null,
    niche_tags:              item.genre_ids?.map(String) || [],
    total_episodes:          item.total_episodes ?? null,
    last_episode_date:       item.latest_pub_date_ms
                               ? new Date(item.latest_pub_date_ms).toISOString().slice(0, 10)
                               : null,
    country:                 item.country || null,
    language:                item.language || 'English',
    listen_score:            item.listen_score ?? null,
    image:                   item.image || null,
    thumbnail:               item.thumbnail || null,
    // raw listennotes url for further fetching
    listennotes_url:         item.listennotes_url || null,
  };
}

/**
 * discoverPodcasts(client)
 * Main discovery pipeline for a single client.
 * Returns up to 100 raw, deduplicated, pre-filtered podcast objects.
 */
async function discoverPodcasts(client, { isManual = false } = {}) {
  logger.info('Starting discovery', { clientId: client.id, clientName: client.name });

  // ─────────────────────────────────────────────────────────────
  // 0. Monthly booking cap check
  // ─────────────────────────────────────────────────────────────
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { count: bookedThisMonth } = await supabase
    .from('podcast_matches')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', client.id)
    .eq('status', 'booked')
    .gte('updated_at', startOfMonth.toISOString());

  const monthlyCap = client.monthly_booking_cap ?? 10;

  if ((bookedThisMonth || 0) >= monthlyCap) {
    logger.info('Monthly booking cap reached', { clientId: client.id, bookedThisMonth, monthlyCap });
    return [];
  }

  const allCandidates = new Map(); // external_id → podcast object

  // ─────────────────────────────────────────────────────────────
  // 1. Build 10 Listen Notes search queries from client profile
  // ─────────────────────────────────────────────────────────────
  const primaryTopic   = client.topics?.[0] || 'business';
  const secondaryTopic = client.topics?.[1] || primaryTopic;
  const angle          = client.speaking_angles?.[0] || primaryTopic;
  const audience       = client.target_audience || 'entrepreneurs';

  const queries = [
    `${primaryTopic} podcast`,
    `${secondaryTopic} podcast`,
    `${primaryTopic} interview podcast`,
    `${audience} podcast`,
    `best ${primaryTopic} podcast guest`,
    `${angle} podcast`,
    `${primaryTopic} ${secondaryTopic} podcast`,
    `${audience} ${primaryTopic} podcast`,
    `how to ${angle} podcast`,
    `${primaryTopic} entrepreneurs podcast guest interview`,
  ];

  // 90-day published_after timestamp
  const ninetyDaysAgo = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
  const language = client.languages?.[0] || 'English';

  for (const query of queries) {
    logger.debug('Running Listen Notes search', { query });
    const result = await listennotes.searchPodcasts(query, {
      type:           'podcast',
      language,
      len_min:        15,
      published_after: ninetyDaysAgo,
      sort_by_date:   0,
      safe_mode:      1,
    });

    const podcasts = result?.results || [];
    for (const item of podcasts) {
      if (item.id && !allCandidates.has(item.id)) {
        allCandidates.set(item.id, normalisePodcast(item));
      }
    }
  }

  logger.info('Listen Notes search complete', { candidatesSoFar: allCandidates.size });

  // ─────────────────────────────────────────────────────────────
  // 2. getBestPodcasts for each client topic mapped to genre ID
  // ─────────────────────────────────────────────────────────────
  const topicsToSearch = (client.topics || []).slice(0, 4);

  for (const topic of topicsToSearch) {
    const topicLower = topic.toLowerCase();
    // Find best matching genre
    const genreId = TOPIC_TO_GENRE[topicLower]
      || Object.entries(TOPIC_TO_GENRE).find(([k]) => topicLower.includes(k))?.[1]
      || 67; // default to Business

    logger.debug('Fetching best podcasts for topic', { topic, genreId });
    const result = await listennotes.getBestPodcasts({ genre_id: genreId, page: 1, safe_mode: 1 });
    const podcasts = result?.podcasts || [];

    for (const item of podcasts) {
      if (item.id && !allCandidates.has(item.id)) {
        allCandidates.set(item.id, normalisePodcast(item));
      }
    }
  }

  logger.info('Best podcasts fetch complete', { candidatesSoFar: allCandidates.size });

  // ─────────────────────────────────────────────────────────────
  // 3. Google Custom Search supplementary discovery
  // ─────────────────────────────────────────────────────────────
  const googleQueries = [
    `"${primaryTopic}" podcast guest experts ${currentYear}`,
    `best "${audience}" podcast accept guest submissions`,
  ];

  for (const q of googleQueries) {
    const items = await googleSearch(q);
    logger.debug('Google search returned items', { query: q, count: items.length });
    for (const item of items) {
      if (!item.link) continue;
      try {
        const domain = new URL(item.link).hostname.replace(/^www\./, '');
        // Use domain as a keyword search to find the podcast on Listen Notes
        const domainKeyword = domain.split('.')[0];
        if (domainKeyword && domainKeyword.length > 2) {
          const result = await listennotes.searchPodcasts(domainKeyword, {
            type: 'podcast',
            language,
            len_min: 15,
            safe_mode: 1,
          });
          const podcasts = result?.results || [];
          for (const pod of podcasts) {
            if (pod.id && !allCandidates.has(pod.id)) {
              allCandidates.set(pod.id, normalisePodcast(pod));
            }
          }
        }
      } catch (_) {
        // Skip malformed URLs
      }
    }
  }

  logger.info('Google supplementary search complete', { candidatesSoFar: allCandidates.size });

  // ─────────────────────────────────────────────────────────────
  // 3b. Similar podcasts chaining — skipped on manual runs for speed
  // ─────────────────────────────────────────────────────────────
  if (isManual) {
    logger.info('Manual run — skipping similar podcast chaining');
  }
  const top3 = isManual ? [] : Array.from(allCandidates.values())
    .filter((p) => p.listen_score != null)
    .sort((a, b) => (b.listen_score || 0) - (a.listen_score || 0))
    .slice(0, 3);

  for (const topPodcast of top3) {
    logger.debug('Fetching similar podcasts', { podcastId: topPodcast.external_id, title: topPodcast.title });
    const result = await listennotes.getSimilarPodcasts(topPodcast.external_id);
    const recommendations = result?.recommendations || [];
    for (const item of recommendations) {
      if (item.id && !allCandidates.has(item.id)) {
        allCandidates.set(item.id, normalisePodcast(item));
      }
    }
  }

  logger.info('Similar podcasts chaining complete', { candidatesSoFar: allCandidates.size });

  // ─────────────────────────────────────────────────────────────
  // 4. Deduplicate (already done via Map) — fetch existing matches
  //    to avoid re-processing podcasts this client has already seen
  // ─────────────────────────────────────────────────────────────
  const { data: existingMatches, error: matchError } = await supabase
    .from('podcast_matches')
    .select('podcast_id, podcasts(external_id)')
    .eq('client_id', client.id);

  if (matchError) {
    logger.error('Failed to fetch existing matches', { clientId: client.id, error: matchError.message });
  }

  const alreadyMatchedExternalIds = new Set(
    (existingMatches || [])
      .map((m) => m.podcasts?.external_id)
      .filter(Boolean)
  );

  logger.info('Existing matches loaded', { count: alreadyMatchedExternalIds.size });

  // ─────────────────────────────────────────────────────────────
  // 5. Filter pipeline
  // ─────────────────────────────────────────────────────────────
  const now = Date.now();
  const maxAgeMs  = (client.max_show_age_days || 90)  * 24 * 60 * 60 * 1000;
  const minEps    = client.min_show_episodes || 20;

  const filtered = [];

  for (const podcast of allCandidates.values()) {
    // Filter: already matched
    if (alreadyMatchedExternalIds.has(podcast.external_id)) continue;

    // Filter: episode count below minimum
    if (podcast.total_episodes !== null && podcast.total_episodes < minEps) continue;

    // Filter: last episode too old
    if (podcast.last_episode_date) {
      const lastEpMs = new Date(podcast.last_episode_date).getTime();
      if (now - lastEpMs > maxAgeMs) continue;
    }

    filtered.push(podcast);

    if (filtered.length >= 25) break;
  }

  logger.info('Discovery complete', {
    clientId: client.id,
    totalFound: allCandidates.size,
    afterFiltering: filtered.length,
  });

  return filtered;
}

module.exports = { discoverPodcasts };
