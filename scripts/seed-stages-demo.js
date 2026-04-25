'use strict';
/**
 * Seed 15 real-looking stage opportunities + match them to Zac's client record.
 * One-off demo seeding. Safe to re-run — uses upsert on external_id + unique constraint.
 *
 * Usage: node scripts/seed-stages-demo.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const ZAC_CLIENT_ID = 'ad53ebbc-5473-4116-a7f4-6e8147cdd4bf';

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const daysFromNow = (d) => new Date(Date.now() + d * 86400000).toISOString();
const dateFromNow = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const now = () => new Date().toISOString();

const stages = [
  {
    external_id: 'seed_saastr_2026', source: 'seed', name: 'SaaStr Annual 2026',
    url: 'https://www.saastr.com/events/saastr-annual/', cfp_url: 'https://sessionize.com/saastr-annual-2026', cfp_deadline: daysFromNow(18),
    event_start: dateFromNow(180), event_end: dateFromNow(182), timezone: 'America/Los_Angeles',
    location_city: 'San Francisco', location_country: 'USA', location_region: 'CA', is_virtual: false,
    organizer_name: 'SaaStr Inc.', organizer_url: 'https://www.saastr.com',
    description: "The world's largest community of SaaS founders and executives. 15,000+ attendees, 300+ speakers across 5 tracks on scaling B2B SaaS.",
    industry_tags: ['saas', 'b2b', 'entrepreneurship', 'growth'], estimated_attendees: 15000, payment_model: 'travel_covered',
    contact_confidence: 'high', contact_sources: { cfp_url: 'sessionize', url: 'website_link' }, contact_unlocked_at: now(),
  },
  {
    external_id: 'seed_eo_sydney', source: 'seed', name: 'EO Entrepreneur Summit Sydney',
    url: 'https://www.eonetwork.org/events/au-sydney-summit', cfp_url: 'https://www.eonetwork.org/sydney-cfp', cfp_deadline: daysFromNow(11),
    event_start: dateFromNow(85), event_end: dateFromNow(86), timezone: 'Australia/Sydney',
    location_city: 'Sydney', location_country: 'Australia', location_region: 'NSW', is_virtual: false,
    organizer_name: 'Entrepreneurs Organization Sydney', organizer_email: 'events@eosydney.org.au',
    description: "EO's flagship Australian summit. 250 six- and seven-figure business owners. Keynotes on mindset, scaling, and exit strategy.",
    industry_tags: ['entrepreneurship', 'mindset', 'leadership', 'scaling'], estimated_attendees: 250, payment_model: 'honorarium',
    contact_confidence: 'high', contact_sources: { organizer_email: 'website_link', url: 'website_link' }, contact_unlocked_at: now(),
  },
  {
    external_id: 'seed_afest_bali', source: 'seed', name: 'Mindvalley A-Fest 2026 — Bali',
    url: 'https://www.mindvalley.com/afest', cfp_url: 'https://www.mindvalley.com/afest/speakers', cfp_deadline: daysFromNow(42),
    event_start: dateFromNow(120), event_end: dateFromNow(124), timezone: 'Asia/Jakarta',
    location_city: 'Ubud', location_country: 'Indonesia', location_region: 'Bali', is_virtual: false, is_hybrid: true,
    organizer_name: 'Mindvalley', organizer_url: 'https://www.mindvalley.com',
    description: 'Transformational festival for entrepreneurs, thought leaders, and growth-focused humans. Premium speaker tier, full-immersion 5-day experience.',
    industry_tags: ['personal development', 'mindset', 'entrepreneurship', 'transformation'], estimated_attendees: 400, payment_model: 'premium',
    contact_confidence: 'high', contact_sources: { url: 'website_link' }, contact_unlocked_at: now(),
  },
  {
    external_id: 'seed_founders_live_melb', source: 'seed', name: 'Founders Live Melbourne',
    url: 'https://www.founderslive.com/melbourne', cfp_url: 'https://www.founderslive.com/melbourne/apply', cfp_deadline: daysFromNow(6),
    event_start: dateFromNow(21), event_end: dateFromNow(21), timezone: 'Australia/Melbourne',
    location_city: 'Melbourne', location_country: 'Australia', location_region: 'VIC', is_virtual: false,
    organizer_name: 'Founders Live Melbourne', organizer_email: 'melbourne@founderslive.com',
    description: 'Monthly pitch night for Melbourne founders. 7-min keynote slots between pitches. 150 attendees, mostly early-stage founders and angel investors.',
    industry_tags: ['startup', 'entrepreneurship', 'founders', 'local'], estimated_attendees: 150, payment_model: 'unpaid',
    contact_confidence: 'high', contact_sources: { organizer_email: 'website_link' }, contact_unlocked_at: now(),
  },
  {
    external_id: 'seed_podcast_movement', source: 'seed', name: 'Podcast Movement 2026',
    url: 'https://podcastmovement.com', cfp_url: 'https://podcastmovement.com/cfp', cfp_deadline: daysFromNow(28),
    event_start: dateFromNow(130), event_end: dateFromNow(133), timezone: 'America/Chicago',
    location_city: 'Dallas', location_country: 'USA', location_region: 'TX', is_virtual: false, is_hybrid: true,
    organizer_name: 'Podcast Movement', organizer_email: 'speakers@podcastmovement.com',
    description: "The world's largest podcasting conference. 3,500+ podcasters, networks, and media companies. 120+ speakers across 5 tracks.",
    industry_tags: ['podcasting', 'content', 'media', 'audio'], estimated_attendees: 3500, payment_model: 'travel_covered',
    contact_confidence: 'high', contact_sources: { organizer_email: 'website_link', cfp_url: 'website_link' }, contact_unlocked_at: now(),
  },
  {
    external_id: 'seed_startup_grind', source: 'seed', name: 'Startup Grind Global Conference',
    url: 'https://www.startupgrind.com/conference', cfp_url: 'https://sessionize.com/startup-grind-global', cfp_deadline: daysFromNow(54),
    event_start: dateFromNow(160), event_end: dateFromNow(162), timezone: 'America/Los_Angeles',
    location_city: 'Redwood City', location_country: 'USA', location_region: 'CA', is_virtual: false,
    organizer_name: 'Startup Grind', organizer_url: 'https://www.startupgrind.com',
    description: '10,000 founders, investors, and builders. 150+ speakers. Known for high-production keynote stages and founder fireside chats.',
    industry_tags: ['startup', 'entrepreneurship', 'tech', 'founders'], estimated_attendees: 10000, payment_model: 'travel_covered',
    contact_confidence: 'high', contact_sources: { cfp_url: 'sessionize' }, contact_unlocked_at: now(),
  },
  {
    external_id: 'seed_breakthrough_virtual', source: 'seed', name: 'Breakthrough Nation Virtual Summit 2026',
    url: 'https://breakthroughnation.com/summit', cfp_url: 'https://breakthroughnation.com/summit/speak', cfp_deadline: daysFromNow(13),
    event_start: dateFromNow(60), event_end: dateFromNow(62), timezone: 'UTC',
    is_virtual: true, location_country: 'Global',
    organizer_name: 'Breakthrough Nation', organizer_email: 'speak@breakthroughnation.com',
    description: '3-day virtual summit on transformation, business breakthrough, and personal evolution. 40,000+ registered attendees. Mindset-heavy audience.',
    industry_tags: ['mindset', 'breakthrough', 'transformation', 'business'], estimated_attendees: 40000, payment_model: 'paid',
    contact_confidence: 'high', contact_sources: { organizer_email: 'website_link' }, contact_unlocked_at: now(),
  },
  {
    external_id: 'seed_10x_conf', source: 'seed', name: '10X Growth Conference 2026',
    url: 'https://10xgrowthcon.com', cfp_url: 'https://10xgrowthcon.com/speakers', cfp_deadline: daysFromNow(90),
    event_start: dateFromNow(220), event_end: dateFromNow(222), timezone: 'America/New_York',
    location_city: 'Miami', location_country: 'USA', location_region: 'FL', is_virtual: false,
    organizer_name: 'Grant Cardone Enterprises', organizer_url: 'https://10xgrowthcon.com',
    description: "Grant Cardone's flagship event. 35,000 entrepreneurs and sales-focused business owners. Premium speaker slot pays $10k-25k.",
    industry_tags: ['sales', 'growth', 'entrepreneurship', 'scaling'], estimated_attendees: 35000, payment_model: 'premium',
    contact_confidence: 'high', contact_sources: { url: 'website_link' }, contact_unlocked_at: now(),
  },
  {
    external_id: 'seed_speakerpreneur', source: 'seed', name: 'Speakerpreneur Summit — Virtual',
    url: 'https://speakerpreneur.com/summit', cfp_url: 'https://speakerpreneur.com/summit/apply', cfp_deadline: daysFromNow(9),
    event_start: dateFromNow(45), event_end: dateFromNow(47), timezone: 'UTC',
    is_virtual: true, location_country: 'Global',
    organizer_name: 'Speakerpreneur Media', organizer_email: 'apply@speakerpreneur.com',
    description: 'Summit for professional speakers looking to scale their paid gigs. 8,000+ speakers attending. Panel + keynote slots available.',
    industry_tags: ['speaking', 'professional development', 'business'], estimated_attendees: 8000, payment_model: 'honorarium',
    contact_confidence: 'high', contact_sources: { organizer_email: 'website_link' }, contact_unlocked_at: now(),
  },
  {
    external_id: 'seed_ausbiz_sydney', source: 'seed', name: 'AusBiz Show Live Sydney',
    url: 'https://ausbiz.com.au/live', cfp_url: 'https://ausbiz.com.au/live/guests', cfp_deadline: daysFromNow(4),
    event_start: dateFromNow(35), event_end: dateFromNow(35), timezone: 'Australia/Sydney',
    location_city: 'Sydney', location_country: 'Australia', location_region: 'NSW', is_virtual: false,
    organizer_name: 'AusBiz Media', organizer_email: 'bookings@ausbiz.com.au',
    description: 'Live recording of the AusBiz Show. 20-min interview slot. Broadcast to 80,000+ Australian business owners. Networking reception after.',
    industry_tags: ['business', 'australia', 'entrepreneurship', 'media'], estimated_attendees: 200, payment_model: 'unpaid',
    contact_confidence: 'high', contact_sources: { organizer_email: 'website_link' }, contact_unlocked_at: now(),
  },
  {
    external_id: 'seed_traffic_conversion', source: 'seed', name: 'Traffic & Conversion Summit 2026',
    url: 'https://trafficandconversionsummit.com', cfp_url: 'https://trafficandconversionsummit.com/speak', cfp_deadline: daysFromNow(46),
    event_start: dateFromNow(150), event_end: dateFromNow(152), timezone: 'America/Los_Angeles',
    location_city: 'San Diego', location_country: 'USA', location_region: 'CA', is_virtual: false,
    organizer_name: 'DigitalMarketer', organizer_url: 'https://www.digitalmarketer.com',
    description: 'The biggest digital marketing conference in the world. 4,000+ marketers and founders. Keynote stages pay $5k-15k plus travel.',
    industry_tags: ['marketing', 'digital marketing', 'conversion', 'entrepreneurship'], estimated_attendees: 4000, payment_model: 'paid',
    contact_confidence: 'high', contact_sources: { url: 'website_link' }, contact_unlocked_at: now(),
  },
  {
    external_id: 'seed_experts_academy', source: 'seed', name: 'Brendon Burchard Experts Academy Live',
    url: 'https://brendonburchard.com/experts-academy', cfp_url: 'https://brendonburchard.com/experts-academy/speak', cfp_deadline: daysFromNow(24),
    event_start: dateFromNow(110), event_end: dateFromNow(113), timezone: 'UTC',
    is_virtual: true, location_country: 'Global',
    organizer_name: 'High Performance Institute', organizer_url: 'https://brendonburchard.com',
    description: '4-day virtual intensive for coaches, consultants, and course creators. 12,000+ attendees. Guest expert slots for niche specialists.',
    industry_tags: ['coaching', 'consulting', 'course creators', 'personal development'], estimated_attendees: 12000, payment_model: 'paid',
    contact_confidence: 'high', contact_sources: { url: 'website_link' }, contact_unlocked_at: now(),
  },
  {
    external_id: 'seed_rotary_melbourne', source: 'seed', name: 'Rotary International Melbourne Luncheon',
    url: 'https://rotarymelbourne.org.au/events', cfp_url: 'https://rotarymelbourne.org.au/speakers', cfp_deadline: daysFromNow(2),
    event_start: dateFromNow(14), event_end: dateFromNow(14), timezone: 'Australia/Melbourne',
    location_city: 'Melbourne', location_country: 'Australia', location_region: 'VIC', is_virtual: false,
    organizer_name: 'Rotary Club of Melbourne', organizer_email: 'speakers@rotarymelbourne.org.au',
    description: 'Weekly Friday luncheon with 80 local business leaders. 30-min keynote slot. Great for warm referrals and local authority building.',
    industry_tags: ['local', 'business', 'leadership', 'networking'], estimated_attendees: 80, payment_model: 'unpaid',
    contact_confidence: 'high', contact_sources: { organizer_email: 'website_link' }, contact_unlocked_at: now(),
  },
  {
    external_id: 'seed_global_leadership', source: 'seed', name: 'Global Leadership Summit 2026',
    url: 'https://globalleadership.org/summit', cfp_url: 'https://globalleadership.org/summit/speakers', cfp_deadline: daysFromNow(72),
    event_start: dateFromNow(205), event_end: dateFromNow(206), timezone: 'UTC',
    is_virtual: true, is_hybrid: true, location_country: 'Global',
    organizer_name: 'Willow Creek Association', organizer_url: 'https://globalleadership.org',
    description: "World's largest leadership event — broadcast live to 600+ satellite locations across 135 countries. 500,000+ total attendees.",
    industry_tags: ['leadership', 'business', 'personal development'], estimated_attendees: 500000, payment_model: 'premium',
    contact_confidence: 'high', contact_sources: { url: 'website_link' }, contact_unlocked_at: now(),
  },
  {
    external_id: 'seed_podfest_mastermind', source: 'seed', name: 'Podfest Multimedia Expo',
    url: 'https://podfestexpo.com', cfp_url: 'https://podfestexpo.com/speak', cfp_deadline: daysFromNow(37),
    event_start: dateFromNow(145), event_end: dateFromNow(147), timezone: 'America/New_York',
    location_city: 'Orlando', location_country: 'USA', location_region: 'FL', is_virtual: false, is_hybrid: true,
    organizer_name: 'Podfest Multimedia', organizer_email: 'speakers@podfestexpo.com',
    description: 'Premier podcasting and multimedia expo. 2,500+ podcasters, content creators, and agencies. Deep-dive workshops + mainstage keynotes.',
    industry_tags: ['podcasting', 'content creation', 'media', 'audio'], estimated_attendees: 2500, payment_model: 'honorarium',
    contact_confidence: 'high', contact_sources: { organizer_email: 'website_link' }, contact_unlocked_at: now(),
  },
];

const whyFits = {
  'SaaStr Annual 2026': 'Your breakthrough moment framework resonates deeply with SaaS founders navigating the scaling inflection point between $1M and $10M ARR.',
  'EO Entrepreneur Summit Sydney': 'EO Sydney members are 6-7 figure business owners wrestling with breakthrough pivots — exactly your signature topic, in your home country.',
  'Mindvalley A-Fest 2026 — Bali': 'A-Fest attendees are transformation-hungry entrepreneurs. Your mindset + business breakthrough angle is a perfect thematic fit.',
  'Founders Live Melbourne': 'Hyper-local 15-min keynote slot in your home city. Great warm-up stage + instant referral network with Melbourne founders.',
  'Podcast Movement 2026': 'You run a podcast + built a podcast discovery platform — you ARE the case study. Your insights on podcast-as-growth-channel are uniquely credible.',
  'Startup Grind Global Conference': '10,000 founders wrestling with scaling decisions. Your breakthrough framework is high-signal to their #1 problem.',
  'Breakthrough Nation Virtual Summit 2026': 'The name literally matches your podcast. Their 40k-person audience is pre-sold on the breakthrough theme.',
  '10X Growth Conference 2026': "Cardone's audience loves breakthrough stories. Premium paid slot — $10-25k speaker fees for niche experts.",
  'Speakerpreneur Summit — Virtual': 'Speakers wanting to scale their paid gigs — your story of building a podcast → software → agency stack is the exact playbook they need.',
  'AusBiz Show Live Sydney': 'Direct broadcast to 80k Australian business owners. Hometown advantage, high-trust media.',
  'Traffic & Conversion Summit 2026': 'Marketers and founders at scale — your breakthrough-to-growth narrative ties directly to their conversion mindset.',
  'Brendon Burchard Experts Academy Live': '12k coaches/consultants/course creators — the segment most in need of your breakthrough framework AND your Find A Podcast software.',
  'Rotary International Melbourne Luncheon': '80 local Melbourne business leaders. Low-effort, high-referral keynote in your backyard — deadline in 2 days.',
  'Global Leadership Summit 2026': '500k broadcast audience across 135 countries. Aspirational tier — positions you as a global leadership voice.',
  'Podfest Multimedia Expo': '2,500 podcasters. Again, you ARE the case study — podcast guest turned software founder. Natural mainstage authority.',
};

(async () => {
  const { data: inserted, error: e1 } = await s.from('stages')
    .upsert(stages, { onConflict: 'external_id' })
    .select('id,name,location_city,location_country,is_virtual,payment_model');

  if (e1) { console.error('insert stages failed:', e1.message); process.exit(1); }
  console.log('inserted', inserted.length, 'stages');

  const matches = inserted.map((stg) => {
    let distance;
    if (stg.is_virtual) distance = 95;
    else if (stg.location_city === 'Melbourne') distance = 95;
    else if (stg.location_city === 'Sydney') distance = 80;
    else if (stg.location_country === 'Australia') distance = 70;
    else distance = 30;

    const relevance = 70 + Math.floor(Math.random() * 28);
    const audience = 65 + Math.floor(Math.random() * 30);
    const recency = 80 + Math.floor(Math.random() * 15);
    const paymentBoost = { premium: 100, paid: 85, honorarium: 70, travel_covered: 60, unpaid: 40, unknown: 50 }[stg.payment_model] || 50;
    const fit = Math.round((relevance * 0.3) + (audience * 0.2) + (recency * 0.1) + (distance * 0.25) + (paymentBoost * 0.15));

    return {
      client_id: ZAC_CLIENT_ID,
      stage_id: stg.id,
      fit_score: fit,
      relevance_score: relevance,
      audience_score: audience,
      recency_score: recency,
      distance_score: distance,
      payment_score: paymentBoost,
      why_this_client_fits: whyFits[stg.name] || 'High alignment with your audience, topics, and business stage.',
      status: 'new',
    };
  });

  const { data: ins2, error: e2 } = await s.from('stage_matches')
    .upsert(matches, { onConflict: 'client_id,stage_id' })
    .select('id');

  if (e2) { console.error('insert matches failed:', e2.message); process.exit(1); }
  console.log('inserted', ins2.length, 'stage_matches for Zac');
  console.log('');
  console.log('🎤 Preview URL: https://findapodcast.io/stages/c1e62c5c-c2a4-4cca-9411-66f0571e704a');
})();
