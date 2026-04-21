-- ═══════════════════════════════════════════════════════════════════════════
-- UNLOCK SYSTEM — Zero Hallucination Launch
-- Shared contact cache, contact-likelihood badge, host personal socials,
-- verification receipts. Customer unlocks reveal verified contact data.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Unlock tracking (shared cache keys) ──────────────────────────────────
ALTER TABLE public.podcasts
  ADD COLUMN IF NOT EXISTS contact_unlocked_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contact_unlocked_by    UUID REFERENCES public.clients(id),
  ADD COLUMN IF NOT EXISTS contact_confidence     TEXT CHECK (contact_confidence IN ('high','medium','low','none')),
  ADD COLUMN IF NOT EXISTS contact_sources        JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS unlock_count           INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_podcasts_contact_unlocked_at ON public.podcasts(contact_unlocked_at);
CREATE INDEX IF NOT EXISTS idx_podcasts_contact_confidence  ON public.podcasts(contact_confidence);

-- ── 2. Host personal socials ────────────────────────────────────────────────
-- Different from show socials: this is the host's personal account,
-- only populated if the bio explicitly mentions the show.
ALTER TABLE public.podcasts
  ADD COLUMN IF NOT EXISTS host_instagram_url TEXT,
  ADD COLUMN IF NOT EXISTS host_linkedin_url  TEXT,
  ADD COLUMN IF NOT EXISTS host_twitter_url   TEXT;

-- ── 3. Unlock event log (abuse monitoring + analytics) ──────────────────────
CREATE TABLE IF NOT EXISTS public.unlock_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  podcast_id     UUID NOT NULL REFERENCES public.podcasts(id) ON DELETE CASCADE,
  client_id      UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  triggered_at   TIMESTAMPTZ DEFAULT now(),
  was_cached     BOOLEAN DEFAULT false,
  result_found   BOOLEAN,               -- true if contact data was revealed
  fields_found   TEXT[] DEFAULT '{}'::text[],
  duration_ms    INTEGER,
  error_message  TEXT
);

CREATE INDEX IF NOT EXISTS idx_unlock_events_podcast_id   ON public.unlock_events(podcast_id);
CREATE INDEX IF NOT EXISTS idx_unlock_events_client_id    ON public.unlock_events(client_id);
CREATE INDEX IF NOT EXISTS idx_unlock_events_triggered_at ON public.unlock_events(triggered_at DESC);

-- ── 4. Backfill confidence for existing podcasts based on what we already have
UPDATE public.podcasts
SET contact_confidence = CASE
  WHEN contact_email IS NOT NULL
    OR instagram_url IS NOT NULL
    OR twitter_url IS NOT NULL
    OR linkedin_page_url IS NOT NULL
    OR facebook_url IS NOT NULL
    THEN 'high'
  WHEN website IS NOT NULL THEN 'medium'
  ELSE 'low'
END
WHERE contact_confidence IS NULL;

-- ── 5. Mark existing enriched podcasts as already-unlocked (so live customers don't see a regression)
UPDATE public.podcasts
SET contact_unlocked_at = COALESCE(deep_enriched_at, enriched_at, created_at, now())
WHERE contact_unlocked_at IS NULL
  AND (contact_email IS NOT NULL OR instagram_url IS NOT NULL);
