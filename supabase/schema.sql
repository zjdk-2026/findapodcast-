-- ─────────────────────────────────────────────────────────────
-- Podcast Pipeline — Supabase Schema
-- Run this in the Supabase SQL editor to initialise the database.
-- ─────────────────────────────────────────────────────────────

-- CLIENTS
create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  business_name text,
  title text,
  bio_short text,
  bio_long text,
  topics text[],
  speaking_angles text[],
  target_audience text,
  target_industries text[],
  avoid_industries text[],
  avoid_topics text[],
  website text,
  booking_link text,
  lead_magnet text,
  social_instagram text,
  social_linkedin text,
  social_twitter text,
  preferred_tone text default 'warm-professional',
  min_show_episodes integer default 20,
  min_show_age_days integer default 0,
  max_show_age_days integer default 90,
  geographies text[] default array['US','CA','UK','AU'],
  languages text[] default array['English'],
  daily_target integer default 10,
  dashboard_token text unique default gen_random_uuid()::text,
  gmail_refresh_token text,
  gmail_email text,
  is_active boolean default true,
  onboarded_at timestamptz default now(),
  last_run_at timestamptz,
  timezone text default 'America/New_York'
);

-- PODCASTS
create table podcasts (
  id uuid primary key default gen_random_uuid(),
  external_id text unique,
  title text not null,
  host_name text,
  description text,
  website text,
  contact_email text,
  contact_form_url text,
  apple_url text,
  spotify_url text,
  youtube_url text,
  youtube_channel_id text,
  youtube_subscribers integer,
  instagram_url text,
  instagram_followers integer,
  linkedin_url text,
  category text,
  niche_tags text[],
  total_episodes integer,
  last_episode_date date,
  publish_frequency text,
  avg_episode_duration_mins integer,
  has_guest_history boolean default false,
  booking_page_url text,
  guest_application_url text,
  country text,
  language text default 'English',
  listen_score integer,
  created_at timestamptz default now(),
  enriched_at timestamptz
);

-- PODCAST MATCHES
create table podcast_matches (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  podcast_id uuid references podcasts(id),
  relevance_score integer,
  audience_score integer,
  recency_score integer,
  guest_quality_score integer,
  reach_score integer,
  contactability_score integer,
  brand_score integer,
  fit_score integer,
  show_summary text,
  why_this_client_fits text,
  best_pitch_angle text,
  episode_to_reference text,
  red_flags text,
  booking_likelihood text,
  email_subject text,
  email_body text,
  gmail_draft_id text,
  status text default 'new',
  discovered_at timestamptz default now(),
  approved_at timestamptz,
  sent_at timestamptz,
  replied_at timestamptz,
  booked_at timestamptz
);

create index on podcast_matches(client_id, status);
create index on podcast_matches(client_id, fit_score desc);
create index on podcast_matches(discovered_at desc);
