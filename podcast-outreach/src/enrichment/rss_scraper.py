import re
import feedparser
import httpx
from loguru import logger

_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
_TWITTER_RE = re.compile(r"(?:https?://)?(?:www\.)?twitter\.com/([A-Za-z0-9_]{1,15})")
_LINKEDIN_RE = re.compile(r"(?:https?://)?(?:www\.)?linkedin\.com/in/([A-Za-z0-9\-_%]+)")


def scrape_rss(rss_url: str, timeout: int = 15) -> dict:
    result = {"email": None, "website": None, "twitter": None, "linkedin": None, "host_name": None, "source": "rss"}

    if not rss_url:
        return result

    try:
        resp = httpx.get(rss_url, timeout=timeout, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        raw_xml = resp.text
    except Exception as e:
        logger.warning(f"RSS fetch failed for {rss_url}: {e}")
        return result

    feed = feedparser.parse(raw_xml)

    itunes_owner_email = feed.feed.get("itunes_owner", {}).get("email") if hasattr(feed.feed, "get") else None
    if itunes_owner_email:
        result["email"] = itunes_owner_email.strip().lower()

    if not result["email"]:
        channel_email = feed.feed.get("itunes_email") or feed.feed.get("author_detail", {}).get("email")
        if channel_email:
            result["email"] = channel_email.strip().lower()

    host_name = feed.feed.get("itunes_owner", {}).get("name") if hasattr(feed.feed, "get") else None
    if host_name:
        result["host_name"] = host_name.strip()

    website = feed.feed.get("link") or feed.feed.get("href")
    if website and not website.startswith("http://feeds") and not website.startswith("https://feeds"):
        result["website"] = website

    for link in feed.feed.get("links", []):
        href = link.get("href", "")
        if "twitter.com" in href:
            m = _TWITTER_RE.search(href)
            if m:
                result["twitter"] = f"https://twitter.com/{m.group(1)}"
        if "linkedin.com/in" in href:
            m = _LINKEDIN_RE.search(href)
            if m:
                result["linkedin"] = f"https://linkedin.com/in/{m.group(1)}"

    if not result["email"]:
        text_blob = " ".join([
            feed.feed.get("description", ""),
            feed.feed.get("summary", ""),
        ])
        emails = _EMAIL_RE.findall(text_blob)
        skip = {"example.com", "apple.com", "spotify.com", "podbean.com", "libsyn.com", "anchor.fm", "buzzsprout.com"}
        for email in emails:
            if not any(s in email for s in skip):
                result["email"] = email.lower()
                break

    return result
