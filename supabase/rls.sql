-- ═══════════════════════════════════════════════════════════════
-- Find A Podcast — Row Level Security
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- The service_role key used by the server bypasses RLS entirely,
-- so this only blocks unauthenticated/anon direct API calls.
-- ═══════════════════════════════════════════════════════════════

-- 1. Enable RLS on all tables
ALTER TABLE public.clients         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.podcast_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.podcasts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.magic_links     ENABLE ROW LEVEL SECURITY;

-- 2. Deny all anon/public access (no policies = deny by default)
--    The server uses service_role which bypasses RLS — no change needed there.

-- 3. Optional: allow read on podcasts for any authenticated user
--    (uncomment if you ever add Supabase Auth logins)
-- CREATE POLICY "authenticated_read_podcasts"
--   ON public.podcasts FOR SELECT
--   TO authenticated
--   USING (true);

-- Verify RLS is enabled:
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('clients','podcast_matches','podcasts','magic_links');
