#!/usr/bin/env python3
"""
Export podcasts from the database for enrichment.
Usage: python scripts/02_export_for_enrichment.py [--dry-run]
"""
import sys
import argparse
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).parent.parent / "config" / ".env")

import pandas as pd
from sqlalchemy import text
from rich.console import Console
from rich.table import Table

from src.db.connect import get_engine

console = Console()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Print stats without saving CSV")
    args = parser.parse_args()

    console.print("[bold cyan]Podcast Outreach — Export for Enrichment[/bold cyan]\n")

    engine = get_engine()
    with engine.connect() as conn:
        result = conn.execute(text("""
            SELECT
                id as podcast_id,
                title as name,
                NULL as rss_feed,
                website,
                host_name,
                contact_email,
                instagram_url as twitter,
                linkedin_url,
                category,
                total_episodes as episode_count,
                last_episode_date as last_updated,
                enriched_at,
                listen_score
            FROM podcasts
            ORDER BY listen_score DESC NULLS LAST
        """))
        df = pd.DataFrame(result.mappings().all())

    total = len(df)
    has_email = df["contact_email"].notna().sum()
    has_linkedin = df["linkedin_url"].notna().sum()
    has_twitter = df["twitter"].notna().sum()
    has_website = df["website"].notna().sum()

    stats = Table("Metric", "Count", "%", title="Current Data Completeness")
    stats.add_row("Total podcasts", str(total), "100%")
    stats.add_row("With email", str(has_email), f"{has_email/total*100:.1f}%" if total else "0%")
    stats.add_row("With LinkedIn", str(has_linkedin), f"{has_linkedin/total*100:.1f}%" if total else "0%")
    stats.add_row("With Twitter/Instagram", str(has_twitter), f"{has_twitter/total*100:.1f}%" if total else "0%")
    stats.add_row("With website", str(has_website), f"{has_website/total*100:.1f}%" if total else "0%")
    console.print(stats)

    df["needs_enrichment"] = (
        df["contact_email"].isna() | df["linkedin_url"].isna()
    ).astype(str)

    if not args.dry_run:
        date_str = datetime.now().strftime("%Y-%m-%d")
        output_dir = Path(__file__).parent.parent / "data" / "exports"
        output_dir.mkdir(parents=True, exist_ok=True)
        out_path = output_dir / f"podcasts_for_enrichment_{date_str}.csv"
        df.to_csv(out_path, index=False)
        console.print(f"\n[bold green]Saved:[/bold green] {out_path}")
        console.print(f"[dim]{len(df)} total podcasts exported[/dim]")
    else:
        console.print("\n[yellow]Dry run — no file saved[/yellow]")


if __name__ == "__main__":
    main()
