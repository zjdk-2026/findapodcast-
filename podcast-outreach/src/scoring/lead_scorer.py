import os
import yaml
from datetime import datetime, timezone
from pathlib import Path

_CATEGORIES_PATH = Path(__file__).parent.parent.parent / "config" / "categories.yaml"


def _load_priority_categories() -> set[str]:
    env_cats = os.getenv("PRIORITY_CATEGORIES", "")
    if env_cats:
        return {c.strip().lower() for c in env_cats.split(",")}

    if _CATEGORIES_PATH.exists():
        with open(_CATEGORIES_PATH) as f:
            cfg = yaml.safe_load(f)
        return {c.lower() for c in cfg.get("priority_categories", [])}

    return set()


def _load_skip_categories() -> set[str]:
    if _CATEGORIES_PATH.exists():
        with open(_CATEGORIES_PATH) as f:
            cfg = yaml.safe_load(f)
        return {c.lower() for c in cfg.get("skip_categories", [])}
    return set()


def score_podcast(podcast: dict) -> dict:
    score = 0
    breakdown = []

    if podcast.get("contact_email"):
        score += 3
        breakdown.append("has email (+3)")

    if podcast.get("linkedin_url"):
        score += 2
        breakdown.append("has LinkedIn (+2)")

    if podcast.get("instagram_url") or podcast.get("twitter_url"):
        score += 1
        breakdown.append("has Twitter/Instagram (+1)")

    episodes = podcast.get("total_episodes") or 0
    if episodes >= 50:
        score += 2
        breakdown.append("50+ episodes (+2)")
    elif episodes >= 20:
        score += 1
        breakdown.append("20+ episodes (+1)")

    priority_cats = _load_priority_categories()
    category = (podcast.get("category") or "").lower()
    niche_tags = [t.lower() for t in (podcast.get("niche_tags") or [])]
    all_tags = {category} | set(niche_tags)

    if priority_cats and all_tags & priority_cats:
        score += 1
        breakdown.append("priority category (+1)")

    last_ep = podcast.get("last_episode_date")
    if last_ep:
        if isinstance(last_ep, str):
            try:
                last_ep = datetime.fromisoformat(last_ep).replace(tzinfo=timezone.utc)
            except ValueError:
                last_ep = None
        if last_ep:
            now = datetime.now(timezone.utc)
            days_since = (now - last_ep).days if hasattr(last_ep, "days") else None
            if days_since is not None and days_since <= 60:
                score += 1
                breakdown.append("active last 60d (+1)")

    skip_cats = _load_skip_categories()
    if all_tags & skip_cats:
        score = 0
        breakdown = ["skip category (score zeroed)"]

    if score >= 8:
        tier = "hot"
    elif score >= 5:
        tier = "warm"
    elif score >= 3:
        tier = "cold"
    else:
        tier = "skip"

    return {
        **podcast,
        "lead_score": score,
        "lead_tier": tier,
        "score_breakdown": "; ".join(breakdown),
    }


def score_all(podcasts: list[dict]) -> list[dict]:
    scored = [score_podcast(p) for p in podcasts]
    scored.sort(key=lambda x: x["lead_score"], reverse=True)
    return scored
