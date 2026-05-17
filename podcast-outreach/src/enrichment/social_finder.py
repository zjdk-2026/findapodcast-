import os
import re
import httpx
from loguru import logger

_TWITTER_RE = re.compile(r"(?:https?://)?(?:www\.)?(?:twitter|x)\.com/([A-Za-z0-9_]{1,15})")
_LINKEDIN_RE = re.compile(r"(?:https?://)?(?:www\.)?linkedin\.com/in/([A-Za-z0-9\-_%]+)")
_SKIP_HANDLES = {"home", "share", "intent", "twitter", "x", "search", "hashtag", "status"}

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; PodcastOutreachBot/1.0)"}


def _google_search(query: str, api_key: str, cx: str) -> list[str]:
    try:
        r = httpx.get(
            "https://www.googleapis.com/customsearch/v1",
            params={"q": query, "key": api_key, "cx": cx, "num": 5},
            timeout=10,
            headers=HEADERS,
        )
        r.raise_for_status()
        items = r.json().get("items", [])
        return [item.get("link", "") for item in items]
    except Exception as e:
        logger.warning(f"Google search failed for '{query}': {e}")
        return []


def find_socials(podcast_name: str, host_name: str | None = None) -> dict:
    result = {"twitter": None, "linkedin": None, "source": "social_finder"}

    api_key = os.getenv("GOOGLE_SEARCH_API_KEY")
    cx = os.getenv("GOOGLE_SEARCH_CX")

    if not api_key or not cx:
        logger.debug("GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_CX not set — skipping social finder")
        return result

    search_name = host_name or podcast_name

    twitter_query = f'"{search_name}" podcast twitter.com OR x.com'
    linkedin_query = f'"{search_name}" podcast host site:linkedin.com/in'

    twitter_urls = _google_search(twitter_query, api_key, cx)
    for url in twitter_urls:
        m = _TWITTER_RE.search(url)
        if m and m.group(1).lower() not in _SKIP_HANDLES:
            result["twitter"] = f"https://twitter.com/{m.group(1)}"
            break

    linkedin_urls = _google_search(linkedin_query, api_key, cx)
    for url in linkedin_urls:
        m = _LINKEDIN_RE.search(url)
        if m:
            result["linkedin"] = f"https://linkedin.com/in/{m.group(1)}"
            break

    return result
