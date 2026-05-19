'use strict';

/**
 * Apple Podcasts Artwork Service
 *
 * Fetches high-resolution podcast cover art from Apple Podcasts / iTunes.
 * Uses the public iTunes lookup API (no API key needed).
 *
 * Artwork is cached in the `image` column of the `podcasts` table.
 * Sizes: artworkUrl60 (60x60), artworkUrl100 (100x100), artworkUrl600 (600x600)
 * We store the 600x600 version for crisp display.
 */

const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the Apple Podcasts ID from an apple_url.
 * Supports formats like:
 *   https://podcasts.apple.com/us/podcast/title/id1234567890
 *   https://podcasts.apple.com/podcast/id1234567890
 *   https://itunes.apple.com/podcast/id1234567890
 *   id1234567890 (bare ID)
 */
function extractAppleId(appleUrl) {
  if (!appleUrl) return null;

  // Try `/id1234567890` pattern
  const idMatch = appleUrl.match(/\/id(\d{6,})/);
  if (idMatch) return idMatch[1];

  // Try bare numeric ID (if the URL is just an ID number)
  const bareMatch = appleUrl.match(/^(\d{6,})$/);
  if (bareMatch) return bareMatch[1];

  return null;
}

/**
 * Fetch artwork URL from the iTunes API.
 * Returns the 600x600 artwork URL, or null on failure.
 */
async function fetchArtworkFromItunes(appleId) {
  if (!appleId) return null;

  try {
    const url = `https://itunes.apple.com/lookup?id=${appleId}&entity=podcast`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      logger.warn('appleArtwork: iTunes API returned non-OK', {
        appleId,
        status: response.status,
      });
      return null;
    }

    const data = await response.json();
    const results = data.results || [];

    // The first result that has artworkUrl600 is our podcast
    const podcast = results.find(
      (r) => r.wrapperType === 'podcast' && r.artworkUrl600
    );

    if (podcast?.artworkUrl600) {
      // Upgrade to largest available: artworkUrl600
      return podcast.artworkUrl600;
    }

    // Fallback to smaller sizes
    const anySize =
      results.find(
        (r) =>
          r.wrapperType === 'podcast' &&
          (r.artworkUrl100 || r.artworkUrl60)
      ) || null;

    if (anySize?.artworkUrl100) return anySize.artworkUrl100;
    if (anySize?.artworkUrl60) return anySize.artworkUrl60;

    logger.debug('appleArtwork: no artwork in iTunes response', {
      appleId,
      resultCount: results.length,
    });
    return null;
  } catch (err) {
    logger.warn('appleArtwork: iTunes API error', {
      appleId,
      error: err.message,
    });
    return null;
  }
}

/**
 * Attempt to extract artwork from the Apple Podcasts page HTML directly
 * as a fallback when the iTunes API returns nothing useful.
 * Apple embeds og:image with the artwork in their HTML pages.
 */
