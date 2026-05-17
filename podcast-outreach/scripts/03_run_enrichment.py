#!/usr/bin/env python3
"""
Run the enrichment pipeline on exported podcasts.
Usage: python scripts/03_run_enrichment.py [--dry-run] [--limit N] [--csv path/to/file.csv]
"""
import sys
import argparse
import glob
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).parent.parent / "config" / ".env")

from rich.console import Console
from src.enrichment.enrichment_pipeline import run_pipeline

console = Console()


def latest_export() -> str | None:
    exports = sorted(glob.glob(
        str(Path(__file__).parent.parent / "data" / "exports" / "podcasts_for_enrichment_*.csv")
    ), reverse=True)
    return exports[0] if exports else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Run without writing to database")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of podcasts to process")
    parser.add_argument("--csv", type=str, default=None, help="Path to CSV file (default: latest export)")
    args = parser.parse_args()

    console.print("[bold cyan]Podcast Outreach — Enrichment Pipeline[/bold cyan]\n")

    csv_path = args.csv or latest_export()
    if not csv_path:
        console.print("[red]No export CSV found. Run script 02 first.[/red]")
        sys.exit(1)

    console.print(f"Using CSV: [dim]{csv_path}[/dim]")
    if args.limit:
        console.print(f"Limit: [dim]{args.limit} podcasts[/dim]")
    if args.dry_run:
        console.print("[yellow]Dry run — results saved to JSON but NOT written to database[/yellow]")

    output_dir = str(Path(__file__).parent.parent / "data" / "enrichment_results")
    results = run_pipeline(csv_path, output_dir, dry_run=args.dry_run, limit=args.limit)

    found = [r for r in results if r.get("enriched_fields")]
    console.print(f"\n[bold green]Done.[/bold green] {len(found)}/{len(results)} podcasts got new data.")
    console.print("Next step: run [bold]streamlit run src/dashboard/app.py[/bold] to review results.")


if __name__ == "__main__":
    main()
