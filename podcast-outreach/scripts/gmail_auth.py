#!/usr/bin/env python3
"""
One-time Gmail OAuth setup. Run this once to authorize access.
Usage: python scripts/gmail_auth.py
Requires: gmail_credentials.json from Google Cloud Console
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).parent.parent / "config" / ".env")

from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
import pickle

SCOPES = ["https://www.googleapis.com/auth/gmail.compose"]


def get_gmail_service():
    from googleapiclient.discovery import build

    creds_file = os.getenv("GMAIL_CREDENTIALS_FILE", "gmail_credentials.json")
    token_file = os.getenv("GMAIL_TOKEN_FILE", "gmail_token.json")

    base = Path(__file__).parent.parent
    creds_path = base / creds_file if not Path(creds_file).is_absolute() else Path(creds_file)
    token_path = base / token_file if not Path(token_file).is_absolute() else Path(token_file)

    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not creds_path.exists():
                print(f"ERROR: {creds_path} not found.")
                print("Download OAuth credentials from Google Cloud Console:")
                print("  APIs & Services → Credentials → OAuth 2.0 Client ID → Download JSON")
                sys.exit(1)
            flow = InstalledAppFlow.from_client_secrets_file(str(creds_path), SCOPES)
            creds = flow.run_local_server(port=0)

        with open(token_path, "w") as f:
            f.write(creds.to_json())
        print(f"Token saved to {token_path}")

    return build("gmail", "v1", credentials=creds)


if __name__ == "__main__":
    print("Gmail OAuth Setup")
    print("=================\n")
    service = get_gmail_service()
    profile = service.users().getProfile(userId="me").execute()
    print(f"Authorized as: {profile.get('emailAddress')}")
    print("Gmail API access confirmed. You can now run script 07.")
