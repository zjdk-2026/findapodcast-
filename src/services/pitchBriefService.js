'use strict';

/**
 * Pitch Brief Service
 *
 * Generates a per-(podcast, client) AI brief that helps the customer pitch
 * the show with the right angle. Pulls:
 *   - Last 5-10 episodes from RSS feed (titles + descriptions)
 *   - Show metadata from iTunes Search API (categories, country, ratings)
 *   - Client profile (story arc, contrarian belief, origin story, ICP, offer, credential)
 * Calls Claude with structured output. Returns a brief JSON shaped per the spec.
 */

const { getClient } = require('../lib/anthropic');
const logger = require('../lib/logger');

const MODEL = 'claude-sonnet-4-6';

// ── RSS parser (extended from emailWriter.fetchRecentEpisodeTitles) ────────
async function fetchRecentEpisodes(rssUrl, max = 8) {
  if (!rssUrl) return [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(rssUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FindAPodcastBot/1.0)' },
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const xml = await res.text();
    const episodes = [];
    const itemRegex = /<item[\s\S]*?<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && episodes.length < max) {
      const itemXml = match[0];
      const title = unwrap(itemXml, /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
      const desc  = unwrap(itemXml, /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
      const pubDate = unwrap(itemXml, /<pubDate>([\s\S]*?)<\/pubDate>/i);
      if (title) {
        episodes.push({
          title: clean(title),
          description: clean(stripHtml(desc || '')).slice(0, 600),
          pub_date: pubDate || null,
        });
      }
    }
    return episodes;
  } catch (err) {
    logger.warn('pitchBrief: RSS fetch failed', { rssUrl, error: err.message });
    return [];
  }
}

function unwrap(xml, re) {
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}
function clean(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#8217;/g, "'").replace(/&#8211;/g, '-')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
function stripHtml(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

// ── iTunes lookup ──────────────────────────────────────────────────────────
async function fetchItunesMetadata(itunesId) {
  if (!itunesId) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`https://itunes.apple.com/lookup?id=${itunesId}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const item = data?.results?.[0];
    if (!item) return null;
    return {
      collection_name: item.collectionName || null,
      artist_name:     item.artistName || null,
      genre:           item.primaryGenreName || null,
      genres:          item.genres || [],
      track_count:     item.trackCount || null,
      country:         item.country || null,
      explicit:        item.collectionExplicitness || null,
      release_date:    item.releaseDate || null,
      feed_url:        item.feedUrl || null,
    };
  } catch (err) {
    logger.warn('pitchBrief: iTunes fetch failed', { itunesId, error: err.message });
    return null;
  }
}

// ── Profile completeness gate ──────────────────────────────────────────────
// Minimum to produce decent angles: ICP + at least one story field.
// `offer` is helpful but Claude can usually infer it from bio_long/speaking_angles,
// so we don't hard-block on it (was blocking every legacy customer where the
// onboarding form silently dropped offer before the DB column existed).
function hasAnglePoweringProfile(client) {
  const hasICP = !!(client.target_audience && client.target_audience.trim());
  const hasAnyStory = !!(
    (client.contrarian_belief && client.contrarian_belief.trim()) ||
    (client.origin_story      && client.origin_story.trim())      ||
    (client.bio_long          && client.bio_long.trim())          ||
    (Array.isArray(client.speaking_angles) && client.speaking_angles.length > 0)
  );
  return hasICP && hasAnyStory;
}

function profileGapMessage(client) {
  const missing = [];
  if (!(client.target_audience && client.target_audience.trim())) missing.push('your target audience');
  const noStory = !(
    (client.contrarian_belief && client.contrarian_belief.trim()) ||
    (client.origin_story      && client.origin_story.trim())      ||
    (client.bio_long          && client.bio_long.trim())          ||
    (Array.isArray(client.speaking_angles) && client.speaking_angles.length > 0)
  );
  if (noStory) missing.push('at least one of: contrarian belief, origin story, talking points, or full bio');
  return `Complete your profile to unlock pitch briefs. Add: ${missing.join('; ')}.`;
}

// ── The big one: build the brief ───────────────────────────────────────────
async function generateBrief({ podcast, client }) {
  if (!hasAnglePoweringProfile(client)) {
    return { ok: false, error: 'profile_incomplete', message: profileGapMessage(client) };
  }

  // Pull RSS + iTunes in parallel (both non-blocking)
  const [episodes, itunes] = await Promise.all([
    fetchRecentEpisodes(podcast.rss_feed_url, 8),
    fetchItunesMetadata(podcast.itunes_id),
  ]);

  const data_quality = (episodes.length >= 3 && itunes) ? 'full' : 'limited';

  const podcastInput = {
    title:                 podcast.title || null,
    host_name:             podcast.host_name || null,
    apple_description:     podcast.apple_description || null,
    description:           podcast.description || null,
    rss_feed_url:          podcast.rss_feed_url || null,
    apple_url:             podcast.apple_url || null,
    apple_rating:          podcast.apple_rating || null,
    apple_review_count:    podcast.apple_review_count || null,
    is_interview_format:   podcast.is_interview_format ?? null,
    episodes_last_30_days: podcast.episodes_last_30_days ?? null,
    category:              podcast.category || null,
    itunes_metadata:       itunes,
    recent_episodes:       episodes,
  };

  const clientInput = {
    name:               client.name || null,
    business_name:      client.business_name || null,
    title:              client.title || null,
    bio_short:          client.bio_short || null,
    bio_long:           client.bio_long || null,
    contrarian_belief:  client.contrarian_belief || null,
    origin_story:       client.origin_story || null,
    credential:         client.credential || null,
    speaking_angles:    client.speaking_angles || null,
    target_audience:    client.target_audience || null,
    offer:              client.offer || null,
    topics:             client.topics || null,
  };

  const systemPrompt = `You are a senior podcast booking strategist. You produce a "Pitch Brief" that helps a guest pitch ONE specific show effectively.

Return ONLY valid JSON matching this exact schema (no markdown, no commentary):
{
  "about_show": {
    "summary": "2-3 sentences on the show's positioning, tone, and what it's known for",
    "audience": "1-2 sentences inferring the audience (industry, role, mindset) from episodes and description",
    "format": "interview | solo | panel | co-hosted | mixed",
    "recent_themes": ["theme1", "theme2", "theme3"],
    "notable_past_guests": ["guest1", "guest2"] OR [] if unknown
  },
  "about_host": {
    "background": "1-2 sentences on what we know about the host based on the show description and episode titles",
    "communication_style": "warm | direct | contrarian | nerdy | playful | reverent | mixed",
    "values_in_guests": "1 sentence on what the host seems to prize in a guest (storytelling, data, vulnerability, authority, contrarian takes, etc.)",
    "recurring_themes": ["theme1", "theme2"]
  },
  "angles": [
    {
      "hook": "ONE specific angle written as a pitch hook (1 sentence, punchy, no filler)",
      "why_this_show": "ONE sentence on why this specific angle resonates with THIS show's audience and recent themes",
      "supporting_proof": "ONE sentence on which of the guest's stories, credentials, or frameworks to lead with"
    }
  ],
  "before_you_pitch": {
    "do_mention": "ONE specific rapport-builder (a recent episode, a host interest, a guest they had)",
    "dont_mention": "ONE specific thing this host likely doesn't want to hear (heavy self-promo, vague claims, etc.)",
    "red_flags": ["red flag 1 if any (e.g. low recency, weak audience match)"] OR []
  }
}

Rules:
- Generate EXACTLY 3 angles in the "angles" array.
- Each angle must be DIFFERENT in framing — don't make 3 variations of the same idea.
- Ground every claim in something from the recent_episodes or itunes_metadata. If you don't know, write null instead of inventing.
- Each angle MUST connect the guest's contrarian_belief, origin_story, or credential to a recent episode theme.
- Keep every sentence specific and pitch-ready. No "leverage your synergy" filler.
- "notable_past_guests" should only be populated if names appear in the recent_episodes data. Otherwise [].
- Hook should be 12-22 words max. Sound like a human, not a press release.`;

  const userMessage = JSON.stringify({ podcast: podcastInput, guest: clientInput });

  try {
    const message = await getClient().messages.create({
      model: MODEL,
      max_tokens: 1800,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const rawText = message.content?.[0]?.text || '';
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    let brief;
    try {
      brief = JSON.parse(cleaned);
    } catch (parseErr) {
      logger.error('pitchBrief: JSON parse failed', { rawText: rawText.slice(0, 500) });
      return { ok: false, error: 'parse_failed' };
    }

    return {
      ok: true,
      brief,
      episodes_analyzed_count: episodes.length,
      source_rss_url: podcast.rss_feed_url || null,
      data_quality,
    };
  } catch (err) {
    logger.error('pitchBrief: Claude call failed', { error: err.message });
    return { ok: false, error: 'claude_failed', message: err.message };
  }
}

module.exports = {
  generateBrief,
  hasAnglePoweringProfile,
  profileGapMessage,
};
