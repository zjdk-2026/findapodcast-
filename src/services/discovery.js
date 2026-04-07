'use strict';

const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const listennotes = require('../lib/listennotes');
const supabase = require('../lib/supabase');
const logger = require('../lib/logger');
const { getClient: getAnthropicClient } = require('../lib/anthropic');

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
 * Use Claude to generate 5 niche podcast search query variations from the client's profile.
 * Returns an array of search strings to pass to ListenNotes/iTunes/etc.
 */
async function generateNicheQueries(client, runNumber = 1) {
  try {
    const anthropic = getAnthropicClient();
    const primaryTopic = client.topics?.[0] || 'business';
    const audience = client.target_audience || '';
    const angles = (client.speaking_angles || []).slice(0, 3).join(', ');
    const allTopics = (client.topics || []).join(', ');

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Generate exactly 5 specific podcast search queries for finding interview shows that would book this guest. This is search run #${runNumber} — generate DIFFERENT queries than previous runs by exploring different sub-angles, adjacent niches, or alternative framings.

Guest topics: ${allTopics}
Target audience: ${audience}
Talking points: ${angles}

Rules:
- Each query should be 3–6 words
- Target niche sub-angles, not broad categories
- Vary the angle based on run number ${runNumber} (higher = more niche/adjacent)
- Do NOT include the word "podcast" (it will be appended)
- Return ONLY a JSON array of 5 strings, nothing else

Example output: ["faith-based entrepreneur interview","Christian business leadership","leadership legacy building","faith driven founder stories","entrepreneurship spiritual mindset"]`,
      }],
    });

    const text = msg.content[0]?.text?.trim() || '[]';
    const parsed = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, 5).map(q => `${q} podcast`) : [];
  } catch (err) {
    logger.warn('Niche query generation failed — using topic fallback queries', { error: err.message });
    // Build fallback queries from client topics so discovery still runs even when AI is unavailable
    const t = client.topics || ['business'];
    const a = client.speaking_angles?.[0] || t[0];
    const aud = client.target_audience || 'entrepreneurs';
    const angle = runNumber % 2 === 0 ? 'mindset' : 'strategy';
    return [
      `${t[0]} podcast interview`,
      `${t[1] || t[0]} guest expert podcast`,
      `${aud} success podcast`,
      `${a} podcast`,
      `${t[0]} ${angle} podcast`,
    ].map(q => `${q}`);
  }
}

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
    apple_url:               item.itunes_id ? `https://podcasts.apple.com/podcast/id${item.itunes_id}` : null,
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
    rss_feed_url:            item.rss || item.feed_url || null,
    phone_number:            null,
    source:                  'listennotes',
  };
}

async function searchItunes(query, language) {
  try {
    const term = encodeURIComponent(query);
    const lang = language === 'English' ? 'en_us' : 'en_us';
    const url = `https://itunes.apple.com/search?term=${term}&media=podcast&entity=podcast&limit=25&lang=${lang}`;
    const res = await axios.get(url, { timeout: 8000 });
    return res.data?.results || [];
  } catch (err) {
    logger.warn('iTunes search failed', { query, error: err.message });
    return [];
  }
}

function normaliseItunes(item) {
  return {
    external_id: `itunes_${item.collectionId}`,
    title: item.collectionName || item.trackName || 'Untitled',
    host_name: item.artistName || null,
    description: item.description || null,
    website: item.collectionViewUrl || null,
    apple_url: item.collectionViewUrl || null,
    spotify_url: null,
    youtube_url: null,
    category: item.primaryGenreName || null,
    niche_tags: item.genres || [],
    total_episodes: item.trackCount ?? null,
    last_episode_date: item.releaseDate ? item.releaseDate.slice(0, 10) : null,
    country: item.country || null,
    language: 'English',
    listen_score: null,
    image: item.artworkUrl600 || item.artworkUrl100 || null,
    thumbnail: item.artworkUrl100 || null,
    listennotes_url: null,
    rss_feed_url: item.feedUrl || null,
    phone_number: null,
    source: 'itunes',
  };
}

async function searchPodcastIndex(query) {
  const apiKey = process.env.PODCAST_INDEX_API_KEY;
  const apiSecret = process.env.PODCAST_INDEX_API_SECRET;
  if (!apiKey || !apiSecret) {
    logger.warn('Podcast Index not configured — skipping');
    return [];
  }
  try {
    const epoch = Math.floor(Date.now() / 1000);
    const hash = crypto.createHash('sha1').update(apiKey + apiSecret + epoch).digest('hex');
    const url = `https://api.podcastindex.org/api/1.0/search/byterm?q=${encodeURIComponent(query)}&max=25&clean`;
    const res = await axios.get(url, {
      headers: {
        'X-Auth-Date': epoch.toString(),
        'X-Auth-Key': apiKey,
        'Authorization': hash,
        'User-Agent': 'FindAPodcast/1.0',
      },
      timeout: 8000,
    });
    return res.data?.feeds || [];
  } catch (err) {
    logger.warn('Podcast Index search failed', { query, error: err.message });
    return [];
  }
}

