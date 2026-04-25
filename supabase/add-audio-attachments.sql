-- ═══════════════════════════════════════════════════════════════════════════
-- VOICE INTRO ATTACHMENTS — per-host audio attached to pitch emails
-- Idempotent. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Columns on podcast_matches to track the audio attachment per pitch
ALTER TABLE public.podcast_matches
  ADD COLUMN IF NOT EXISTS audio_attachment_path     TEXT,
  ADD COLUMN IF NOT EXISTS audio_attachment_filename TEXT,
  ADD COLUMN IF NOT EXISTS audio_attachment_mime     TEXT,
  ADD COLUMN IF NOT EXISTS audio_attachment_bytes    INTEGER;

-- 2. Private storage bucket for pitch audio (max 5MB per file enforced server-side)
INSERT INTO storage.buckets (id, name, public)
VALUES ('pitch-audio', 'pitch-audio', false)
ON CONFLICT (id) DO NOTHING;
