# Podcast Pipeline

Automated podcast guest booking SaaS — discovers relevant podcasts daily, scores them with Claude AI, writes personalised pitch emails, creates Gmail drafts, and emails you a digest.

---

## Setup in 10 Steps

### 1. Clone & install

```bash
git clone https://github.com/your-org/podcast-pipeline.git
cd podcast-pipeline
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in every value. Required keys:

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase dashboard → Settings → API |
| `SUPABASE_SERVICE_KEY` | Supabase dashboard → Settings → API (service role key) |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com |
| `LISTENNOTES_API_KEY` | https://www.listennotes.com/api/ |
| `GOOGLE_SEARCH_API_KEY` | https://console.cloud.google.com → APIs → Custom Search |
| `GOOGLE_SEARCH_CX` | https://cse.google.com → Search engine ID |
| `GOOGLE_CLIENT_ID` | Google Cloud → OAuth 2.0 credentials |
| `GOOGLE_CLIENT_SECRET` | Google Cloud → OAuth 2.0 credentials |
| `GOOGLE_REDIRECT_URI` | Must match an authorised redirect URI in Google Cloud |
| `RESEND_API_KEY` | https://resend.com → API Keys |
| `RESEND_FROM_EMAIL` | A verified sender in your Resend account |
| `BASE_URL` | Your public URL (e.g. `https://your-app.railway.app`) |

### 3. Apply the database schema

1. Open your Supabase project → SQL editor
2. Paste the contents of `supabase/schema.sql`
3. Run it

### 4. Run locally

```bash
npm run dev
```

Server starts at http://localhost:3000. The dashboard is at http://localhost:3000/dashboard/.

### 5. Onboard your first client

```bash
curl -X POST http://localhost:3000/api/onboard \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Jane Smith",
    "email": "jane@example.com",
    "business_name": "Acme Consulting",
    "title": "CEO & Keynote Speaker",
    "bio_short": "I help B2B companies scale from $1M to $10M ARR.",
    "topics": ["entrepreneurship", "business", "leadership"],
    "speaking_angles": ["From broke to $10M in 3 years", "The 5 mistakes that kill B2B growth"],
    "target_audience": "entrepreneurs and founders",
    "target_industries": ["SaaS", "consulting", "professional services"],
    "booking_link": "https://calendly.com/janesmith",
    "daily_target": 10,
    "timezone": "America/New_York"
  }'
```

Response includes `dashboardUrl` and `gmailAuthUrl`.

### 6. Connect Gmail (optional but recommended)

Visit the `gmailAuthUrl` from the onboarding response. This authorises the system to create Gmail drafts on behalf of the client. A refresh token is saved to the database and never expires unless revoked.

**Google Cloud setup:**
1. Create a project at https://console.cloud.google.com
2. Enable the Gmail API
3. Create OAuth 2.0 credentials (Web application type)
4. Add your `GOOGLE_REDIRECT_URI` to the authorised redirect URIs list
5. Set the OAuth consent screen to your domain

### 7. Run the pipeline manually (for testing)

```bash
curl -X POST http://localhost:3000/api/run/CLIENT_ID_HERE
```

Replace `CLIENT_ID_HERE` with the `clientId` from the onboarding response.

### 8. View the dashboard

Open the `dashboardUrl` from the onboarding response in your browser. You can approve, dismiss, and send pitches directly from the UI.

### 9. Deploy to Railway

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and link project
railway login
railway init

# Set all environment variables in Railway dashboard
# Then deploy:
railway up
```

The `railway.json` file configures the build and health check automatically. Railway auto-deploys on every push to main.

### 10. Automatic daily runs

The scheduler runs automatically at 7am in each client's configured timezone. New clients are picked up within 24 hours. No additional configuration is needed.

---

## API Reference

| Method | Path | Description |
|---|---|---|
| POST | `/api/onboard` | Onboard a new client |
| POST | `/api/run/:clientId` | Manually trigger a pipeline run |
| GET | `/api/dashboard/:token` | Fetch dashboard data for a client |
| POST | `/api/approve` | Approve a match `{ matchId }` |
| POST | `/api/dismiss` | Dismiss a match `{ matchId }` |
| POST | `/api/send` | Send a match email `{ matchId }` |
| GET | `/auth/gmail` | Start Gmail OAuth `?clientId=` |
| GET | `/auth/gmail/callback` | Gmail OAuth callback |
| GET | `/health` | Health check |

---

## Project Structure

```
podcast-pipeline/
├── src/
│   ├── server.js          Express app + static serving
│   ├── scheduler.js       node-cron daily jobs per client
│   ├── routes/            API route handlers
│   ├── services/          Business logic (discovery, scoring, email)
│   ├── lib/               Third-party clients (Supabase, Anthropic, etc.)
│   └── prompts/           Claude system prompts
├── dashboard/             Vanilla HTML/CSS/JS frontend
├── supabase/schema.sql    Database schema
├── .env.example           Environment variable template
├── railway.json           Railway deployment config
└── package.json
```