function normalisePodcastIndex(item) {
  return {
    external_id: `podcastindex_${item.id}`,
    title: item.title || 'Untitled',
    host_name: item.author || item.ownerName || null,
    description: item.description || null,
    website: item.link || null,
    apple_url: item.itunesId ? `https://podcasts.apple.com/podcast/id${item.itunesId}` : null,
    spotify_url: null,
    youtube_url: null,
    category: item.categories ? Object.values(item.categories)[0] : null,
    niche_tags: item.categories ? Object.values(item.categories) : [],
    total_episodes: item.episodeCount ?? null,
    last_episode_date: item.lastUpdateTime ? new Date(item.lastUpdateTime * 1000).toISOString().slice(0, 10) : null,
    country: null,
    language: item.language || 'English',
    listen_score: null,
    image: item.artwork || item.image || null,
    thumbnail: item.image || null,
    listennotes_url: null,
    rss_feed_url:    item.url || null,
    phone_number:    null,
    source:          'podcastindex',
  };
}

async function searchYouTubePodcasts(topic, apiKey) {
  if (!apiKey) return [];
  try {
    const query = encodeURIComponent(`${topic} podcast interview`);
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${query}&type=channel&maxResults=15&key=${apiKey}`;
    const res = await axios.get(url, { timeout: 8000 });
    return res.data?.items || [];
  } catch (err) {
    logger.warn('YouTube podcast search failed', { topic, error: err.message });
    return [];
  }
}

function normaliseYouTube(item, channelDetails) {
  const channelId = item.id?.channelId || item.snippet?.channelId;
  const details   = channelDetails || {};
  const stats     = details.statistics || {};
  const brandSettings = details.brandingSettings?.channel || {};
  // Extract email from description if present
  const desc = details.snippet?.description || item.snippet?.description || '';
  const emailMatch = desc.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  const contactEmail = emailMatch ? emailMatch[0] : null;
  // Custom URL (e.g. youtube.com/@channelname)
  const customUrl = details.snippet?.customUrl
    ? `https://www.youtube.com/${details.snippet.customUrl}`
    : channelId ? `https://www.youtube.com/channel/${channelId}` : null;
  return {
    external_id: `youtube_${channelId}`,
    title: item.snippet?.title || details.snippet?.title || 'Untitled',
    host_name: item.snippet?.channelTitle || details.snippet?.title || null,
    description: desc || null,
    website: brandSettings.unsubscribedTrailer ? null : (details.snippet?.country ? customUrl : customUrl),
    apple_url: null,
    spotify_url: null,
    youtube_url: customUrl,
    category: brandSettings.keywords || null,
    niche_tags: [],
    total_episodes: stats.videoCount ? parseInt(stats.videoCount, 10) : null,
    last_episode_date: item.snippet?.publishedAt ? item.snippet.publishedAt.slice(0, 10) : null,
    country: details.snippet?.country || null,
    language: 'English',
    listen_score: stats.subscriberCount ? Math.min(99, Math.floor(Math.log10(parseInt(stats.subscriberCount, 10) + 1) * 20)) : null,
    image: details.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.high?.url || null,
    thumbnail: item.snippet?.thumbnails?.default?.url || null,
    listennotes_url: null,
    phone_number: null,
    contact_email: contactEmail,
    source: 'youtube',
  };
}

async function fetchYouTubeChannelDetails(channelId, apiKey) {
  try {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,brandingSettings&id=${channelId}&key=${apiKey}`;
    const res = await axios.get(url, { timeout: 8000 });
    return res.data?.items?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * Scrape Podmatch public directory for a given topic.
 * Returns normalised podcast objects with source: 'podmatch'.
 */
async function scrapePodmatch(topics) {
  const results = [];
  const topicsToSearch = (topics || []).slice(0, 2);

  for (const topic of topicsToSearch) {
    try {
      const url = `https://www.podmatch.com/podcasts?search=${encodeURIComponent(topic)}`;
      const res = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      });
      const $ = cheerio.load(res.data);

      // Podmatch podcast cards — extract what we can
      $('[class*="podcast"], [class*="show"], [class*="card"]').each((_, el) => {
        const titleEl = $(el).find('h2, h3, h4, [class*="title"], [class*="name"]').first();
        const title = titleEl.text().trim();
        if (!title) return;

        const hostEl = $(el).find('[class*="host"], [class*="author"]').first();
        const host_name = hostEl.text().trim() || null;

        const linkEl = $(el).find('a[href]').first();
        const href = linkEl.attr('href') || '';
        const website = href.startsWith('http') ? href : (href ? `https://www.podmatch.com${href}` : null);

        results.push({
          external_id:        `podmatch_${crypto.createHash('md5').update(title + (website || '')).digest('hex').slice(0, 12)}`,
          title,
          host_name,
          description:        null,
          website,
          apple_url:          null,
          spotify_url:        null,
          youtube_url:        null,
          category:           topic,
          niche_tags:         [topic],
          total_episodes:     null,
          last_episode_date:  null,
          country:            null,
          language:           'English',
          listen_score:       null,
          image:              null,
          thumbnail:          null,
          listennotes_url:    null,
          rss_feed_url:       null,
          phone_number:       null,
          has_guest_history:  true,
          source:             'podmatch',
        });
      });

      logger.debug('Podmatch scraped', { topic, found: results.length });
    } catch (err) {
      logger.warn('Podmatch scrape failed', { topic, error: err.message });
    }
  }

  return results;
}

