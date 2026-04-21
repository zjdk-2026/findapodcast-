'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Contact-Likelihood Badge — computed cheaply from signals we already have.
// Shown on the card BEFORE the customer clicks Unlock, so "no contact found"
// feels like expected outcome rather than failure.
//
// Rules (per findapodcast-zero-hallucination skill):
//   🟢 high   — RSS has itunes:owner email OR any atom:link social present
//              OR Apple page declared JSON-LD url OR website detected with
//              declared contacts elsewhere
//   🟡 medium — website detected but no declared owner/social signals yet
//   🔴 low    — corporate network show, no website, no RSS owner data
//   ⚪ none   — nothing at all (shouldn't normally reach the dashboard)
// ═══════════════════════════════════════════════════════════════════════════

const CORPORATE_NETWORK_MARKERS = [
  'wondery', 'iheartpodcasts', 'iheart', 'npr', 'pbs', 'bbc',
  'gimlet', 'pushkin industries', 'pineapple street',
  'stitcher', 'cumulus podcast network',
];

function isCorporateNetwork(podcast) {
  const haystack = [
    podcast?.publisher, podcast?.network, podcast?.title, podcast?.host_name,
  ].filter(Boolean).join(' ').toLowerCase();
  return CORPORATE_NETWORK_MARKERS.some((m) => haystack.includes(m));
}

/**
 * Compute the pre-unlock confidence signal for a podcast.
 * Pure function — no DB writes, no network calls.
 */
function computeContactLikelihood(podcast) {
  if (!podcast) return 'none';

  const hasOwnerSignal =
    !!podcast.contact_email ||
    !!podcast.instagram_url ||
    !!podcast.twitter_url ||
    !!podcast.facebook_url ||
    !!podcast.linkedin_page_url ||
    !!podcast.youtube_url;

  if (hasOwnerSignal) return 'high';

  const hasWebsite = !!podcast.website;
  const corporate = isCorporateNetwork(podcast);

  if (corporate && !hasWebsite) return 'low';
  if (hasWebsite) return 'medium';
  return 'low';
}

/**
 * Build the fallback tips shown when a strict unlock returns nothing verifiable.
 * Uses the info we DO have to give the customer next actions — never hallucinates.
 */
function buildFallbackTips(podcast) {
  const tips = [];
  const host = (podcast?.host_name || '').trim();
  const title = (podcast?.title || '').trim();

  if (host) {
    const igQuery = encodeURIComponent(host);
    tips.push({
      label: `DM ${host} on Instagram`,
      url: `https://www.instagram.com/explore/search/keyword/?q=${igQuery}`,
      reason: 'Hosts often reply to DMs from people who leave genuine comments first',
    });

    const liQuery = encodeURIComponent(`${host}${title ? ' ' + title : ''}`);
    tips.push({
      label: `Find ${host} on LinkedIn`,
      url: `https://www.linkedin.com/search/results/people/?keywords=${liQuery}`,
      reason: 'LinkedIn connection requests with a short note about the show often land',
    });
  }

  if (title) {
    const gQuery = encodeURIComponent(`"${title}"${host ? ' "' + host + '"' : ''} contact email`);
    tips.push({
      label: 'Search Google',
      url: `https://www.google.com/search?q=${gQuery}`,
      reason: 'The show may list contact info on a page we haven\'t indexed yet',
    });
  }

  if (podcast?.website) {
    tips.push({
      label: 'Visit the show website',
      url: podcast.website,
      reason: 'Some shows only list contact on specific pages like /pitch or /guests',
    });
  }

  return tips;
}

module.exports = {
  computeContactLikelihood,
  buildFallbackTips,
  isCorporateNetwork,
};
