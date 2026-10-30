"""
Builds the two Desktop Live Wallpaper+ gallery catalogs from the Pixabay API:

  pixabay_videos.json   - landscape videos, every Pixabay category
  pixabay_photos.json   - landscape photos (wallpaper size), every Pixabay category

Run once a day by .github/workflows/update-pixabay-catalog.yml. Pixabay asks API users to refresh
results at most every 24 hours and not to keep files: the catalogs hold links only - nothing is
downloaded or stored here.

The pages read short keys to keep the files small:
  i id, c category, t tags, a author, u author id, p Pixabay page,
  th thumbnail, d duration (s), w/h size, f file to download, s its size (bytes)
  videos also: pv tiny preview video (hover), m small video (preview window)
  photos also: pw preview picture for the preview window
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

API_KEY = os.environ.get("PIXABAY_API_KEY")
VIDEO_URL = "https://pixabay.com/api/videos/"
PHOTO_URL = "https://pixabay.com/api/"

# Every category the Pixabay API supports (https://pixabay.com/api/docs/ - "category").
CATEGORIES = [
    "backgrounds", "nature", "places", "travel", "animals", "science", "music", "transportation",
    "buildings", "people", "feelings", "religion", "health", "food", "sports", "fashion",
    "education", "computer", "industry", "business",
]

PER_CATEGORY = int(os.environ.get("PIXABAY_PER_CATEGORY", "100"))   # items kept per category and type
PAGE_SIZE = 200                                                      # API maximum
PAUSE = 0.8                                                          # seconds between requests (limit ~100/min)


def get(url, params, tries=5):
    """One API request, with waits when Pixabay says "too many requests"."""
    for attempt in range(tries):
        try:
            r = requests.get(url, params=params, timeout=30)
        except requests.RequestException as e:
            print(f"  network error: {e} - retrying")
            time.sleep(3 * (attempt + 1))
            continue
        if r.status_code == 429:
            wait = int(r.headers.get("X-RateLimit-Reset", "0") or 0) or 15 * (attempt + 1)
            print(f"  rate limit - waiting {wait} s")
            time.sleep(wait)
            continue
        if r.status_code != 200:
            print(f"  HTTP {r.status_code}: {r.text[:200]}")
            return None
        return r.json()
    return None


def collect(url, category, extra, make_item, seen):
    """Up to PER_CATEGORY landscape items of one category (popular first), skipping ones already used."""
    items, page = [], 1
    while len(items) < PER_CATEGORY:
        params = {"key": API_KEY, "category": category, "orientation": "horizontal", "safesearch": "true",
                  "order": "popular", "per_page": PAGE_SIZE, "page": page, **extra}
        data = get(url, params)
        time.sleep(PAUSE)
        hits = (data or {}).get("hits", [])
        if not hits:
            break
        for hit in hits:
            if hit.get("id") in seen:
                continue
            item = make_item(hit, category)
            if item:
                seen.add(hit["id"])
                items.append(item)
                if len(items) >= PER_CATEGORY:
                    break
        if page * PAGE_SIZE >= min((data or {}).get("totalHits", 0), 600):
            break
        page += 1
    return items


def video_item(hit, category):
    v = hit.get("videos") or {}
    tiny, small, medium, large = (v.get(k) or {} for k in ("tiny", "small", "medium", "large"))
    best = large if large.get("url") else medium                  # 1920x1080 when there is one
    if not best.get("url"):
        return None
    if best.get("width", 0) < 1280 or best.get("width", 0) < best.get("height", 0):
        return None                                                # desktop: landscape, at least 720p
    return {
        "i": hit["id"], "c": category, "t": hit.get("tags", ""),
        "a": hit.get("user", ""), "u": hit.get("user_id"), "p": hit.get("pageURL", ""),
        "d": hit.get("duration", 0),
        "th": tiny.get("thumbnail") or small.get("thumbnail") or medium.get("thumbnail") or "",   # 640x360 - enough for a card
        "pv": tiny.get("url") or small.get("url") or "",
        "m": small.get("url") or medium.get("url") or "",
        "f": best["url"], "w": best.get("width"), "h": best.get("height"), "s": best.get("size", 0),
    }


def photo_item(hit, category):
    big = hit.get("largeImageURL")                                 # up to 1280 px (standard API access)
    web = hit.get("webformatURL", "")
    if not big or not web:
        return None
    return {
        "i": hit["id"], "c": category, "t": hit.get("tags", ""),
        "a": hit.get("user", ""), "u": hit.get("user_id"), "p": hit.get("pageURL", ""),
        "th": web.replace("_640.", "_340."),                       # 340 px wide - plenty for a card
        "pw": web,                                                 # 640 px - the preview window
        "f": big, "w": hit.get("imageWidth"), "h": hit.get("imageHeight"), "s": hit.get("imageSize", 0),
    }


def write(name, kind, items_by_cat):
    data = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "kind": kind,
        "source": "Pixabay (https://pixabay.com)",
        "categories": [c for c in CATEGORIES if items_by_cat.get(c)],
        "items": [it for c in CATEGORIES for it in items_by_cat.get(c, [])],
    }
    with open(name, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{name}: {len(data['items'])} {kind} in {len(data['categories'])} categories")
    return len(data["items"])


def main():
    if not API_KEY:
        sys.exit("PIXABAY_API_KEY is missing (repository secret).")

    videos, seen = {}, set()
    for cat in CATEGORIES:
        print(f"videos / {cat}")
        videos[cat] = collect(VIDEO_URL, cat, {"video_type": "film"}, video_item, seen)

    photos, seen = {}, set()
    for cat in CATEGORIES:
        print(f"photos / {cat}")
        photos[cat] = collect(PHOTO_URL, cat, {"image_type": "photo", "min_width": 1920, "min_height": 1080},
                              photo_item, seen)

    nv = write("pixabay_videos.json", "videos", videos)
    nphoto = write("pixabay_photos.json", "photos", photos)
    if nv == 0 or nphoto == 0:
        sys.exit("A catalog came out empty - not publishing it.")


if __name__ == "__main__":
    main()
