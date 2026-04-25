-- ═══════════════════════════════════════════════════════════════════════════
-- FIND A STAGE — speaker opportunity discovery
-- Same architecture as Find A Podcast: discover → enrich → match → pitch.
-- Sources: Sessionize, Papercall, Eventbrite, CallForSpeakers, 10Times, Google CSE.
-- Zero hallucination rules apply: only show verified open CFPs with verifiable
-- organizer contacts. If CFP deadline passed or URL 404s, don't show.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.stages (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id            TEXT UNIQUE,              -- sessionize:NNNN, papercall:NN, tedx:NNN, toastmasters:NNN, etc.
  source                 TEXT,                      -- sessionize | papercall | eventbrite | google_cse | tedx | toastmasters | startup_grind | founders_live | creative_mornings | one_million_cups | instagram | facebook_group | manual | seed
  event_type             TEXT,                      -- conference | summit | virtual_summit | networking | org_chapter | tedx | meetup | mastermind | community
  chapter_org            TEXT,                      -- toastmasters | tedx | startup_grind | founders_live | creative_mornings | bni | rotary | eo | ypo | vistage | one_million_cups | null
  recurring              BOOLEAN DEFAULT false,     -- true for weekly/monthly chapter meetings
  meeting_frequency      TEXT,                      -- weekly | biweekly | monthly | quarterly | annual | one_off
  name                   TEXT NOT NULL,
  url                    TEXT,
  cfp_url                TEXT,
  cfp_deadline           TIMESTAMPTZ,
  event_start            DATE,
  event_end              DATE,
  timezone               TEXT,

  location_city          TEXT,
  location_country       TEXT,
  location_region        TEXT,                      -- state / province
  is_virtual             BOOLEAN DEFAULT false,
  is_hybrid              BOOLEAN DEFAULT false,
  latitude               NUMERIC,
  longitude              NUMERIC,

  organizer_name         TEXT,
  organizer_email        TEXT,
  organizer_url          TEXT,
  organizer_linkedin_url TEXT,

  description            TEXT,
  industry_tags          TEXT[] DEFAULT '{}'::text[],
  estimated_attendees    INTEGER,
  payment_model          TEXT CHECK (payment_model IN ('unpaid','honorarium','paid','premium','travel_covered','unknown')),
  past_speakers          TEXT[] DEFAULT '{}'::text[],

  contact_confidence     TEXT CHECK (contact_confidence IN ('high','medium','low','none')),
  contact_sources        JSONB DEFAULT '{}'::jsonb,
  contact_unlocked_at    TIMESTAMPTZ,

  enriched_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stages_source          ON public.stages(source);
CREATE INDEX IF NOT EXISTS idx_stages_cfp_deadline    ON public.stages(cfp_deadline);
CREATE INDEX IF NOT EXISTS idx_stages_event_start     ON public.stages(event_start);
CREATE INDEX IF NOT EXISTS idx_stages_location_city   ON public.stages(location_city);
CREATE INDEX IF NOT EXISTS idx_stages_location_country ON public.stages(location_country);
CREATE INDEX IF NOT EXISTS idx_stages_is_virtual      ON public.stages(is_virtual);
CREATE INDEX IF NOT EXISTS idx_stages_industry_tags   ON public.stages USING gin(industry_tags);

-- ── Matches: per-client scored stage opportunities ─────────────────────────
CREATE TABLE IF NOT EXISTS public.stage_matches (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id              UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  stage_id               UUID NOT NULL REFERENCES public.stages(id) ON DELETE CASCADE,

  fit_score              INTEGER,
  relevance_score        INTEGER,
  audience_score         INTEGER,
  recency_score          INTEGER,
  distance_score         INTEGER,
  payment_score          INTEGER,

  why_this_client_fits   TEXT,
  best_pitch_angle       TEXT,

  status                 TEXT DEFAULT 'new' CHECK (status IN ('new','dream','applied','responded','accepted','declined','spoke','archived')),
  applied_at             TIMESTAMPTZ,
  responded_at           TIMESTAMPTZ,
  accepted_at            TIMESTAMPTZ,
  spoke_at               TIMESTAMPTZ,

  client_notes           TEXT,
  email_subject          TEXT,
  email_body             TEXT,
  email_subject_edited   TEXT,
  email_body_edited      TEXT,

  created_at             TIMESTAMPTZ DEFAULT now(),
  UNIQUE(client_id, stage_id)
);

CREATE INDEX IF NOT EXISTS idx_stage_matches_client_id ON public.stage_matches(client_id);
CREATE INDEX IF NOT EXISTS idx_stage_matches_stage_id  ON public.stage_matches(stage_id);
CREATE INDEX IF NOT EXISTS idx_stage_matches_status    ON public.stage_matches(status);
CREATE INDEX IF NOT EXISTS idx_stage_matches_fit_score ON public.stage_matches(fit_score DESC);

-- ── Waitlist (public COMING SOON email capture) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.stage_waitlist (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  email       TEXT NOT NULL,
  city        TEXT,
  industry    TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stage_waitlist_email      ON public.stage_waitlist(email);
CREATE INDEX IF NOT EXISTS idx_stage_waitlist_client_id  ON public.stage_waitlist(client_id);

-- ── Idempotent column additions (safe even if you ran an earlier version) ──
ALTER TABLE public.stages
  ADD COLUMN IF NOT EXISTS event_type        TEXT,
  ADD COLUMN IF NOT EXISTS chapter_org       TEXT,
  ADD COLUMN IF NOT EXISTS recurring         BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS meeting_frequency TEXT;

CREATE INDEX IF NOT EXISTS idx_stages_event_type   ON public.stages(event_type);
CREATE INDEX IF NOT EXISTS idx_stages_chapter_org  ON public.stages(chapter_org);
