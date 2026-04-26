-- ═══════════════════════════════════════════════════════════════════════════
-- THREAD TRACKING (Apr 26 2026, Phase A of reply pipeline upgrade)
--
-- Captures every email we send AND every reply we detect, with full Gmail
-- message metadata so we can thread replies correctly via In-Reply-To headers.
--
-- This unlocks:
--   1. Follow-ups that ACTUALLY thread (Re: subject + In-Reply-To header
--      pointing to the original Message-ID + same threadId)
--   2. Dashboard thread view (future phase B)
--   3. Manual reply from dashboard preserving threading (phase B)
--   4. AI-drafted reply with full conversation context (phase C)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.podcast_matches
  ADD COLUMN IF NOT EXISTS gmail_thread_id          TEXT,
  ADD COLUMN IF NOT EXISTS gmail_pitch_message_id   TEXT,
  ADD COLUMN IF NOT EXISTS gmail_followup_message_id TEXT,
  ADD COLUMN IF NOT EXISTS last_message_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS message_count            INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unread_inbound_count     INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_pm_thread_id ON public.podcast_matches(gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;

-- ── Per-message ledger ────────────────────────────────────────────────────
-- Every sent or received email lives here. One row per message.
CREATE TABLE IF NOT EXISTS public.match_thread_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id            UUID REFERENCES public.podcast_matches(id) ON DELETE CASCADE,
  gmail_message_id    TEXT UNIQUE,
  gmail_thread_id     TEXT NOT NULL,
  direction           TEXT CHECK (direction IN ('outbound','inbound')),
  message_type        TEXT,                  -- pitch | followup | thankyou | host_reply | customer_reply
  from_email          TEXT,
  from_name           TEXT,
  to_email            TEXT,
  subject             TEXT,
  body_text           TEXT,
  body_html           TEXT,
  rfc822_message_id   TEXT,                  -- the email's RFC-822 Message-ID header (for In-Reply-To threading)
  in_reply_to         TEXT,                  -- whatever this message is responding to
  audio_attached      BOOLEAN DEFAULT false,
  sent_at             TIMESTAMPTZ,
  detected_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mtm_match     ON public.match_thread_messages(match_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_mtm_thread    ON public.match_thread_messages(gmail_thread_id);
CREATE INDEX IF NOT EXISTS idx_mtm_direction ON public.match_thread_messages(direction);
