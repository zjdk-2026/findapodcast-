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

## Server
Start: `cd C:\Users\zjdkf\podcast-pipeline && node src/server.js`
Restart: kill PID on port 3000, then start again

## Routes
- Dashboard: GET /dashboard/:token
- Onboard: GET /onboard
- Operator: GET /operator (key: pipeline2026)
- API: /api/onboard, /api/run/:clientId, /api/approve, /api/dismiss, /api/send, /api/book, /api/unbook, /api/notes, /api/email/edit, /api/template
- PATCH /api/onboard/:clientId (profile update)
- Gmail OAuth: /auth/gmail, /auth/gmail/callback

## Supabase
URL: https://ldyocadmkwesdwcnojjf.supabase.co
Tables: clients, podcasts, podcast_matches

## GitHub
Repo: https://github.com/zjdk-2026/findapodcast-.git (branch: master)
Push: `git add . && git commit -m "msg" && git push origin master`

## Env Vars (set in Railway for prod, .env for local)
ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, LISTENNOTES_API_KEY,
GOOGLE_SEARCH_API_KEY, GOOGLE_SEARCH_CX, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
RESEND_API_KEY, RESEND_FROM_EMAIL, OPERATOR_KEY, BASE_URL, GOOGLE_REDIRECT_URI