async function fetchArtworkFromApplePage(appleUrl) {
  if (!appleUrl) return null;

  try {
    const response = await fetch(appleUrl, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    if (!response.ok) return null;

    const html = await response.text();

    // Try og:image meta tag
    const ogMatch = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    );
    if (ogMatch && ogMatch[1]) {
      // Upgrade to 600x600 if it's a smaller size
      return ogMatch[1].replace(/\/\d+x\d+bb\.(jpg|png)/, '/600x600bb.$1');
    }

    // Try schema.org JSON-LD
    const ldMatch = html.match(
      /"thumbnailUrl"\s*:\s*"([^"]+)"/
    );
    if (ldMatch && ldMatch[1]) {
      return ldMatch[1];
    }

    return null;
  } catch (err) {
    logger.debug('appleArtwork: Apple page fetch failed', {
      appleUrl,
      error: err.message,
    });
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch and store podcast cover art for a given podcast ID.
 *
 * Strategy:
 * 1. Lookup the podcast in the DB
 * 2. Try the iTunes API first (fastest, most reliable)
 * 3. Fallback to scraping the Apple Podcasts page HTML
 * 4. Store the result in the `image` column
 *
 * @param {string} podcastId - UUID of the podcast
 * @returns {Promise<{ok: boolean, imageUrl: string|null, error?: string}>}
 */
async function fetchAndStoreArtwork(podcastId) {
  if (!podcastId) {
    return { ok: false, imageUrl: null, error: 'podcastId_required' };
  }

  // 1. Fetch podcast from DB
  const { data: podcast, error: dbError } = await supabase
    .from('podcasts')
    .select('id, title, apple_url, image')
    .eq('id', podcastId)
    .single();

  if (dbError || !podcast) {
    return { ok: false, imageUrl: null, error: 'podcast_not_found' };
  }

  // If already has an image, skip
  if (podcast.image) {
    return { ok: true, imageUrl: podcast.image, cached: true };
  }

  // 2. Extract Apple Podcasts ID
  const appleId = extractAppleId(podcast.apple_url);

  if (!appleId) {
    logger.warn('appleArtwork: no valid Apple Podcasts ID found', {
      podcastId,
      appleUrl: podcast.apple_url,
      title: podcast.title,
    });
    return { ok: false, imageUrl: null, error: 'no_apple_id' };
  }

  // 3. Fetch from iTunes API
  let artworkUrl = await fetchArtworkFromItunes(appleId);

  // 4. Fallback: scrape Apple Podcasts page
  if (!artworkUrl && podcast.apple_url) {
    artworkUrl = await fetchArtworkFromApplePage(podcast.apple_url);
  }

  if (!artworkUrl) {
    logger.warn('appleArtwork: could not fetch artwork from any source', {
      podcastId,
      appleId,
      title: podcast.title,
    });
    return { ok: false, imageUrl: null, error: 'artwork_not_found' };
  }

  // 5. Store in database
  const { error: updateError } = await supabase
    .from('podcasts')
    .update({ image: artworkUrl })
    .eq('id', podcastId);

  if (updateError) {
    logger.error('appleArtwork: failed to store image in DB', {
      podcastId,
      error: updateError.message,
    });
    return { ok: false, imageUrl: null, error: 'db_update_failed' };
  }

  logger.info('appleArtwork: stored artwork for podcast', {
    podcastId,
    title: podcast.title,
    imageUrl,
  });

  return { ok: true, imageUrl };
}

/**
 * Batch fetch artwork for all podcasts linked to a client that
 * don't already have an image. Processes sequentially to avoid
 * rate limiting.
 *
 * @param {string} clientId - UUID of the client
 * @param {number} max - Max podcasts to process (default: 20)
 * @returns {Promise<{ok: boolean, results: Array}>}
 */
async function batchFetchArtwork(clientId, max = 20) {
  if (!clientId) {
    return { ok: false, results: [], error: 'clientId_required' };
  }

  try {
    // Find podcasts linked to this client that are missing images
    const { data: matches, error: matchError } = await supabase
      .from('podcast_matches')
      .select('podcast_id')
      .eq('client_id', clientId);

    if (matchError || !matches || matches.length === 0) {
      return { ok: true, results: [], error: null };
    }

    const podcastIds = matches
      .map((m) => m.podcast_id)
      .filter(Boolean);

    const { data: podcasts } = await supabase
      .from('podcasts')
      .select('id, title, apple_url, image')
      .in('id', podcastIds)
      .or('image.is.null,image.eq.');

    if (!podcasts || podcasts.length === 0) {
      return { ok: true, results: [], error: null };
    }

    const candidates = podcasts
      .filter((p) => !p.image)
      .slice(0, max);

    const results = [];
    for (const podcast of candidates) {
      const result = await fetchAndStoreArtwork(podcast.id);
      results.push({
        podcastId: podcast.id,
        title: podcast.title,
        ...result,
      });
    }

    return { ok: true, results };
  } catch (err) {
    logger.error('appleArtwork: batch fetch failed', {
      clientId,
      error: err.message,
    });
    return { ok: false, results: [], error: err.message };
  }
}

module.exports = {
  extractAppleId,
  fetchArtworkFromItunes,
  fetchArtworkFromApplePage,
  fetchAndStoreArtwork,
  batchFetchArtwork,
};