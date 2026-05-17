import os
import re
import sys
import anthropic
from loguru import logger

MODEL = "claude-haiku-4-5-20251001"

SYSTEM_PROMPT = """You are writing warm, personalized outreach emails for a podcast collaboration service.

Context:
- I run "Podcast Breakthrough Moment" podcast
- I have a service called "Find A Podcast" that connects guests with shows
- I want to offer this podcast host: free guest matching, cross-promotion opportunities, and brainstorming monetization strategies
- The goal is to book a 15-minute connection call

Rules:
- Warm, conversational, professional tone
- NO dashes as punctuation
- NO bullet points
- NO exclamation points
- NO "I hope this email finds you well"
- NO "just checking in" or "circling back"
- Plain prose only
- Under 100 words
- Subject line under 8 words
- Personalize with: their podcast name, a specific episode topic (if known), or their category
- Make it about collaboration, not selling"""

USER_PROMPT_TEMPLATE = """Write a cold email to {host_name} who hosts "{podcast_name}" (a {category} podcast with {episode_count} episodes).

Offer:
- I can connect them with high-quality guests from my network
- Their show would be a great fit for our guest database
- Open to exploring cross-promotion and monetization ideas together
- Invite them to a quick 15-minute call to explore collaboration

Make it personal and specific to their show.

Return format:
===SUBJECT===
[subject line here]
===BODY===
[email body here]"""


def _parse_response(text: str) -> tuple[str, str]:
    subject_match = re.search(r"===SUBJECT===\s*(.+?)(?====BODY===|$)", text, re.DOTALL)
    body_match = re.search(r"===BODY===\s*(.+?)$", text, re.DOTALL)
    subject = subject_match.group(1).strip() if subject_match else ""
    body = body_match.group(1).strip() if body_match else text.strip()
    return subject, body


def generate_email(podcast: dict, client: anthropic.Anthropic | None = None) -> dict:
    if client is None:
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            logger.error("ANTHROPIC_API_KEY not set")
            sys.exit(1)
        client = anthropic.Anthropic(api_key=api_key)

    host_name = podcast.get("host_name") or "there"
    podcast_name = podcast.get("title") or "your podcast"
    category = podcast.get("category") or "general"
    episode_count = podcast.get("total_episodes") or "many"

    user_prompt = USER_PROMPT_TEMPLATE.format(
        host_name=host_name,
        podcast_name=podcast_name,
        category=category,
        episode_count=episode_count,
    )

    try:
        message = client.messages.create(
            model=MODEL,
            max_tokens=300,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
        )
        raw = message.content[0].text
        subject, body = _parse_response(raw)

        return {
            "podcast_id": podcast.get("id") or podcast.get("podcast_id"),
            "podcast_name": podcast_name,
            "host_name": host_name,
            "to_email": podcast.get("contact_email"),
            "subject": subject,
            "body": body,
            "lead_score": podcast.get("lead_score"),
            "lead_tier": podcast.get("lead_tier"),
        }
    except Exception as e:
        logger.error(f"Email generation failed for {podcast_name}: {e}")
        raise


def generate_emails_bulk(podcasts: list[dict], max_emails: int = 20) -> list[dict]:
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        logger.error("ANTHROPIC_API_KEY not set")
        sys.exit(1)
    client = anthropic.Anthropic(api_key=api_key)

    results = []
    hot_leads = [p for p in podcasts if p.get("lead_tier") == "hot" and p.get("contact_email")][:max_emails]

    logger.info(f"Generating emails for {len(hot_leads)} hot leads")

    for i, podcast in enumerate(hot_leads, 1):
        try:
            email = generate_email(podcast, client)
            results.append(email)
            logger.info(f"  [{i}/{len(hot_leads)}] Generated: {email['podcast_name'][:50]}")
        except Exception:
            pass

    return results
