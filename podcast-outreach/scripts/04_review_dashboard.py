#!/usr/bin/env python3
"""
Launch the quality control dashboard.
Usage: python scripts/04_review_dashboard.py
"""
import os
import sys
import subprocess
from pathlib import Path


def main():
    dashboard_path = Path(__file__).parent.parent / "src" / "dashboard" / "app.py"
    print(f"Launching dashboard: {dashboard_path}")
    print("Open http://localhost:8501 in your browser\n")

    try:
        subprocess.run(
            [sys.executable, "-m", "streamlit", "run", str(dashboard_path)],
            check=True,
        )
    except KeyboardInterrupt:
        print("\nDashboard stopped.")
    except FileNotFoundError:
        print("streamlit not found. Install it: pip install streamlit")
        sys.exit(1)


if __name__ == "__main__":
    main()
