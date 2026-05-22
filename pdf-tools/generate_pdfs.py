#!/usr/bin/env python3
"""
PDF Generator for Find A Podcast - Media Pack & Story Arc
Uses Playwright to convert HTML templates to high-quality PDFs
"""

import asyncio
from pathlib import Path
from playwright.async_api import async_playwright

# Paths
BASE_DIR = Path(__file__).parent
TEMPLATES_DIR = BASE_DIR / "templates"
OUTPUT_DIR = BASE_DIR / "output"

# Ensure output directory exists
OUTPUT_DIR.mkdir(exist_ok=True)

async def generate_pdf(html_file: Path, output_file: Path, print_background: bool = True):
    """
    Convert HTML file to PDF using Playwright/Chromium
    
    Args:
        html_file: Path to HTML template
        output_file: Path for output PDF
        print_background: Whether to print background graphics
    """
    print(f"📄 Generating PDF from {html_file.name}...")
    
    async with async_playwright() as p:
        # Launch browser
        browser = await p.chromium.launch()
        page = await browser.new_page()
        
        # Load HTML file
        html_path = f"file://{html_file.absolute()}"
        await page.goto(html_path)
        
        # Wait for fonts and images to load
        await page.wait_for_load_state("networkidle")
        
        # Generate PDF with print settings
        await page.pdf(
            path=str(output_file),
            format="Letter",
            print_background=print_background,
            margin={
                "top": "0.75in",
                "right": "0.75in",
                "bottom": "0.75in",
                "left": "0.75in"
            },
            prefer_css_page_size=True,
            display_header_footer=False,
        )
        
        await browser.close()
    
    # Check file size
    size_mb = output_file.stat().st_size / (1024 * 1024)
    print(f"✅ Generated: {output_file.name} ({size_mb:.2f} MB)")
    
    return output_file


async def main():
    """Generate all PDFs"""
    print("🚀 Find A Podcast - PDF Generator")
    print("=" * 50)
    
    pdfs_to_generate = [
        {
            "html": TEMPLATES_DIR / "client-proposal-v2.html",
            "pdf": OUTPUT_DIR / "find-a-podcast-client-proposal.pdf",
            "name": "Client Proposal (10/10 Version)"
        },
        {
            "html": TEMPLATES_DIR / "story-arc-zac-deane.html",
            "pdf": OUTPUT_DIR / "zac-deane-story-arc.pdf",
            "name": "Zac Deane Story Arc"
        },
        {
            "html": TEMPLATES_DIR / "media-pack.html",
            "pdf": OUTPUT_DIR / "podcast-tour-media-pack-v1.pdf",
            "name": "Media Pack (Original - 7.5/10)"
        }
    ]
    
    for doc in pdfs_to_generate:
        if not doc["html"].exists():
            print(f"❌ Error: Template not found: {doc['html']}")
            continue
        
        print(f"\n📋 {doc['name']}")
        await generate_pdf(doc["html"], doc["pdf"])
    
    print("\n" + "=" * 50)
    print("✨ All PDFs generated successfully!")
    print(f"\n📂 Output directory: {OUTPUT_DIR.absolute()}")
    print("\nGenerated files:")
    for pdf_file in OUTPUT_DIR.glob("*.pdf"):
        size_mb = pdf_file.stat().st_size / (1024 * 1024)
        print(f"  • {pdf_file.name} ({size_mb:.2f} MB)")
    
    print("\n🌐 Preview HTML in browser first:")
    for doc in pdfs_to_generate:
        print(f"  file://{doc['html'].absolute()}")


if __name__ == "__main__":
    asyncio.run(main())
