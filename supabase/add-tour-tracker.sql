-- Tour Tracker — status change log for the Notion "Show Directory".
-- Notion keeps no status history, so /api/tour-tracker records each change it observes.
CREATE TABLE IF NOT EXISTS public.tour_status_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id      TEXT NOT NULL,
  show_name    TEXT,
  from_status  TEXT,
  to_status    TEXT,
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tour_status_events_page     ON public.tour_status_events(page_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_tour_status_events_observed ON public.tour_status_events(observed_at DESC);

ALTER TABLE public.tour_status_events ENABLE ROW LEVEL SECURITY;

-- Verified socials found by the Tour Tracker "Find socials" button (strictEnrich, same law as Unlock).
-- Keyed by Notion Show Directory page id. Never written back to Notion.
CREATE TABLE IF NOT EXISTS public.tour_show_socials (
  page_id     TEXT PRIMARY KEY,
  show_name   TEXT,
  fields      JSONB NOT NULL DEFAULT '{}'::jsonb,
  sources     JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence  TEXT,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.tour_show_socials ENABLE ROW LEVEL SECURITY;

-- Notes typed on the Tour Tracker per show. Never written back to Notion.
CREATE TABLE IF NOT EXISTS public.tour_show_notes (
  page_id       TEXT PRIMARY KEY,
  tour_notes    TEXT NOT NULL DEFAULT '',
  client_notes  TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.tour_show_notes ENABLE ROW LEVEL SECURITY;
