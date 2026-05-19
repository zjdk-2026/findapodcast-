-- Apple Podcasts enrichment columns
alter table podcasts add column if not exists apple_rating numeric(2,1);
alter table podcasts add column if not exists apple_review_count integer;
alter table podcasts add column if not exists apple_chart_rank integer;
alter table podcasts add column if not exists apple_chart_category text;
alter table podcasts add column if not exists has_ads boolean default false;
alter table podcasts add column if not exists apple_scraped_at timestamptz;
alter table podcasts add column if not exists host_phone text;

-- Index for batch scraping (prioritize unscraped podcasts)
create index if not exists idx_podcasts_apple_scraped_at on podcasts(apple_scraped_at) where apple_scraped_at is null;
