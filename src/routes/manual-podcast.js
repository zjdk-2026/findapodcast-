'use strict';
const express  = require('express');
const supabase = require('../lib/supabase');
const logger   = require('../lib/logger');
const { enrichPodcast } = require('../services/enrichment');
const { scorePodcast }  = require('../services/scoring');

const router = express.Router();

const ITUNES_TIMEOUT_MS = 8000;

/**
 * Look up a podcast on the iTunes API using an Apple Podcasts URL or title.
 * Returns a partial podcast object with whatever iTunes knows, or {}.
 */
async function lookupItunes({ appleUrl, podcastName }) {
  try {
    let result = null;

    // 1. Prefer lookup by iTunes ID (most accurate)
    const itunesId = appleUrl?.match(/[?&]?id(\d{6,})/)?.[1];
    if (itunesId) {
      const res  = await fetch(`https://itunes.apple.com/lookup?id=${itunesId}&entity=podcast`, { signal: AbortSignal.timeout(ITUNES_TIMEOUT_MS) });
      const data = await res.json();
      result = data.results?.[0] || null;
      logger.debug('iTunes ID lookup', { itunesId, found: !!result });
    }

    // 2. Fallback: search by name
    if (!result && podcastName) {
      const q   = encodeURIComponent(podcastName.slice(0, 60));
      const res = await fetch(`https://itunes.apple.com/search?term=${q}&media=podcast&limit=5`, { signal: AbortSignal.timeout(ITUNES_TIMEOUT_MS) });
      const data = await res.json();
      // Pick the closest title match
      const lower = podcastName.toLowerCase();
      result = data.results?.find(r => r.collectionName?.toLowerCase().includes(lower.slice(0, 12)))
            || data.results?.[0]
            || null;
      logger.debug('iTunes name search', { podcastName, found: !!result });
    }

    if (!result) return {};

    // Extract last episode date from releaseDate (most recent episode)
    const lastEpisodeDate = result.releaseDate ? new Date(result.releaseDate).toISOString().split('T')[0] : null;

    return {
      title:             result.collectionName  || null,
      host_name:         result.artistName       || null,
      description:       result.description || result.collectionCensoredName || null,
      total_episodes:    typeof result.trackCount === 'number' ? result.trackCount : null,
      rss_feed_url:      result.feedUrl          || null,
      category:          result.primaryGenreName || null,
      country:           result.country          || null,
      apple_url:         result.collectionViewUrl || appleUrl || null,
      last_episode_date: lastEpisodeDate,
      artwork_url:       result.artworkUrl600    || result.artworkUrl100 || null,
    };
  } catch (err) {
    logger.warn('iTunes lookup failed', { appleUrl, podcastName, error: err.message });
    return {};
  }
}

