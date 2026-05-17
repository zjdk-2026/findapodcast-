import re
import httpx
from bs4 import BeautifulSoup
from loguru import logger
from urllib.parse import urljoin, urlparse

_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
_TWITTER_RE = re.compile(r"(?:https?://)?(?:www\.)?(?:twitter|x)\.com/([A-Za-z0-9_]{1,15})")
_LINKEDIN_RE = re.compile(r"(?:https?://)?(?:www\.)?linkedin\.com/in/([A-Za-z0-9\-_%]+)")

_SKIP_EMAILS = {
    "example.com", "apple.com", "spotify.com", "podbean.com", "libsyn.com",
    "anchor.fm", "buzzsprout.com", "sentry.io", "wix.com", "squarespace.com",
}
_SKIP_HANDLES = {"home", "share", "intent", "twitter", "x", "search", "hashtag"}
_CONTACT_PATHS = ["/contact", "/contact-us", "/about", "/connect", "/work-with-me", "/reach-out"]

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; PodcastOutreachBot/1.0)"}


def _get_html(url: str, timeout: int = 12) -> str | None:
    try:
        r = httpx.get(url, timeout=timeout, follow_redirects=True, headers=HEADERS)
        if r.status_code == 200:
            return r.text
    except Exception as e:
        logger.debug(f"Fetch failed {url}: {e}")
    return None


def _extract_from_html(html: str, base_url: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    emails, twitters, linkedins = [], [], []

    for tag in soup.find_all("a", href=True):
        href = tag["href"]
        if href.startswith("mailto:"):
            email = href[7:].split("?")[0].strip().lower()
            if "@" in email and not any(s in email for s in _SKIP_EMAILS):
                emails.append(email)
        if "twitter.com" in href or "x.com" in href:
            m = _TWITTER_RE.search(href)
            if m and m.group(1).lower() not in _SKIP_HANDLES:
                twitters.append(f"https://twitter.com/{m.group(1)}")
        if "linkedin.com/in" in href:
            m = _LINKEDIN_RE.search(href)
            if m:
                linkedins.append(f"https://linkedin.com/in/{m.group(1)}")

    text_content = soup.get_text(" ")
    for email in _EMAIL_RE.findall(text_content):
        if not any(s in email for s in _SKIP_EMAILS):
            emails.append(email.lower())

    return {
        "emails": list(dict.fromkeys(emails)),
        "twitters": list(dict.fromkeys(twitters)),
        "linkedins": list(dict.fromkeys(linkedins)),
    }


def scrape_website(website_url: str, timeout: int = 12) -> dict:
    result = {"email": None, "twitter": None, "linkedin": None, "source": "website"}

    if not website_url:
        return result

    parsed = urlparse(website_url)
    base = f"{parsed.scheme}://{parsed.netloc}"

    pages_to_try = [website_url] + [urljoin(base, p) for p in _CONTACT_PATHS]
    all_emails, all_twitters, all_linkedins = [], [], []

    for url in pages_to_try:
        html = _get_html(url, timeout)
        if not html:
            continue
        found = _extract_from_html(html, url)
        all_emails.extend(found["emails"])
        all_twitters.extend(found["twitters"])
        all_linkedins.extend(found["linkedins"])
        if all_emails:
            break

    if all_emails:
        result["email"] = all_emails[0]
    if all_twitters:
        result["twitter"] = all_twitters[0]
    if all_linkedins:
        result["linkedin"] = all_linkedins[0]

    return result
