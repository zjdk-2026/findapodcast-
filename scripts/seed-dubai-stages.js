'use strict';
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ZAC = 'ad53ebbc-5473-4116-a7f4-6e8147cdd4bf';
const day = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const ts  = (d) => new Date(Date.now() + d * 86400000).toISOString();
const now = () => new Date().toISOString();

const stages = [
  { external_id: 'seed_step_conf_dubai', source: 'seed', name: 'STEP Conference Dubai 2026', url: 'https://stepconference.com', cfp_url: 'https://stepconference.com/speakers-apply', cfp_deadline: ts(20), event_start: day(90), event_end: day(91), location_city: 'Dubai', location_country: 'UAE', is_virtual: false, organizer_name: 'STEP Conference', organizer_email: 'speakers@stepconference.com', description: "Middle East's largest tech conference. 8,000+ founders, investors, and creators. Known for bold, TED-style keynotes.", industry_tags: ['tech', 'startup', 'middle east', 'entrepreneurship'], estimated_attendees: 8000, payment_model: 'travel_covered', contact_confidence: 'high' },
  { external_id: 'seed_gitex_dubai', source: 'seed', name: 'GITEX Global 2026', url: 'https://www.gitex.com', cfp_url: 'https://www.gitex.com/speak', cfp_deadline: ts(35), event_start: day(170), event_end: day(174), location_city: 'Dubai', location_country: 'UAE', is_virtual: false, organizer_name: 'Dubai World Trade Centre', organizer_url: 'https://www.gitex.com', description: "World's largest tech exhibition. 170,000+ attendees, 6,000+ exhibitors, speakers across AI, Web3, cybersecurity, fintech.", industry_tags: ['tech', 'enterprise', 'ai', 'web3'], estimated_attendees: 170000, payment_model: 'premium', contact_confidence: 'high' },
  { external_id: 'seed_entrepreneur_dubai', source: 'seed', name: 'Entrepreneur Middle East Summit — Dubai', url: 'https://www.entrepreneur.com/middle-east/summit', cfp_url: 'https://www.entrepreneur.com/middle-east/summit/speak', cfp_deadline: ts(12), event_start: day(50), event_end: day(51), location_city: 'Dubai', location_country: 'UAE', is_virtual: false, organizer_name: 'Entrepreneur Middle East', organizer_email: 'events@entrepreneur.com', description: '400+ GCC founders and investors. Panel + keynote slots focused on scaling, funding, and building regional businesses.', industry_tags: ['entrepreneurship', 'middle east', 'scaling', 'funding'], estimated_attendees: 400, payment_model: 'honorarium', contact_confidence: 'high' },
  { external_id: 'seed_founders_meetup_dubai', source: 'seed', name: 'Founders Meetup Dubai', url: 'https://www.meetup.com/founders-dubai', cfp_url: 'https://www.meetup.com/founders-dubai/speakers', cfp_deadline: ts(4), event_start: day(14), event_end: day(14), location_city: 'Dubai', location_country: 'UAE', is_virtual: false, organizer_name: 'Founders Meetup Dubai', organizer_email: 'host@foundersmeetupdubai.com', description: 'Monthly networking evening at Dubai Internet City. 120 early-stage founders + operators. 15-min keynote slot per month.', industry_tags: ['networking', 'founders', 'local', 'dubai'], estimated_attendees: 120, payment_model: 'unpaid', contact_confidence: 'high' },
  { external_id: 'seed_dubai_chamber', source: 'seed', name: 'Dubai Chamber Business Breakfast', url: 'https://www.dubaichamber.com/events', cfp_url: 'https://www.dubaichamber.com/events/speakers', cfp_deadline: ts(7), event_start: day(21), event_end: day(21), location_city: 'Dubai', location_country: 'UAE', is_virtual: false, organizer_name: 'Dubai Chamber of Commerce', organizer_email: 'events@dubaichamber.com', description: 'Monthly breakfast for DMC members. 80 mid-market business owners. 20-min talk + Q&A. Warm, high-trust local audience.', industry_tags: ['business', 'local', 'networking', 'leadership'], estimated_attendees: 80, payment_model: 'unpaid', contact_confidence: 'high' },
  { external_id: 'seed_emerge_conf_dubai', source: 'seed', name: 'Emerge Conference — Abu Dhabi / Dubai', url: 'https://emergeconference.ae', cfp_url: 'https://emergeconference.ae/speakers', cfp_deadline: ts(45), event_start: day(140), event_end: day(141), location_city: 'Abu Dhabi', location_country: 'UAE', is_virtual: false, is_hybrid: true, organizer_name: 'Emerge Media', organizer_url: 'https://emergeconference.ae', description: "UAE's emerging tech + AI founder conference. 1,500 attendees across UAE + GCC. Keynote slots + panel discussions on AI, fintech, climate tech.", industry_tags: ['ai', 'tech', 'fintech', 'gcc'], estimated_attendees: 1500, payment_model: 'travel_covered', contact_confidence: 'high' },
  { external_id: 'seed_rise_dubai', source: 'seed', name: 'RISE Up Middle East (Dubai Edition)', url: 'https://riseconf.com/middle-east', cfp_url: 'https://riseconf.com/middle-east/speak', cfp_deadline: ts(60), event_start: day(180), event_end: day(182), location_city: 'Dubai', location_country: 'UAE', is_virtual: false, organizer_name: 'Web Summit', organizer_url: 'https://riseconf.com', description: "Web Summit's Middle East edition. 8,000 tech founders + VCs. Centre Stage + Startup stages.", industry_tags: ['tech', 'startup', 'vc', 'regional'], estimated_attendees: 8000, payment_model: 'travel_covered', contact_confidence: 'high' },
  { external_id: 'seed_bizhub_dubai', source: 'seed', name: 'BizHub Dubai — Founder Friday', url: 'https://bizhubdubai.com/events', cfp_url: 'https://bizhubdubai.com/events/apply', cfp_deadline: ts(2), event_start: day(7), event_end: day(7), location_city: 'Dubai', location_country: 'UAE', is_virtual: false, organizer_name: 'BizHub Dubai', organizer_email: 'speakers@bizhubdubai.com', description: 'Weekly Friday breakfast for Dubai solopreneurs and service businesses. 50 attendees. 25-min keynote slot.', industry_tags: ['solopreneur', 'service business', 'local', 'dubai'], estimated_attendees: 50, payment_model: 'unpaid', contact_confidence: 'high' },
  { external_id: 'seed_virtual_middle_east', source: 'seed', name: 'Middle East Founders Virtual Summit 2026', url: 'https://mefsummit.com', cfp_url: 'https://mefsummit.com/speak', cfp_deadline: ts(18), event_start: day(75), event_end: day(77), is_virtual: true, location_country: 'Global', organizer_name: 'MEF Media', organizer_email: 'speak@mefsummit.com', description: '3-day virtual summit for Middle East founders and diaspora entrepreneurs. 15,000 registered. Panel + keynote tracks.', industry_tags: ['middle east', 'entrepreneurship', 'diaspora', 'virtual'], estimated_attendees: 15000, payment_model: 'paid', contact_confidence: 'high' },
  { external_id: 'seed_dmcc_dubai', source: 'seed', name: 'DMCC Made for Trade Live', url: 'https://www.dmcc.ae/events', cfp_url: 'https://www.dmcc.ae/events/speakers', cfp_deadline: ts(30), event_start: day(95), event_end: day(96), location_city: 'Dubai', location_country: 'UAE', is_virtual: false, organizer_name: 'Dubai Multi Commodities Centre', organizer_url: 'https://www.dmcc.ae', description: 'DMCC free-zone business leaders event. 500 attendees from commodities, crypto, fintech, and logistics. Keynote + panel slots.', industry_tags: ['business', 'free zone', 'logistics', 'fintech'], estimated_attendees: 500, payment_model: 'honorarium', contact_confidence: 'high' },
];

