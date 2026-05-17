# Podcast Outreach System

Enriches podcast records in the Find A Podcast Supabase database with contact info, scores them for outreach priority, generates personalized cold emails via Claude, and saves drafts to Gmail for manual review.

## One-Time Setup

```bash
# 1. Create and activate virtualenv
python -m venv .venv
source .venv/bin/activate        # Mac/Linux
# .venv\Scripts\activate         # Windows

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure environment
cp config/.env.example config/.env
# Edit config/.env and fill in all values:
#   DATABASE_URL     — Supabase direct connection string
#   ANTHROPIC_API_KEY — from console.anthropic.com
#   GMAIL_FROM        — your Gmail address
#   GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_CX (optional, improves social finding)

# 4. Gmail OAuth (one-time)
# Download OAuth 2.0 credentials JSON from Google Cloud Console → Gmail API
# Save as gmail_credentials.json in project root
python scripts/gmail_auth.py

# 5. Inspect your database first
python scripts/01_inspect_database.py
```

## Getting the Supabase Database URL

In Supabase dashboard → Project Settings → Database → Connection string (URI mode).
It looks like: `postgresql://postgres:[password]@db.[project-ref].supabase.co:5432/postgres`

## Weekly Workflow

```bash
# Step 1: Export podcasts needing contact info
python scripts/02_export_for_enrichment.py

# Step 2: Scrape contact information (RSS feeds + websites + Google)
python scripts/03_run_enrichment.py

# Step 3: Review enrichment results in a UI, approve data to write back
streamlit run src/dashboard/app.py
# — or —
python scripts/04_review_dashboard.py

# Step 4: Score all podcasts for outreach priority
python scripts/05_score_leads.py

# Step 5: Generate personalized emails for top 20 hot leads
python scripts/06_generate_emails.py

# Step 6: Save as Gmail drafts — never auto-sends
python scripts/07_create_gmail_drafts.py

# Step 7: Open Gmail, review drafts, edit if needed, send manually
```

## Lead Scoring

| Score | Tier | Action |
|-------|------|--------|
| 8–10  | hot  | Reach out immediately |
| 5–7   | warm | Good prospects |
| 3–4   | cold | Low priority |
| 0–2   | skip | Incomplete data |

Points breakdown:
- Has email: +3
- Has LinkedIn: +2
- Has Twitter/Instagram: +1
- 50+ episodes: +2
- 20+ episodes: +1
- Priority category: +1
- Active last 60 days: +1

## Customization

**Email tone/offer** — edit `SYSTEM_PROMPT` and `USER_PROMPT_TEMPLATE` in `src/outreach/email_generator.py`

**Priority categories** — edit `config/categories.yaml`

**Max emails per run** — set `MAX_EMAILS_PER_RUN` in `scripts/06_generate_emails.py`

**Scoring weights** — edit `src/scoring/lead_scorer.py`

## Testing Without Writing to Database

Every script supports `--dry-run`:
```bash
python scripts/03_run_enrichment.py --dry-run --limit 5
python scripts/05_score_leads.py --dry-run
python scripts/06_generate_emails.py --dry-run
python scripts/07_create_gmail_drafts.py --dry-run
```
