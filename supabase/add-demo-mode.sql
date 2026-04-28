-- Demo mode columns on `clients`
-- Run via Supabase SQL editor:
-- https://supabase.com/dashboard/project/ldyocadmkwesdwcnojjf/sql/new
--
-- Idempotent. Safe to run multiple times.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS demo_mode         BOOLEAN     DEFAULT false,
  ADD COLUMN IF NOT EXISTS demo_started_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS demo_expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS demo_unlocked_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS clients_demo_mode_idx ON public.clients (demo_mode) WHERE demo_mode = true;
CREATE INDEX IF NOT EXISTS clients_demo_expires_idx ON public.clients (demo_expires_at) WHERE demo_mode = true;

COMMENT ON COLUMN public.clients.demo_mode        IS 'When true, dashboard returns redacted matches and action endpoints return 402 demo_locked.';
COMMENT ON COLUMN public.clients.demo_started_at  IS 'When the demo account was first created.';
COMMENT ON COLUMN public.clients.demo_expires_at  IS 'When the demo expires (default 14 days from start). After this, dashboard locks down.';
COMMENT ON COLUMN public.clients.demo_unlocked_at IS 'When the prospect paid and demo_mode flipped to false. Funnel analytics.';