async function searchTaddy(query, apiKey, userId) {
  if (!apiKey || !userId) return [];
  try {
    const gql = `{
      searchForTerm(term: "${query.replace(/"/g,'')}") {
        searchResults {
          ... on Podcast {
            uuid name description websiteUrl itunesId
            taddyUrl imageUrl seriesType
            episodes(page: 1, limitPerPage: 1) { datePublished }
          }
        }
      }
    }`;
    const res = await axios.post('https://api.taddy.org', { query: gql }, {
      headers: {
        'Content-Type': 'application/json',
        'X-USER-ID': userId,
        'X-API-KEY': apiKey,
      },
      timeout: 8000,
    });
    return res.data?.data?.searchForTerm?.searchResults || [];
  } catch (err) {
    logger.warn('Taddy search failed', { query, error: err.message });
    return [];
  }
}

function normaliseTaddy(item) {
  if (!item.name) return null;
  const itunesId = item.itunesId;
  return {
    external_id: `taddy_${item.uuid}`,
    title: item.name,
    host_name: null,
    description: item.description || null,
    website: item.websiteUrl || null,
    apple_url: itunesId ? `https://podcasts.apple.com/podcast/id${itunesId}` : null,
    spotify_url: null,
    youtube_url: null,
    rss_feed_url: null,
    category: null,
    niche_tags: [],
    total_episodes: null,
    last_episode_date: item.episodes?.[0]?.datePublished ? new Date(item.episodes[0].datePublished * 1000).toISOString().slice(0, 10) : null,
    country: null,
    language: 'English',
    listen_score: null,
    image: item.imageUrl || null,
    thumbnail: item.imageUrl || null,
    listennotes_url: null,
    phone_number: null,
    source: 'taddy',
  };
}

async function scrapeFeedspot(topics) {
  const results = [];
  // Map common topics to feedspot category slugs
  const topicMap = {
    'entrepreneurship': 'entrepreneurship', 'entrepreneur': 'entrepreneurship',
    'business': 'business', 'marketing': 'marketing', 'leadership': 'leadership',
    'technology': 'technology', 'health': 'health-wellness', 'faith': 'religion-spirituality',
    'christian': 'religion-spirituality', 'finance': 'personal-finance', 'investing': 'investing',
    'real estate': 'real-estate', 'mindset': 'self-improvement', 'personal development': 'self-improvement',
  };
  const slugs = new Set();
  for (const topic of (topics || []).slice(0, 3)) {
    const tl = topic.toLowerCase();
    for (const [key, slug] of Object.entries(topicMap)) {
      if (tl.includes(key)) slugs.add(slug);
    }
  }
  if (!slugs.size) slugs.add('business');

  for (const slug of [...slugs].slice(0, 2)) {
    try {
      const url = `https://podcast.feedspot.com/${slug}_podcasts/`;
      const res = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PodcastBot/1.0)' },
      });
      const $ = cheerio.load(res.data);
      $('.r-list-container .js-content-row, .feed-item, .col-item').each((_, el) => {
        const title = $(el).find('h2, h3, .title, .feed-title').first().text().trim();
        const website = $(el).find('a[href*="http"]:not([href*="feedspot"])').attr('href') || null;
        const image = $(el).find('img').attr('src') || null;
        const desc = $(el).find('p, .desc, .description').first().text().trim() || null;
        if (title) {
          results.push({
            external_id: `feedspot_${Buffer.from(title).toString('base64').slice(0, 20)}`,
            title, website, image, thumbnail: image, description: desc,
            host_name: null, apple_url: null, spotify_url: null, youtube_url: null,
            rss_feed_url: null, category: slug, niche_tags: [slug],
            total_episodes: null, last_episode_date: null, country: null,
            language: 'English', listen_score: null, listennotes_url: null,
            phone_number: null, source: 'feedspot',
          });
        }
      });
    } catch (err) {
      logger.warn('FeedSpot scrape failed', { slug, error: err.message });
    }
  }
  return results;
}

