-- Apple Podcasts dossier data: recent episodes + featured reviews
alter table podcasts add column if not exists recent_episodes jsonb;
alter table podcasts add column if not exists featured_reviews jsonb;

create index if not exists idx_podcasts_recent_episodes on podcasts using gin(recent_episodes);
create index if not exists idx_podcasts_featured_reviews on podcasts using gin(featured_reviews);