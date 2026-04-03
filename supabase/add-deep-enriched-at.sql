ALTER TABLE public.podcasts ADD COLUMN IF NOT EXISTS deep_enriched_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_podcasts_deep_enriched_at ON public.podcasts(deep_enriched_at);