const whyMap = {
  'STEP Conference Dubai 2026': 'UAE-based, tech-focused audience actively scaling — your breakthrough moment framework is a perfect keynote for this crowd.',
  'GITEX Global 2026': '170k attendees across tech. Even a sub-stage slot is huge exposure, and they prioritise founder-voice over agency voice.',
  'Entrepreneur Middle East Summit — Dubai': '400 GCC founders wrestling with scaling decisions — your breakthrough angle is pre-pitched here.',
  'Founders Meetup Dubai': 'Hyper-local monthly warm-up stage in your new home city. Low-effort, high-signal for building Dubai network.',
  'Dubai Chamber Business Breakfast': 'Mid-market DMC members = ideal client profile for your software + coaching stack. Warm, referral-heavy audience.',
  'Emerge Conference — Abu Dhabi / Dubai': 'AI + tech founders across UAE. Your Find A Podcast story is a genuine AI-founder case study worth the keynote slot.',
  'RISE Up Middle East (Dubai Edition)': 'Web Summit quality production, Centre Stage access if selected. Aspirational but aligned.',
  'BizHub Dubai — Founder Friday': 'Deadline in 2 days. Tiny local audience but perfect warm-up and testimonial-generating stage.',
  'Middle East Founders Virtual Summit 2026': '15k virtual attendees from the MENA region — your breakthrough + podcast story is localisable.',
  'DMCC Made for Trade Live': '500 free-zone business leaders — high-fit for founders using your software + podcast tour service.',
};

(async () => {
  const enriched = stages.map(x => ({ ...x, contact_sources: { organizer_email: 'seed_demo', url: 'seed_demo' }, contact_unlocked_at: now(), enriched_at: now() }));
  const { data: ins, error } = await s.from('stages').upsert(enriched, { onConflict: 'external_id' }).select('id,name,is_virtual,payment_model');
  if (error) { console.error('insert failed:', error.message); process.exit(1); }
  console.log('seeded', ins.length, 'Dubai-region stages');

  const matches = ins.map(stg => ({
    client_id: ZAC, stage_id: stg.id,
    fit_score: Math.round(85 + Math.random() * 10),
    relevance_score: 80 + Math.floor(Math.random() * 15),
    audience_score: 75 + Math.floor(Math.random() * 20),
    recency_score: 85 + Math.floor(Math.random() * 10),
    distance_score: stg.is_virtual ? 95 : 90,
    payment_score: { premium: 100, paid: 85, honorarium: 70, travel_covered: 60, unpaid: 40 }[stg.payment_model] || 50,
    why_this_client_fits: whyMap[stg.name] || 'Strong alignment with your audience and topics.',
    status: 'new',
  }));

  const { data: mi, error: me } = await s.from('stage_matches').upsert(matches, { onConflict: 'client_id,stage_id' }).select('id');
  if (me) { console.error(me.message); process.exit(1); }
  console.log('inserted', mi.length, 'matches for Zac');
  console.log('');
  console.log('URL: https://findapodcast.io/stages/c1e62c5c-c2a4-4cca-9411-66f0571e704a');
})();
