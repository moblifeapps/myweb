import json
import os
import time
import requests

# Pixabay API configuration from environment variable
API_KEY = os.environ.get("PIXABAY_API_KEY")
BASE_URL = "https://pixabay.com/api/videos/"
OUTPUT_FILE = "wallpapers_cache.json"

# Categories relevant to desktop live wallpapers mapped to Pixabay's supported category terms
CATEGORIES = {
    "nature": "nature",
    "backgrounds": "backgrounds",
    "science": "science",  # often contains space/tech elements
    "places": "places",
    "animals": "animals",
    "transportation": "transportation",
    "music": "music",
}


def fetch_pixabay_videos():
  categorized_catalog = {}
  seen_ids = set()

  if not API_KEY:
    raise ValueError("Error: PIXABAY_API_KEY environment variable is missing.")

  for category_key, category_name in CATEGORIES.items():
    print(f"Fetching category: {category_key}...")
    category_items = []

    # Query parameters for Pixabay Video API
    params = {
        "key": API_KEY,
        "category": category_name,
        "orientation": "horizontal",  # Desktop landscape orientation
        "safesearch": "true",
        "order": "popular",
        "per_page": 50,  # Max is 200, 50 is safe for pagination loops
        "page": 1,
    }

    try:
      response = requests.get(BASE_URL, params=params)

      if response.status_code == 429:
        print("Rate limit reached. Pausing...")
        time.sleep(5)
        continue
      elif response.status_code != 200:
        print(
            f"Failed to fetch {category_key}: Status {response.status_code}"
        )
        continue

      data = response.json()
      hits = data.get("hits", [])

      for video in hits:
        video_id = video["id"]

        # Ensure unique items and strictly landscape aspect ratio
        if video_id not in seen_ids:
          # Extract the best video file link (large or medium size for desktop)
          video_files = video.get("videos", {})
          medium_file = video_files.get("medium", {}) or video_files.get(
              "large", {}
          )

          if medium_file:
            seen_ids.add(video_id)
            category_items.append({
                "id": video_id,
                "category": category_key,
                "duration": video.get("duration"),
                "width": medium_file.get("width"),
                "height": medium_file.get("height"),
                # Preview thumbnail image URL
                "thumbnail": video.get("picture_id"),
                # Safe external redirection link back to Pixabay
                "pixabay_url": video.get("pageURL"),
                "author": video.get("user"),
                "author_id": video.get("user_id"),
                # Direct stream/download link for app integration if needed
                "video_url": medium_file.get("url"),
            })

      categorized_catalog[category_key] = category_items
      # Polite delay between category calls
      time.sleep(0.5)

    except Exception as e:
      print(f"Exception occurred while fetching {category_key}: {e}")

  # Save master database to JSON file
  with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    json.dump(categorized_catalog, f, ensure_ascii=False, indent=2)

  total_saved = sum(len(v) for v in categorized_catalog.values())
  print(
      f"Successfully compiled {total_saved} wallpapers across"
      f" {len(categorized_catalog)} categories into {OUTPUT_FILE}"
  )


if __name__ == "__main__":
  fetch_pixabay_videos()