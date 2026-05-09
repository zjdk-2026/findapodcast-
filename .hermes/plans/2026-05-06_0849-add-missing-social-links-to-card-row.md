# Plan: Add Missing Social Links to Podcast Card Row

## Goal

All social links found via SGAI enrichment (Twitter/X, Facebook, LinkedIn, YouTube, TikTok, Booking Page) should show as clickable chips on the podcast card in the dashboard — not just in the expanded contact modal.

## Current State

**Card row chips (app.js lines 1779–1805):**
- Apple Podcasts — shown if apple_url valid
- Spotify — shown if spotify_url valid
- Website — shown if exists
- Badge block — DEAD CODE (always returns empty string since deep_enriched_at set for all podcasts)
- Instagram BETA — shown if valid profile
- Email — shown if not anchor.fm auto-generated

**Missing but available in DB (enriched):**
| Field | Coverage |
|-------|----------|
| twitter_url | 77/140 |
| facebook_url | 53/140 |
| linkedin_url / linkedin_page_url | some |
| youtube_url | 31/140 |
| tiktok_url | 12/140 |
| booking_page_url | 68/140 |

**Contact modal (lines 4212-4269) already shows all of these** in a "Social Media" section.

**CSS**: card-row-links has flex-wrap: wrap; gap: 5px — wrapping handles overflow.

## Approach

Replace the dead badge IIFE (lines 1783-1803) with card-link-chip elements for the missing social links. Use isValidSocialProfile() for platform URLs and isValidUrl() for booking_page_url. Match existing chip aesthetic.

## Step-by-Step

### Step 1 — Remove dead badge code
Delete lines 1783–1803 entirely (the IIFE):
- Remove hasSiteOrDir check
- Remove missingSocial check across 6 platforms
- Remove deep_enriched_at conditional
- Remove all badge HTML (dead code)

### Step 2 — Insert missing social chips
Between Instagram BETA chip (line 1804) and Email chip (line 1805), insert chips for these 6 fields, each using the same card-link-chip pattern as Instagram:

1. **Twitter/X** — isValidSocialProfile(podcast.twitter_url, 'twitter')
2. **Facebook** — isValidSocialProfile(podcast.facebook_url, 'facebook')
3. **LinkedIn** — isValidSocialProfile(podcast.linkedin_page_url || podcast.linkedin_url, 'linkedin')
4. **YouTube** — isValidSocialProfile(podcast.youtube_url, 'youtube')
5. **TikTok** — isValidUrl(podcast.tiktok_url) (same pattern as contact modal line 4218)
6. **Booking Page** — isValidUrl(podcast.booking_page_url)

Each chip uses: a class="card-link-chip" href=... target="_blank" rel="noopener" with the platform name as text. No SVG icons for simplicity (keep consistent with existing pattern).

### Step 3 — Commit and deploy
- git add + commit with message like "add missing social link chips to podcast cards"
- git push origin master
- Railway auto-deploys

### Step 4 — Verify
- Open dashboard at findapodcast.io/dashboard/[...]
- Confirm Twitter/X, Facebook, LinkedIn, YouTube, TikTok, Booking Page chips appear on enriched cards
- Confirm chips are clickable and open in new tab
- Confirm cards without certain fields don't show empty chips (validation handles this)

## Files Changed

| File | Change |
|------|--------|
| `/tmp/findapodcast-/dashboard/app.js` | Lines 1783–1803: replace badge IIFE with 6 new social chips |
| (No CSS changes needed — existing card-link-chip styles work) |

## Risks & Tradeoffs

- **Card height increase**: Adding up to 6 more chips per card (on top of existing 4-6) could make cards 2-3 lines taller. flex-wrap handles this, but the card layout may feel denser. Acceptable trade-off for data visibility.
- **Booking Page as chip**: booking_page_url is currently only in the contact modal. Adding as a chip makes it instantly reachable.
- **No icons**: The chips use text-only like "Instagram BETA" already does. Could add SVG icons later as a refinement.
- **TikTok uses isValidUrl** (not isValidSocialProfile for 'tiktok') — matching the pattern at line 4218, since there's no 'tiktok' case in isValidSocialProfile.
