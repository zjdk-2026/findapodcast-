# Podcast Pipeline — Claude Instructions

## Project
SaaS at C:\Users\zjdkf\podcast-pipeline. Domain: findapodcast.io. Stack: Node/Express, Supabase, Claude API, Listen Notes, Gmail OAuth, Resend, Vanilla JS dashboard, Railway hosting.

## Key Rules
- MVP mindset — no gold-plating, no speculative features
- Read files before editing them
- Prefer editing existing files over creating new ones
- No comments, docstrings, or type annotations on unchanged code
- No backwards-compat shims or unused exports

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