async function scrapeRadioGuestList() {
  try {
    const res = await axios.get('https://radioguestlist.com/podcast-radio-shows/', {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PodcastBot/1.0)' },
    });
    const $ = cheerio.load(res.data);
    const results = [];
    $('article, .show-item, .entry, .listing-item').each((_, el) => {
      const title = $(el).find('h2, h3, .title').first().text().trim();
      const website = $(el).find('a[href^="http"]').attr('href') || null;
      const desc = $(el).find('p').first().text().trim() || null;
      if (title && title.length > 3) {
        results.push({
          external_id: `rgl_${Buffer.from(title).toString('base64').slice(0, 20)}`,
          title, website, description: desc,
          host_name: null, apple_url: null, spotify_url: null, youtube_url: null,
          rss_feed_url: null, image: null, thumbnail: null, category: null,
          niche_tags: [], total_episodes: null, last_episode_date: null,
          country: null, language: 'English', listen_score: null,
          listennotes_url: null, phone_number: null,
          source: 'radioguestlist', has_guest_history: true,
        });
      }
    });
    return results;
  } catch (err) {
    logger.warn('RadioGuestList scrape failed', { error: err.message });
    return [];
  }
}

async function scrapeGoodpods(topics) {
  const topicMap = {
    'business': 'business', 'entrepreneur': 'business', 'entrepreneurship': 'business',
    'marketing': 'business', 'leadership': 'business',
    'christian': 'religion-spirituality', 'faith': 'religion-spirituality',
    'health': 'health-fitness', 'technology': 'technology', 'finance': 'investing',
    'personal development': 'self-improvement', 'mindset': 'self-improvement',
  };
  const cats = new Set(['business']);
  for (const topic of (topics || []).slice(0, 3)) {
    const tl = topic.toLowerCase();
    for (const [key, cat] of Object.entries(topicMap)) {
      if (tl.includes(key)) cats.add(cat);
    }
  }
  const results = [];
  for (const cat of [...cats].slice(0, 2)) {
    try {
      const url = `https://goodpods.com/podcasts-by-category-list/${cat}`;
      const res = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      const $ = cheerio.load(res.data);
      $('a[href*="/podcasts/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (!href.includes('/podcasts/') || href.split('/').length < 4) return;
        const title = $(el).find('h3, h2, .title, [class*="title"]').first().text().trim() ||
                      $(el).attr('aria-label') || '';
        const appleLink = $(el).find('a[href*="apple"]').attr('href') || null;
        if (title && title.length > 3) {
          results.push({
            external_id: `goodpods_${href.split('/podcasts/')[1]?.split('/')[0] || Buffer.from(title).toString('base64').slice(0, 15)}`,
            title, website: null, apple_url: appleLink,
            host_name: null, description: null, spotify_url: null, youtube_url: null,
            rss_feed_url: null, image: null, thumbnail: null, category: cat,
            niche_tags: [cat], total_episodes: null, last_episode_date: null,
            country: null, language: 'English', listen_score: null,
            listennotes_url: null, phone_number: null, source: 'goodpods',
          });
        }
      });
    } catch (err) {
      logger.warn('Goodpods scrape failed', { cat, error: err.message });
    }
  }
  return results;
}

async function getSpotifyToken() {
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await axios.post('https://accounts.spotify.com/api/token',
      'grant_type=client_credentials',
      { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
    );
    return res.data?.access_token || null;
  } catch (err) {
    logger.warn('Spotify token fetch failed', { error: err.message });
    return null;
  }
}

