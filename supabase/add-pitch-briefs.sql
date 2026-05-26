-- Pitch Briefs feature (May 2026)
-- Adds 2 onboarding fields for stronger angle generation, plus a per-client cached brief table.
-- Idempotent: safe to run multiple times.

-- 1. Add contrarian_belief + origin_story to clients (powers the angle section of every brief)
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS contrarian_belief TEXT,
  ADD COLUMN IF NOT EXISTS origin_story      TEXT;

-- 2. pitch_briefs: per (podcast, client) cached AI brief
CREATE TABLE IF NOT EXISTS pitch_briefs (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  podcast_id                UUID NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  client_id                 UUID NOT NULL REFERENCES clients(id)  ON DELETE CASCADE,
  brief_json                JSONB NOT NULL,
  episodes_analyzed_count   INT  DEFAULT 0,
  source_rss_url            TEXT,
  generated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  regenerated_at            TIMESTAMPTZ,
  regenerate_count          INT  DEFAULT 0,
  -- "limited" if RSS/iTunes data was missing; "full" if all sources hit
  data_quality              TEXT DEFAULT 'full',
  UNIQUE (podcast_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_pitch_briefs_client_id  ON pitch_briefs(client_id);
CREATE INDEX IF NOT EXISTS idx_pitch_briefs_podcast_id ON pitch_briefs(podcast_id);
