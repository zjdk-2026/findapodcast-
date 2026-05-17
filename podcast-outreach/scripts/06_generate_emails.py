#!/usr/bin/env python3
"""
Generate personalized outreach emails for hot leads using Claude API.
Usage: python scripts/06_generate_emails.py [--dry-run] [--max-emails N]
"""
import sys
import json
import argparse
import glob
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).parent.parent / "config" / ".env")

import pandas as pd
from rich.console import Console
from rich.table import Table

from src.outreach.email_generator import generate_emails_bulk

console = Console()

MAX_EMAILS_PER_RUN = 20


def latest_scored() -> pd.DataFrame | None:
    files = sorted(glob.glob(
        str(Path(__file__).parent.parent / "data" / "exports" / "scored_leads_*.xlsx")
    ), reverse=True)
    if files:
        return pd.read_excel(files[0])
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Print generated emails without saving")
    parser.add_argument("--max-emails", type=int, default=MAX_EMAILS_PER_RUN)
    args = parser.parse_args()

    console.print("[bold cyan]Podcast Outreach — Email Generation[/bold cyan]\n")

    import os
    if not os.getenv("ANTHROPIC_API_KEY"):
        console.print("[red]ANTHROPIC_API_KEY not set in config/.env[/red]")
        sys.exit(1)

    df = latest_scored()
    if df is None:
        console.print("[red]No scored leads found. Run script 05 first.[/red]")
        sys.exit(1)

    podcasts = df.to_dict("records")
    hot_with_email = [p for p in podcasts if p.get("lead_tier") == "hot" and p.get("contact_email")]
    console.print(f"Hot leads with email: [bold]{len(hot_with_email)}[/bold]")
    console.print(f"Generating up to [bold]{args.max_emails}[/bold] emails...\n")

    emails = generate_emails_bulk(podcasts, max_emails=args.max_emails)

    if not emails:
        console.print("[yellow]No emails generated.[/yellow]")
        sys.exit(0)

    preview_table = Table("Podcast", "To", "Subject", title="Generated Emails")
    for e in emails[:5]:
        preview_table.add_row(
            (e.get("podcast_name") or "")[:35],
            (e.get("to_email") or "")[:30],
            (e.get("subject") or "")[:40],
        )
    console.print(preview_table)
    if len(emails) > 5:
        console.print(f"[dim]... and {len(emails) - 5} more[/dim]")

    if not args.dry_run:
        date_str = datetime.now().strftime("%Y-%m-%d")
        output_dir = Path(__file__).parent.parent / "data" / "email_drafts"
        output_dir.mkdir(parents=True, exist_ok=True)
        out_path = output_dir / f"emails_{date_str}.json"

        with open(out_path, "w") as f:
            json.dump(emails, f, indent=2, default=str)

        console.print(f"\n[bold green]Saved {len(emails)} emails to:[/bold green] {out_path}")
        console.print("Next step: run [bold]python scripts/07_create_gmail_drafts.py[/bold]")
    else:
        console.print("\n[yellow]Dry run — showing first email body:[/yellow]")
        if emails:
            console.print(f"\nSubject: {emails[0].get('subject')}")
            console.print(f"\n{emails[0].get('body')}")


if __name__ == "__main__":
    main()
