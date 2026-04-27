-- ═══════════════════════════════════════════════════════════════════════════
-- SAVED EMAIL TEMPLATES (Apr 26 2026)
--
-- Customers can save a pitch / follow-up they like as a named template,
-- then re-apply it to other matches with one click. Each template stores
-- subject + body. The body uses {placeholders} that get auto-replaced
-- per-match: {host_name}, {podcast_title}, {host_first_name},
-- {client_name}, {client_first_name}, {one_liner}, {credential}.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.email_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('pitch', 'followup', 'thankyou', 'discovery')),
  name         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  is_default   BOOLEAN DEFAULT false,
  use_count    INTEGER DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_et_client_type ON public.email_templates(client_id, type);
CREATE INDEX IF NOT EXISTS idx_et_default     ON public.email_templates(client_id, type, is_default) WHERE is_default = true;
