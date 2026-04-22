-- ═══════════════════════════════════════════════════════════════════════════
-- AGENCY SYSTEM — multi-client workspaces for podcast management agencies
-- Agencies buy the $1,500 setup + $497/mo license and manage unlimited clients.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.agencies (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL,
  dashboard_token        TEXT UNIQUE NOT NULL,
  contact_name           TEXT,
  contact_email          TEXT NOT NULL,
  stripe_subscription_id TEXT,
  status                 TEXT DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
  notes                  TEXT,
  created_at             TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agencies_dashboard_token ON public.agencies(dashboard_token);
CREATE INDEX IF NOT EXISTS idx_agencies_status          ON public.agencies(status);

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS agency_id UUID REFERENCES public.agencies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_clients_agency_id ON public.clients(agency_id);

CREATE TABLE IF NOT EXISTS public.agency_client_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     UUID NOT NULL REFERENCES public.agencies(id) ON DELETE CASCADE,
  client_name   TEXT NOT NULL,
  client_email  TEXT NOT NULL,
  notes         TEXT,
  status        TEXT DEFAULT 'pending' CHECK (status IN ('pending','onboarded','rejected')),
  created_at    TIMESTAMPTZ DEFAULT now(),
  handled_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agency_client_requests_agency_id ON public.agency_client_requests(agency_id);
CREATE INDEX IF NOT EXISTS idx_agency_client_requests_status    ON public.agency_client_requests(status);

-- ── Jesse Tevelow Agency — first customer ──────────────────────────────────
INSERT INTO public.agencies (name, dashboard_token, contact_name, contact_email, status)
VALUES (
  'Jesse Tevelow Agency',
  gen_random_uuid()::text,
  'Jesse Tevelow',
  'jesse@jessetevelow.com',
  'active'
)
ON CONFLICT DO NOTHING
RETURNING id, name, dashboard_token;

-- After running this, the RETURNING clause will show the agency's dashboard_token.
-- Share that token with Jesse as: https://findapodcast.io/agency/<token>
