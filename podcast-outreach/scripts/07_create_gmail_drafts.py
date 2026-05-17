#!/usr/bin/env python3
"""
Save generated emails as Gmail drafts for manual review before sending.
Usage: python scripts/07_create_gmail_drafts.py [--dry-run] [--json path/to/emails.json]
"""
import sys
import json
import argparse
import glob
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).parent.parent / "config" / ".env")

from rich.console import Console
from src.outreach.gmail_drafts import create_drafts_bulk
from scripts.gmail_auth import get_gmail_service

console = Console()


def latest_emails() -> str | None:
    files = sorted(glob.glob(
        str(Path(__file__).parent.parent / "data" / "email_drafts" / "emails_*.json")
    ), reverse=True)
    return files[0] if files else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Print emails without creating drafts")
    parser.add_argument("--json", type=str, default=None, help="Path to emails JSON (default: latest)")
    args = parser.parse_args()

    console.print("[bold cyan]Podcast Outreach — Create Gmail Drafts[/bold cyan]\n")

    json_path = args.json or latest_emails()
    if not json_path:
        console.print("[red]No email drafts JSON found. Run script 06 first.[/red]")
        sys.exit(1)

    with open(json_path) as f:
        emails = json.load(f)

    console.print(f"Loading {len(emails)} emails from: [dim]{json_path}[/dim]")

    if args.dry_run:
        console.print("\n[yellow]Dry run — showing first 3 emails:[/yellow]\n")
        for e in emails[:3]:
            console.print(f"[bold]To:[/bold] {e.get('to_email')}")
            console.print(f"[bold]Subject:[/bold] {e.get('subject')}")
            console.print(f"[bold]Body:[/bold]\n{e.get('body')}\n")
            console.print("---")
        return

    console.print("Authorizing Gmail...")
    service = get_gmail_service()

    results = create_drafts_bulk(service, emails)
    console.print(
        f"\n[bold green]Done.[/bold green] Created {results['created']} drafts. "
        "Review and send manually in Gmail."
    )


if __name__ == "__main__":
    main()
