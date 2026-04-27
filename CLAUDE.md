# Podcast Pipeline — Claude Instructions

## Project
SaaS at C:\Users\zjdkf\podcast-pipeline. Domain: findapodcast.io. Stack: Node/Express, Supabase, Claude API, Listen Notes, Gmail OAuth, Resend, Vanilla JS dashboard, Railway hosting.

## Key Rules
- MVP mindset — no gold-plating, no speculative features
- Read files before editing them
- Prefer editing existing files over creating new ones
- No comments, docstrings, or type annotations on unchanged code
- No backwards-compat shims or unused exports
- NEVER use require('resend') — not installed. Use fetch() to Resend REST API.
- PowerShell: NEVER chain git commands with &&. Run each separately.

## Enrichment System — enrichment.js (9.5/10 — DO NOT WEAKEN)
Full architecture in memory/enrichment_architecture.md. Critical rules:
1. Confidence threshold is 90 — do not change
2. RSS social URLs: atom:link ONLY (no full XML scan — prevents sponsor contamination)
3. ALWAYS run social URLs through validateSocialWithConfidence before storing
4. itunes:owner email has priority over channel-level itunes:email
5. isCatchallDomain() MUST gate inferEmailFromHostName() — never skip this check
6. Listen Notes social URLs MUST be confidence-validated (LN cross-contaminates)
7. Operator blocklists (OPERATOR_EMAILS, OPERATOR_DOMAINS, OPERATOR_SOCIALS) are permanent
8. keep guest@, booking@, contact@ — these are valid podcast contacts (not generic)
9. New fields: is_interview_format, episodes_last_30_days, speakpipe_url, podmatch_url, has_guest_intake, apple_rating, apple_review_count — run SQL migrations if not yet added

## Unlock System — zero hallucination contact reveal (shipped April 2026)
Full architecture: `unlock_system_architecture` project memory. Runbook: `findapodcast-unlock-maintenance` skill. The law: `findapodcast-zero-hallucination` skill.

Flow: customer clicks Unlock on card → `POST /api/unlock/:podcastId` (requires dashboard token) → `src/lib/strict-unlock.js :: unlockPodcast` → 30d shared cache check → runs enrichPodcast + host socials deep search (Google CSE + bio mention verify) + Claude haiku-4.5 email verification → builds `contact_sources` receipt → saves.

Critical rules:
1. Contact pills HIDDEN on customer cards unless `contact_unlocked_at` is set (dashboard/app.js :: contactChipsHtml)
2. Pitch/DM buttons gated on same (actionButtonsHtml)
3. `src/lib/deep-enricher.js` background auto-trigger is DISABLED in pipeline.js — wrote weak-signal data silently. Do not re-enable.
4. `src/routes/dashboard.js` SELECT MUST include: `contact_unlocked_at, contact_confidence, contact_sources, host_instagram_url, host_linkedin_url, host_twitter_url, unlock_count`
5. `podcasts` has NO `updated_at` column — COALESCE backfills use `created_at` instead
6. Migration file: `supabase/add-unlock-system.sql` — idempotent, uses IF NOT EXISTS throughout
7. On hallucination found → two cleanup levels in unlock-maintenance skill (targeted vs full cache invalidation)
8. New tables: `unlock_events` (every click logged with was_cached, result_found, fields_found, duration_ms)

## Server
Start: `cd C:\Users\zjdkf\podcast-pipeline && node src/server.js`
Restart: kill PID on port 3000, then start again

## Routes
- Dashboard: GET /dashboard/:token
- Onboard: GET /onboard
- Operator: GET /operator (key: pipeline2026)
- Pitch decks: GET /self-managed-overview, /podcast-tour-overview
- Agency: GET /agency/:token (multi-client workspace), GET /api/agency/:token, POST /api/agency/:token/request-client
- Stages: GET /stages/:token (preview), GET /api/stages/:token, POST /api/stages/waitlist, POST /api/stages/discover
- API: /api/onboard, /api/run/:clientId, /api/approve, /api/dismiss, /api/send, /api/book, /api/unbook, /api/notes, /api/email/edit, /api/template
- POST /api/unlock/:podcastId (zero-hallucination deep contact reveal — requires dashboard token)
- PATCH /api/onboard/:clientId (profile update)
- Gmail OAuth: /auth/gmail, /auth/gmail/callback

## Supabase
URL: https://ldyocadmkwesdwcnojjf.supabase.co
Tables: clients, podcasts, podcast_matches, unlock_events, agencies, agency_client_requests, stages, stage_matches, stage_waitlist
Run DDL via SQL editor: https://supabase.com/dashboard/project/ldyocadmkwesdwcnojjf/sql/new
Data-only ops (DELETE, UPDATE, INSERT) can run via PostgREST using SUPABASE_SERVICE_KEY as both `apikey` and `Authorization: Bearer` headers.

## Agency system (Apr 22 2026)
Full architecture: `agency_system_architecture` project memory. $1,500 setup + $497/mo, multi-client workspaces. First customer Jesse Tevelow Agency. SQL ran but with simpler schema than file (no contact_name/notes columns on `agencies`).

## Find A Stage system (Apr 24 2026, COMING SOON)
Full architecture: `find_a_stage_architecture` project memory. Speaker-opportunity sibling product to Find A Podcast. SQL `supabase/add-stages-system.sql` NOT YET RUN. Once run, execute `node scripts/seed-stages-demo.js` + `node scripts/seed-dubai-stages.js` to populate Zac's preview at `/stages/c1e62c5c-c2a4-4cca-9411-66f0571e704a`. Customer-facing tab is COMING SOON only — opens waitlist modal.

## GitHub
Repo: https://github.com/zjdk-2026/findapodcast-.git (branch: master)
Push: `git add . && git commit -m "msg" && git push origin master`

## Env Vars (set in Railway for prod, .env for local)
ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, LISTENNOTES_API_KEY,
GOOGLE_SEARCH_API_KEY, GOOGLE_SEARCH_CX, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
RESEND_API_KEY, RESEND_FROM_EMAIL, OPERATOR_KEY, BASE_URL, GOOGLE_REDIRECT_URI,
CRON_SECRET (required for /api/cron/check-replies-all)

## Reply detection cron (Apr 27 2026)
- POST /api/cron/check-replies-all (header `x-cron-secret: $CRON_SECRET`) scans every connected client every 5 min, regardless of whether their dashboard tab is open.
- Fires Resend notification email to `clients.email` the moment a host reply is detected (subject: `<Host> just replied — <Podcast>`).
- Uses `scanRepliesForClient(client)` extracted in `src/routes/gmail.js` so the per-dashboard endpoint and the cron share one code path.
- Set up Railway cron via Railway dashboard → Cron Jobs: `*/5 * * * *  curl -X POST -H "x-cron-secret: $CRON_SECRET" $BASE_URL/api/cron/check-replies-all`
- Bounce-aware: mailer-daemon delivery failures NEVER count as replies. `getThreadMessageCount` uses metadata format and filters via `isBounceMessage()`. `checkInboxForReplyFromEmail` injects `-from:mailer-daemon -subject:"delivery status notification" -subject:"undeliverable"` into every search query.
- Thread caching tags bounces with `message_type='bounce'` and reverts the match to 'sent' if every inbound message was a bounce.
