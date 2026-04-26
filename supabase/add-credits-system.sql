-- ═══════════════════════════════════════════════════════════════════════════
-- CREDITS + POINTS SYSTEM (Apr 25 2026)
--
-- Self-Managed customers get 500 credits/month. Tour customers get unlimited.
-- Each action costs credits AND awards points. Points fuel the operator
-- leaderboard (customer-invisible until launched).
--
-- Top-up packs (Stripe wiring deferred):
--   +100 credits = $50
--   +200 credits = $75
--   +300 credits = $100
--
-- Monthly leader (highest monthly_points) earns +50 bonus credits.
-- Tie-breaker: ALL tied leaders get +50 each.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS credits_remaining   INTEGER DEFAULT 500,
  ADD COLUMN IF NOT EXISTS credits_reset_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS credit_pack_addon   INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unlimited_credits   BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS monthly_points      INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_points     INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_action_at      TIMESTAMPTZ;

-- Backfill: every existing client starts with 500 credits and a reset date
-- = first of next month. Nobody loses access on day 1 of rollout.
UPDATE public.clients
   SET credits_remaining = COALESCE(credits_remaining, 500),
       credits_reset_at  = COALESCE(credits_reset_at, date_trunc('month', now()) + interval '1 month')
 WHERE credits_remaining IS NULL OR credits_reset_at IS NULL;

-- ── Per-action ledger ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.credit_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,           -- 'pitch_send' | 'followup_send' | 'search_batch' | 'unlock' | 'interview_prep' | 'voice_intro' | 'reply_received' | 'booking_confirmed' | 'episode_aired' | 'monthly_reset' | 'topup' | 'leader_bonus'
  credits_delta   INTEGER NOT NULL DEFAULT 0,    -- negative on spend, positive on top-up/reset
  points_delta    INTEGER NOT NULL DEFAULT 0,    -- always non-negative
  balance_after   INTEGER,
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ct_client_recent ON public.credit_transactions(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_action        ON public.credit_transactions(action);
-- (Removed idx_ct_month: date_trunc(timestamptz) is not IMMUTABLE so can't index on it.
--  Monthly queries use range filters on created_at instead — already covered by idx_ct_client_recent.)

-- ── Monthly leaderboard archive ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.monthly_leaderboard (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  month_year      TEXT NOT NULL,           -- '2026-04'
  client_id       UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  client_name     TEXT,
  monthly_points  INTEGER NOT NULL,
  rank            INTEGER NOT NULL,
  bonus_awarded   INTEGER DEFAULT 0,       -- 50 for #1 tied or solo, 0 otherwise
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(month_year, client_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_month_rank ON public.monthly_leaderboard(month_year, rank);