async function searchSpotifyPodcasts(query, token) {
  if (!token) return [];
  try {
    const q = encodeURIComponent(query);
    const res = await axios.get(`https://api.spotify.com/v1/search?q=${q}&type=show&market=US&limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
    });
    return res.data?.shows?.items || [];
  } catch (err) {
    logger.warn('Spotify search failed', { query, error: err.message });
    return [];
  }
}

function normaliseSpotify(item) {
  if (!item?.name) return null;
  return {
    external_id: `spotify_${item.id}`,
    title: item.name,
    host_name: item.publisher || null,
    description: item.description || null,
    website: item.external_urls?.spotify || null,
    spotify_url: item.external_urls?.spotify || null,
    apple_url: null,
    youtube_url: null,
    rss_feed_url: null,
    category: item.media_type || null,
    niche_tags: item.languages || [],
    total_episodes: item.total_episodes || null,
    last_episode_date: null,
    country: item.markets?.[0] || null,
    language: item.languages?.[0] || 'English',
    listen_score: null,
    image: item.images?.[0]?.url || null,
    thumbnail: item.images?.[2]?.url || item.images?.[0]?.url || null,
    listennotes_url: null,
    phone_number: null,
    source: 'spotify',
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

  if ((bookedThisMonth || 0) >= monthlyCap && !client.unlimited_pitching) {
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

  // Derive run number from existing match count (each run adds ~50 matches)
  // Must be defined BEFORE ninetyDaysAgo which references it
  const { count: existingMatchCount } = await supabase
    .from('podcast_matches')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', client.id);
  const runNumber = Math.max(1, Math.floor((existingMatchCount ?? 0) / 50) + 1);

  // Date filter: loosen on repeat runs to widen the candidate pool
  // Run 1: 180 days, Run 2: 365 days, Run 3+: no date filter (null = no filter)
  const ninetyDaysAgo = runNumber === 1
    ? Math.floor((Date.now() - 180 * 24 * 60 * 60 * 1000) / 1000)
    : runNumber === 2
      ? Math.floor((Date.now() - 365 * 24 * 60 * 60 * 1000) / 1000)
      : null;
  const language = client.languages?.[0] || 'English';
  // Paginate ListenNotes: fetch a fresh page per run so repeat runs get new inventory
  const lnPage = runNumber; // page 1 on first run, page 2 on second, etc.

  logger.info('Discovery run metadata', { clientId: client.id, runNumber, lnPage });

  for (const query of queries) {
    logger.debug('Running Listen Notes search', { query, page: lnPage });
    // Always fetch page 1 for fresh inventory, plus the run-specific page for pagination
    const pages = lnPage > 1 ? [1, lnPage] : [1];
    for (const page of pages) {
      const result = await listennotes.searchPodcasts(query, {
        type:           'podcast',
        language,
        len_min:        15,
        ...(ninetyDaysAgo ? { published_after: ninetyDaysAgo } : {}),
        sort_by_date:   0,
        safe_mode:      1,
        offset:         (page - 1) * 10,
      });
      const podcasts = result?.results || [];
      for (const item of podcasts) {
        if (item.id && !allCandidates.has(item.id)) {
          allCandidates.set(item.id, normalisePodcast(item));
        }
      }
    }
  }

  logger.info('Listen Notes search complete', { candidatesSoFar: allCandidates.size });

  // ─────────────────────────────────────────────────────────────
  // 1b. Claude-generated niche query expansion (5 variations)
  //     Run-number seeded so each run gets different angles
  // ─────────────────────────────────────────────────────────────
  const nicheQueries = await generateNicheQueries(client, runNumber);
  logger.info('Niche query expansion', { count: nicheQueries.length, queries: nicheQueries });

  for (const query of nicheQueries) {
    const result = await listennotes.searchPodcasts(query, {
      type: 'podcast',
      language,
      len_min: 15,
      ...(ninetyDaysAgo ? { published_after: ninetyDaysAgo } : {}),
      sort_by_date: 0,
      safe_mode: 1,
    });
    const podcasts = result?.results || [];
    for (const item of podcasts) {
      if (item.id && !allCandidates.has(item.id)) {
        allCandidates.set(item.id, normalisePodcast(item));
      }
    }
  }
  logger.info('Niche query search complete', { candidatesSoFar: allCandidates.size });

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
  // 2b. iTunes + Podcast Index + YouTube parallel searches
  // ─────────────────────────────────────────────────────────────
  const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
  const TADDY_API_KEY = process.env.TADDY_API_KEY;
  const TADDY_USER_ID = process.env.TADDY_USER_ID;

  // Get Spotify token before parallel block
  const spotifyToken = await getSpotifyToken();

  // Run top 3 topic queries across all sources in parallel
  const newSourceQueries = queries.slice(0, 3);
  const [itunesResults, podcastIndexResults, youtubeResults, taddyResults, feedspotResults, rglResults, goodpodsResults, spotifyPrimaryResults, spotifyAudienceResults] = await Promise.allSettled([
    Promise.all(newSourceQueries.map(q => searchItunes(q, language))),
    Promise.all(newSourceQueries.map(q => searchPodcastIndex(q))),
    Promise.all(client.topics?.slice(0, 2).map(t => searchYouTubePodcasts(t, GOOGLE_SEARCH_API_KEY)) || []),
    searchTaddy(primaryTopic, TADDY_API_KEY, TADDY_USER_ID),
    scrapeFeedspot(client.topics),
    scrapeRadioGuestList(),
    scrapeGoodpods(client.topics),
    searchSpotifyPodcasts(primaryTopic, spotifyToken),
    searchSpotifyPodcasts(audience, spotifyToken),
  ]);

  // Add iTunes results
  if (itunesResults.status === 'fulfilled') {
    for (const batch of itunesResults.value) {
      for (const item of batch) {
        const id = `itunes_${item.collectionId}`;
        if (item.collectionId && !allCandidates.has(id)) {
          allCandidates.set(id, normaliseItunes(item));
        }
      }
    }
  }

  // Add Podcast Index results
  if (podcastIndexResults.status === 'fulfilled') {
    for (const batch of podcastIndexResults.value) {
      for (const item of batch) {
        const id = `podcastindex_${item.id}`;
        if (item.id && !allCandidates.has(id)) {
          allCandidates.set(id, normalisePodcastIndex(item));
        }
      }
    }
  }

  // Add YouTube results — fetch channel details for richer data
  if (youtubeResults.status === 'fulfilled') {
    const ytItems = youtubeResults.value.flat().filter(item => item.id?.channelId);
    await Promise.all(ytItems.map(async (item) => {
      const channelId = item.id?.channelId;
      const id = `youtube_${channelId}`;
      if (channelId && !allCandidates.has(id)) {
        const details = await fetchYouTubeChannelDetails(channelId, GOOGLE_SEARCH_API_KEY);
        allCandidates.set(id, normaliseYouTube(item, details));
      }
    }));
  }

  // Add Taddy results
  if (taddyResults.status === 'fulfilled') {
    for (const item of taddyResults.value) {
      const normalised = normaliseTaddy(item);
      if (normalised && !allCandidates.has(normalised.external_id)) {
        allCandidates.set(normalised.external_id, normalised);
      }
    }
  }

  // Add FeedSpot results
  if (feedspotResults.status === 'fulfilled') {
    for (const pod of feedspotResults.value) {
      if (!allCandidates.has(pod.external_id)) {
        allCandidates.set(pod.external_id, pod);
      }
    }
  }

  // Add RadioGuestList results
  if (rglResults.status === 'fulfilled') {
    for (const pod of rglResults.value) {
      if (!allCandidates.has(pod.external_id)) {
        allCandidates.set(pod.external_id, pod);
      }
    }
  }

  // Add Goodpods results
  if (goodpodsResults.status === 'fulfilled') {
    for (const pod of goodpodsResults.value) {
      if (!allCandidates.has(pod.external_id)) {
        allCandidates.set(pod.external_id, pod);
      }
    }
  }

  // Add Spotify results
  for (const spotifyBatch of [spotifyPrimaryResults, spotifyAudienceResults]) {
    if (spotifyBatch.status === 'fulfilled') {
      for (const item of spotifyBatch.value) {
        const normalised = normaliseSpotify(item);
        if (normalised && !allCandidates.has(normalised.external_id)) {
          allCandidates.set(normalised.external_id, normalised);
        }
      }
    }
  }

  logger.info('Multi-source discovery complete', { candidatesSoFar: allCandidates.size });

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
  // 3b. Similar podcasts chaining — runs on all run types
  // ─────────────────────────────────────────────────────────────
  const top3 = Array.from(allCandidates.values())
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
  // 3c. Listen Notes /recommendations for top 5 by listen_score
  // ─────────────────────────────────────────────────────────────
  if (true) {
    const LISTENNOTES_API_KEY = process.env.LISTENNOTES_API_KEY;
    const top5ForRecs = Array.from(allCandidates.values())
      .filter((p) => p.listennotes_url && p.listen_score != null)
      .sort((a, b) => (b.listen_score || 0) - (a.listen_score || 0))
      .slice(0, 5);

    await Promise.all(top5ForRecs.map(async (pod) => {
      // Extract podcast ID from listennotes_url or external_id
      const podId = pod.external_id && !pod.external_id.startsWith('itunes_') && !pod.external_id.startsWith('podcastindex_') && !pod.external_id.startsWith('youtube_')
        ? pod.external_id
        : null;
      if (!podId || !LISTENNOTES_API_KEY) return;

      try {
        const recRes = await axios.get(
          `https://listen-api.listennotes.com/api/v2/podcasts/${podId}/recommendations`,
          {
            headers: { 'X-ListenAPI-Key': LISTENNOTES_API_KEY },
            timeout: 8000,
            params: { safe_mode: 1 },
          }
        );
        const recs = recRes.data?.recommendations || [];
        for (const item of recs.slice(0, 8)) {
          if (item.id && !allCandidates.has(item.id)) {
            allCandidates.set(item.id, normalisePodcast(item));
          }
        }
        logger.debug('LN recommendations fetched', { podId, count: recs.length });
      } catch (err) {
        logger.warn('LN recommendations failed', { podId, error: err.message });
      }
    }));

    logger.info('Listen Notes recommendations complete', { candidatesSoFar: allCandidates.size });
  }

  // ─────────────────────────────────────────────────────────────
  // 3d. Podmatch scraping
  // ─────────────────────────────────────────────────────────────
  const podmatchResults = await scrapePodmatch(client.topics);
  for (const pod of podmatchResults) {
    if (!allCandidates.has(pod.external_id)) {
      allCandidates.set(pod.external_id, pod);
    }
  }
  logger.info('Podmatch scraping complete', { candidatesSoFar: allCandidates.size });

  // ── Cross-source deduplication by title ──────────────────────────────
  // Merge shows that are the same podcast from different sources
  const titleMap = new Map(); // normalised title -> external_id of canonical entry
  for (const [extId, podcast] of allCandidates.entries()) {
    const normTitle = (podcast.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
    if (!normTitle) continue;
    if (titleMap.has(normTitle)) {
      // Merge: keep the richer record (the one with more data)
      const canonical = allCandidates.get(titleMap.get(normTitle));
      // Merge missing fields from duplicate into canonical
      for (const key of ['contact_email','website','rss_feed_url','host_name','description','image','listen_score','apple_url','spotify_url','youtube_url','instagram_url','twitter_url','facebook_url','linkedin_page_url']) {
        if (!canonical[key] && podcast[key]) canonical[key] = podcast[key];
      }
      // Keep higher listen_score source
      if ((podcast.listen_score || 0) > (canonical.listen_score || 0)) {
        canonical.listen_score = podcast.listen_score;
        canonical.external_id = podcast.external_id; // use the richer source's ID
      }
      allCandidates.delete(extId); // remove duplicate
    } else {
      titleMap.set(normTitle, extId);
    }
  }
  logger.info('After cross-source dedup', { candidates: allCandidates.size });

  // ─────────────────────────────────────────────────────────────
  // 4. Build already-matched set — two queries, no FK JOIN needed
  //    (Supabase relationship JOIN only works if FK is configured;
  //     two-query approach is always reliable)
  // ─────────────────────────────────────────────────────────────
  const { data: existingMatchRows, error: matchError } = await supabase
    .from('podcast_matches')
    .select('podcast_id')
    .eq('client_id', client.id);

  if (matchError) {
    logger.error('Failed to fetch existing matches', { clientId: client.id, error: matchError.message });
  }

  const matchedPodcastIds = (existingMatchRows || [])
    .map((m) => m.podcast_id)
    .filter(Boolean);

  let alreadyMatchedExternalIds = new Set();
  if (matchedPodcastIds.length > 0) {
    const { data: matchedPodcasts } = await supabase
      .from('podcasts')
      .select('external_id')
      .in('id', matchedPodcastIds);
    alreadyMatchedExternalIds = new Set(
      (matchedPodcasts || []).map((p) => p.external_id).filter(Boolean)
    );
  }

  logger.info('Existing matches loaded', { matchCount: matchedPodcastIds.length, externalIdCount: alreadyMatchedExternalIds.size });

  // ─────────────────────────────────────────────────────────────
  // 5. Filter pipeline
  // ─────────────────────────────────────────────────────────────
  // 5. Filter pipeline — strict pass first
  // ─────────────────────────────────────────────────────────────
  const now = Date.now();
  const maxAgeMs = (client.max_show_age_days || 180) * 24 * 60 * 60 * 1000;
  const minEps   = Math.max(client.min_show_episodes || 10, 10); // hard floor: 10 episodes minimum

  // Track what's in filtered for fast dedup in guardrail layers
  const filteredIds = new Set();

  const filtered = [];
  const backfillEpisode = []; // passes age filter, fails episode count
  const backfillAge     = []; // fails age filter

  for (const podcast of allCandidates.values()) {
    if (alreadyMatchedExternalIds.has(podcast.external_id)) continue;

    const lastEpMs = podcast.last_episode_date
      ? new Date(podcast.last_episode_date).getTime()
      : null;
    const tooOld = lastEpMs !== null && (now - lastEpMs > maxAgeMs);

    const eps = podcast.total_episodes;
    const meetsEpisodeMin = eps === null || eps >= minEps; // 10+ episodes
    const meetsLaxMin     = eps === null || eps >= 5;     // guardrail backfill only

    if (!tooOld && meetsEpisodeMin) {
      filtered.push(podcast);
      filteredIds.add(podcast.external_id);
    } else if (!tooOld && meetsLaxMin) {
      backfillEpisode.push(podcast);
    } else if (tooOld) {
      backfillAge.push(podcast);
    }

    if (filtered.length >= 50) break;
  }

  // ── Guardrail Layer 1: relax episode count (10+ → any) ──────
  if (filtered.length < 50) {
    for (const podcast of backfillEpisode) {
      if (filtered.length >= 50) break;
      filtered.push(podcast);
      filteredIds.add(podcast.external_id);
    }
    logger.info('Guardrail L1 (episode relax)', { total: filtered.length });
  }

  // ── Guardrail Layer 2: relax age filter (180d → 365d) ───────
  if (filtered.length < 50) {
    const relaxedAgeMs = 365 * 24 * 60 * 60 * 1000;
    for (const podcast of backfillAge) {
      if (filtered.length >= 50) break;
      if (filteredIds.has(podcast.external_id)) continue;
      const lastEpMs = podcast.last_episode_date
        ? new Date(podcast.last_episode_date).getTime()
        : null;
      if (lastEpMs !== null && (now - lastEpMs > relaxedAgeMs)) continue;
      filtered.push(podcast);
      filteredIds.add(podcast.external_id);
    }
    logger.info('Guardrail L2 (age relax 365d)', { total: filtered.length });
  }

  // ── Guardrail Layer 3: any age, any episode count ────────────
  if (filtered.length < 50) {
    for (const podcast of allCandidates.values()) {
      if (filtered.length >= 50) break;
      if (alreadyMatchedExternalIds.has(podcast.external_id)) continue;
      if (filteredIds.has(podcast.external_id)) continue;
      filtered.push(podcast);
      filteredIds.add(podcast.external_id);
    }
    logger.info('Guardrail L3 (no filters)', { total: filtered.length });
  }

  // ── Guardrail Layer 4: pull from global podcasts cache ───────
  // Podcasts discovered for ANY client, enriched, not yet seen by this client
  if (filtered.length < 50) {
    const needed = 50 - filtered.length;
    const clientTopics = (client.topics || []).map(t => t.toLowerCase());

    // No topic filter — fetch podcasts by listen_score and filter in JS.
    // Offset by run number so repeat runs get a fresh slice of the cache, not the same top podcasts.
    const cacheOffset = (runNumber - 1) * needed * 5;
    const { data: cachedPodcasts, error: cacheErr } = await supabase
      .from('podcasts')
      .select('*')
      .order('listen_score', { ascending: false, nullsFirst: false })
      .range(cacheOffset, cacheOffset + (needed * 10) - 1); // fetch 10x generously to account for already-matched

    if (cacheErr) {
      logger.warn('Cache pull failed', { error: cacheErr.message });
    } else {
      for (const pod of (cachedPodcasts || [])) {
        if (filtered.length >= 50) break;
        if (alreadyMatchedExternalIds.has(pod.external_id)) continue;
        if (filteredIds.has(pod.external_id)) continue;
        // Normalise cache record to match discovery shape
        filtered.push({
          external_id:      pod.external_id,
          title:            pod.title,
          host_name:        pod.host_name,
          description:      pod.description,
          website:          pod.website,
          contact_email:    pod.contact_email,
          listen_score:     pod.listen_score,
          total_episodes:   pod.total_episodes,
          last_episode_date: pod.last_episode_date,
          apple_url:        pod.apple_url,
          spotify_url:      pod.spotify_url,
          youtube_url:      pod.youtube_url,
          instagram_url:    pod.instagram_url,
          twitter_url:      pod.twitter_url,
          facebook_url:     pod.facebook_url,
          linkedin_page_url: pod.linkedin_url,
          image:            pod.image,
          _fromCache:       true,
        });
        filteredIds.add(pod.external_id);
      }
      logger.info('Guardrail L4 (global cache pull)', { total: filtered.length });
    }
  }

  // ── Guardrail Layer 5: extra LN pagination if still short ────
  if (filtered.length < 50) {
    const extraPage = runNumber + 2; // go further ahead in LN pagination
    const topQuery  = `${primaryTopic} podcast interview`;
    logger.info('Guardrail L5: extra LN pagination', { page: extraPage, query: topQuery });

    try {
      const extraResult = await listennotes.searchPodcasts(topQuery, {
        type:    'podcast',
        language,
        len_min: 5,
        safe_mode: 1,
        offset:  (extraPage - 1) * 10,
      });
      for (const item of (extraResult?.results || [])) {
        if (filtered.length >= 50) break;
        if (!item.id) continue;
        if (alreadyMatchedExternalIds.has(item.id)) continue;
        if (filteredIds.has(item.id)) continue;
        filtered.push(normalisePodcast(item));
        filteredIds.add(item.id);
      }
      logger.info('Guardrail L5 complete', { total: filtered.length });
    } catch (err) {
      logger.warn('Guardrail L5 LN pagination failed', { error: err.message });
    }
  }

  // ── Final guardrail log ───────────────────────────────────────
  if (filtered.length < 50) {
    logger.warn('GUARDRAIL: Could not reach 50 podcasts', {
      clientId: client.id,
      found: filtered.length,
      candidatesAvailable: allCandidates.size,
    });
  }

  // Sort: email first → listen_score descending → rest
  filtered.sort((a, b) => {
    const aHasEmail = (a.contact_email || a.email_contact) ? 1 : 0;
    const bHasEmail = (b.contact_email || b.email_contact) ? 1 : 0;
    if (bHasEmail !== aHasEmail) return bHasEmail - aHasEmail;
    return (b.listen_score || 0) - (a.listen_score || 0);
  });

  logger.info('Discovery complete', {
    clientId: client.id,
    totalCandidates: allCandidates.size,
    returning: filtered.length,
  });

  return filtered.slice(0, 50);
}

module.exports = { discoverPodcasts };
