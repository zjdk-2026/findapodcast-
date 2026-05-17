import base64
import os
import sys
from email.mime.text import MIMEText
from loguru import logger


def create_draft(service, to: str, subject: str, body: str, from_email: str) -> str | None:
    message = MIMEText(body)
    message["to"] = to
    message["from"] = from_email
    message["subject"] = subject

    raw = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")

    try:
        draft = service.users().drafts().create(
            userId="me",
            body={"message": {"raw": raw}},
        ).execute()
        return draft["id"]
    except Exception as e:
        logger.error(f"Failed to create draft for {to}: {e}")
        return None


def create_drafts_bulk(service, emails: list[dict]) -> dict:
    from_email = os.getenv("GMAIL_FROM")
    if not from_email:
        logger.error("GMAIL_FROM not set in .env")
        sys.exit(1)

    created = 0
    failed = 0

    for i, email in enumerate(emails, 1):
        to = email.get("to_email")
        subject = email.get("subject", "")
        body = email.get("body", "")

        if not to:
            logger.warning(f"Skipping email #{i} — no to_email: {email.get('podcast_name')}")
            failed += 1
            continue

        draft_id = create_draft(service, to, subject, body, from_email)
        if draft_id:
            created += 1
            logger.info(f"  [{i}/{len(emails)}] Draft created: {email.get('podcast_name', to)[:50]}")
        else:
            failed += 1

    logger.success(f"Created {created} drafts. Review them in Gmail before sending.")
    if failed:
        logger.warning(f"{failed} drafts failed to create.")

    return {"created": created, "failed": failed}