// ── POST /api/operator/add-podcast ────────────────────────────────────────────
// Accepts from client dashboard (x-dashboard-token) OR operator panel (x-operator-key)
router.post('/add-podcast', async (req, res) => {
  const {
    clientId, podcastUrl, podcastName,
    contactEmail, instagramUrl, linkedinUrl,
    facebookUrl, spotifyUrl, appleUrl, notes,
  } = req.body;

  // Resolve clientId: token always wins over body clientId to prevent spoofing
  const token = req.headers['x-dashboard-token'];
  const operatorKey = req.headers['x-operator-key'];
  let resolvedClientId = null;

  if (token) {
    const { data: c } = await supabase.from('clients').select('id').eq('dashboard_token', token).single();
    resolvedClientId = c?.id || null;
  } else if (operatorKey && operatorKey === process.env.OPERATOR_SECRET && clientId) {
    resolvedClientId = clientId;
  }

  if (!resolvedClientId || (!podcastUrl && !podcastName && !appleUrl)) {
    return res.status(400).json({ success: false, error: 'A podcast URL, Apple Podcasts link, or name is required.' });
  }

  try {
    // ── 0. Pre-check: has this URL already been added for this client? ────────
    const urlsToCheck = [podcastUrl, appleUrl, spotifyUrl].filter(Boolean);
    if (urlsToCheck.length > 0) {
      for (const checkUrl of urlsToCheck) {
        // Use separate eq queries (not .or() template) to avoid URL characters breaking PostgREST filter syntax
        const [byWebsite, byApple, bySpotify] = await Promise.all([
          supabase.from('podcasts').select('id').eq('website', checkUrl).maybeSingle(),
          supabase.from('podcasts').select('id').eq('apple_url', checkUrl).maybeSingle(),
          supabase.from('podcasts').select('id').eq('spotify_url', checkUrl).maybeSingle(),
        ]);
        const existingPod = byWebsite.data || byApple.data || bySpotify.data;
        if (existingPod) {
          const { data: existingMatch } = await supabase
            .from('podcast_matches')
            .select('id')
            .eq('client_id', resolvedClientId)
            .eq('podcast_id', existingPod.id)
            .maybeSingle();
          if (existingMatch) {
            return res.json({ success: true, message: 'Already in your pipeline.', matchId: existingMatch.id });
          }
        }
      }
    }

    // ── 1. iTunes lookup: get real metadata if Apple URL or name provided ─────
    const itunesData = await lookupItunes({ appleUrl, podcastName });

    // Detect link-in-bio URLs (Linktree etc.) — don't use as the main website
    const isLinkInBio = podcastUrl && /linktr\.ee|linktree\.com|bio\.link|beacons\.ai|campsite\.bio|later\.com\/linkinbio/i.test(podcastUrl);

    const base = {
      external_id:       `manual_${Date.now()}`,
      title:             itunesData.title             || podcastName || podcastUrl || 'Unknown Podcast',
      website:           isLinkInBio ? null : (podcastUrl || null),  // Linktree → set null, enrich will try RSS website
      // linkinbio_url not in schema — handled via website=null when isLinkInBio
      source:            'manual',
      host_name:         itunesData.host_name          || null,
      contact_email:     contactEmail                  || null,
      instagram_url:     instagramUrl                  || null,
      linkedin_url:      linkedinUrl                   || null,
      facebook_url:      facebookUrl                   || null,
      spotify_url:       spotifyUrl                    || null,
      apple_url:         itunesData.apple_url          || appleUrl || null,
      description:       itunesData.description        || null,
      total_episodes:    itunesData.total_episodes      || null,
      last_episode_date: itunesData.last_episode_date  || null,
      rss_feed_url:      itunesData.rss_feed_url        || null,
      category:          itunesData.category            || null,
      country:           itunesData.country             || null,
      listen_score:      null,
      language:          'English',
    };

    logger.info('Manual podcast base built', {
      title: base.title,
      hasItunes: !!itunesData.rss_feed_url,
      isLinkInBio,
    });

    // ── 2. Enrich (scrapes RSS + website) ────────────────────────────────────
    const enriched = await enrichPodcast(base);

    // ── 3. Upsert podcast ─────────────────────────────────────────────────────
    const { data: podcast, error: podcastError } = await supabase
      .from('podcasts')
      .upsert(enriched, { onConflict: 'external_id' })
      .select()
      .single();

    if (podcastError) throw podcastError;

    // ── 4. Duplicate check ────────────────────────────────────────────────────
    const { data: existing } = await supabase
      .from('podcast_matches')
      .select('id')
      .eq('client_id', resolvedClientId)
      .eq('podcast_id', podcast.id)
      .maybeSingle();

    if (existing) {
      return res.json({ success: true, message: 'Already in your pipeline.', matchId: existing.id });
    }

    // ── 5. Create match ───────────────────────────────────────────────────────
    const { data: match, error: matchError } = await supabase
      .from('podcast_matches')
      .insert({
        client_id:   resolvedClientId,
        podcast_id:  podcast.id,
        status:      'new',
        fit_score:   0,
        pitch_notes: notes || null,
      })
      .select()
      .single();

    if (matchError) throw matchError;

    // ── 6. Score in background ────────────────────────────────────────────────
    const { data: client } = await supabase.from('clients').select('*').eq('id', resolvedClientId).single();

    if (client) {
      scorePodcast(podcast, client)
        .then((scored) => {
          if (scored) {
            const { fit_score, relevance_score, audience_score, recency_score, guest_quality_score, reach_score, contactability_score, brand_score, show_summary, why_this_client_fits, best_pitch_angle, episode_to_reference, red_flags, booking_likelihood } = scored;
            supabase.from('podcast_matches').update({ fit_score, relevance_score, audience_score, recency_score, guest_quality_score, reach_score, contactability_score, brand_score, show_summary, why_this_client_fits, best_pitch_angle, episode_to_reference, red_flags, booking_likelihood }).eq('id', match.id)
              .then(() => logger.info('Manual podcast scored', { matchId: match.id, fit_score: scored.fit_score }));
          }
        })
        .catch((err) => logger.warn('Manual podcast scoring failed', { error: err.message }));
    }

    logger.info('Manual podcast added', { resolvedClientId, podcastId: podcast.id, title: enriched.title });
    return res.json({ success: true, match, podcast });
  } catch (err) {
    logger.error('Manual podcast add failed', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/re-enrich/:matchId ──────────────────────────────────────────────
// Re-fetches iTunes + RSS data for a podcast and re-scores against the client profile.
// Called automatically when a card with neutral 50/50/50 scores is expanded.
const requireDashboardToken = require('../middleware/requireDashboardToken');

router.post('/re-enrich/:matchId', requireDashboardToken, async (req, res) => {
  const { matchId } = req.params;
  if (!matchId) return res.status(400).json({ success: false, error: 'matchId required.' });

  try {
    // Fetch match + podcast + client
    const { data: match, error: matchErr } = await supabase
      .from('podcast_matches')
      .select('id, podcast_id, client_id, podcasts(*), clients(*)')
      .eq('id', matchId)
      .eq('client_id', req.clientId)
      .single();

    if (matchErr || !match) return res.status(404).json({ success: false, error: 'Match not found.' });

    const podcast = match.podcasts;
    const client  = match.clients;

    // Re-run iTunes lookup using whatever identifiers we have
    const itunesData = await lookupItunes({
      appleUrl:    podcast.apple_url    || null,
      podcastName: podcast.title        || null,
    });

    // Merge fresh iTunes data into the existing podcast object (don't overwrite manual contact info)
    const refreshed = {
      ...podcast,
      title:             itunesData.title             || podcast.title,
      host_name:         itunesData.host_name          || podcast.host_name,
      description:       itunesData.description        || podcast.description,
      total_episodes:    itunesData.total_episodes      || podcast.total_episodes,
      last_episode_date: itunesData.last_episode_date  || podcast.last_episode_date,
      rss_feed_url:      itunesData.rss_feed_url        || podcast.rss_feed_url,
      category:          itunesData.category            || podcast.category,
      country:           itunesData.country             || podcast.country,
    };

    // Re-enrich via RSS + website scrape
    const enriched = await enrichPodcast(refreshed);

    // Save refreshed podcast data (only known schema columns — enriched may contain internal fields)
    const podcastUpdate = {
      title: enriched.title || podcast.title,
      host_name: enriched.host_name || podcast.host_name,
      description: enriched.description || podcast.description,
      website: enriched.website || podcast.website,
      contact_email: enriched.contact_email || podcast.contact_email,
      contact_form_url: enriched.contact_form_url || podcast.contact_form_url,
      apple_url: enriched.apple_url || podcast.apple_url,
      spotify_url: enriched.spotify_url || podcast.spotify_url,
      youtube_url: enriched.youtube_url || podcast.youtube_url,
      instagram_url: enriched.instagram_url || podcast.instagram_url,
      instagram_followers: enriched.instagram_followers || podcast.instagram_followers,
      linkedin_url: enriched.linkedin_url || podcast.linkedin_url,
      category: enriched.category || podcast.category,
      total_episodes: enriched.total_episodes || podcast.total_episodes,
      last_episode_date: enriched.last_episode_date || podcast.last_episode_date,
      has_guest_history: enriched.has_guest_history ?? podcast.has_guest_history,
      booking_page_url: enriched.booking_page_url || podcast.booking_page_url,
      enriched_at: new Date().toISOString(),
    };
    await supabase.from('podcasts').update(podcastUpdate).eq('id', podcast.id);

    // Re-score with fresh data
    const scored = await scorePodcast(enriched, client);

    if (scored) {
      await supabase.from('podcast_matches').update(scored).eq('id', matchId);
      logger.info('Re-enrich + re-score complete', { matchId, fit_score: scored.fit_score });
      return res.json({ success: true, scores: scored, podcast: enriched });
    }

    return res.json({ success: true, scores: null, podcast: enriched });
  } catch (err) {
    logger.error('re-enrich error', { matchId, error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
