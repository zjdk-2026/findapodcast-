import json
import os
import time
from datetime import datetime
from pathlib import Path

import pandas as pd
from loguru import logger
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeElapsedColumn

from .rss_scraper import scrape_rss
from .website_scraper import scrape_website
from .social_finder import find_socials

DELAY_MS = int(os.getenv("SCRAPING_DELAY_MS", "500")) / 1000


def _merge(base: dict, update: dict) -> dict:
    for k, v in update.items():
        if v and not base.get(k):
            base[k] = v
    return base


def enrich_podcast(podcast: dict) -> dict:
    result = {
        "podcast_id": podcast.get("id") or podcast.get("podcast_id"),
        "title": podcast.get("title"),
        "email": None,
        "website": None,
        "twitter": None,
        "linkedin": None,
        "host_name": None,
        "enriched_fields": [],
        "source": None,
    }

    rss_url = podcast.get("rss_feed") or podcast.get("rss_url")
    website = podcast.get("website")
    title = podcast.get("title", "")
    host = podcast.get("host_name")

    rss_data = scrape_rss(rss_url) if rss_url else {}
    _merge(result, rss_data)
    time.sleep(DELAY_MS)

    if not result["email"] or not result["website"]:
        site = website or result.get("website")
        if site:
            web_data = scrape_website(site)
            _merge(result, web_data)
            time.sleep(DELAY_MS)

    if not result["twitter"] or not result["linkedin"]:
        social_data = find_socials(title, host)
        _merge(result, social_data)
        time.sleep(DELAY_MS)

    enriched = []
    for field in ("email", "website", "twitter", "linkedin", "host_name"):
        if result[field] and not podcast.get(field):
            enriched.append(field)
    result["enriched_fields"] = enriched

    return result


def run_pipeline(csv_path: str, output_dir: str, dry_run: bool = False, limit: int | None = None) -> list[dict]:
    df = pd.read_csv(csv_path)
    if limit:
        df = df.head(limit)

    needs_enrichment = df[
        df["contact_email"].isna() | df["contact_email"].eq("") |
        df["linkedin_url"].isna() | df["linkedin_url"].eq("")
    ].copy()

    logger.info(f"Enriching {len(needs_enrichment)} podcasts (dry_run={dry_run})")

    results = []
    failed = []

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total}"),
        TimeElapsedColumn(),
    ) as progress:
        task = progress.add_task("Enriching podcasts...", total=len(needs_enrichment))

        for _, row in needs_enrichment.iterrows():
            try:
                enriched = enrich_podcast(row.to_dict())
                results.append(enriched)
                if enriched["enriched_fields"]:
                    progress.console.print(
                        f"  [green]✓[/green] {enriched['title'][:50]} → {', '.join(enriched['enriched_fields'])}"
                    )
            except Exception as e:
                logger.error(f"Failed enriching {row.get('title', row.get('id', ''))}: {e}")
                failed.append({"id": row.get("id"), "error": str(e)})

            progress.advance(task)

    os.makedirs(output_dir, exist_ok=True)
    date_str = datetime.now().strftime("%Y-%m-%d")
    out_path = os.path.join(output_dir, f"batch_{date_str}.json")

    with open(out_path, "w") as f:
        json.dump(results, f, indent=2, default=str)

    logger.success(f"Saved {len(results)} results to {out_path}")
    if failed:
        logger.warning(f"{len(failed)} podcasts failed enrichment")

    found = [r for r in results if r["enriched_fields"]]
    logger.info(f"New data found for {len(found)} / {len(results)} podcasts")

    return results
