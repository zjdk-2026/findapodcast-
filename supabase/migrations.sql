-- Podcast Pipeline — Schema additions
-- Run this against your Supabase project SQL editor.

-- ── podcast_matches additions ────────────────────────────────────────
alter table podcast_matches add column if not exists booked_show_name text;
alter table podcast_matches add column if not exists client_notes text;
alter table podcast_matches add column if not exists follow_up_sent_at timestamptz;
alter table podcast_matches add column if not exists email_subject_edited text;
alter table podcast_matches add column if not exists email_body_edited text;

-- ── clients additions ───────────────────────────────────────────────
alter table clients add column if not exists email_template text;

-- ── podcasts additions ───────────────────────────────────────────────
alter table podcasts add column if not exists facebook_url text;
alter table podcasts add column if not exists twitter_url text;
alter table podcasts add column if not exists tiktok_url text;
alter table podcasts add column if not exists linkedin_page_url text;
