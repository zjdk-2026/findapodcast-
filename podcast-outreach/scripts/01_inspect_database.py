#!/usr/bin/env python3
"""
Run this first to inspect your database schema and see what data you have.
Usage: python scripts/01_inspect_database.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).parent.parent / "config" / ".env")

from src.db.schema_inspector import inspect_schema, print_schema, generate_markdown_report
from rich.console import Console

console = Console()


def main():
    console.print("[bold cyan]Podcast Outreach — Database Inspector[/bold cyan]\n")

    schema = inspect_schema()

    print_schema(schema)

    report_path = str(Path(__file__).parent.parent / "data" / "exports" / "database_schema_report.md")
    generate_markdown_report(schema, report_path)

    console.print(f"\n[bold green]Report saved to:[/bold green] {report_path}")

    podcast_tables = [t for t in schema.keys() if "podcast" in t.lower()]
    if podcast_tables:
        console.print(f"\n[bold yellow]Podcast-related tables found:[/bold yellow] {', '.join(podcast_tables)}")
        for t in podcast_tables:
            info = schema[t]
            has_email = any(c["name"] in ("contact_email", "email", "host_email") for c in info["columns"])
            has_linkedin = any(c["name"] in ("linkedin_url", "linkedin") for c in info["columns"])
            has_twitter = any(c["name"] in ("twitter_url", "instagram_url", "twitter") for c in info["columns"])
            console.print(f"\n  [cyan]{t}[/cyan] ({info['row_count']} rows)")
            console.print(f"    Has email field: {'[green]YES[/green]' if has_email else '[red]NO[/red]'}")
            console.print(f"    Has LinkedIn field: {'[green]YES[/green]' if has_linkedin else '[red]NO[/red]'}")
            console.print(f"    Has Twitter field: {'[green]YES[/green]' if has_twitter else '[red]NO[/red]'}")


if __name__ == "__main__":
    main()
