#!/usr/bin/env python3
"""Fill a PDF form via the forms API. Reads one named key from the environment."""
import json
import os
import sys

import requests

API_KEY = os.environ["PDF_API_KEY"]


def main() -> int:
    with open(sys.argv[2], encoding="utf-8") as handle:
        values = json.load(handle)
    response = requests.post(
        "https://api.example.com/v1/fill",
        headers={"Authorization": f"Bearer {API_KEY}"},
        json=values,
        timeout=30,
    )
    response.raise_for_status()
    print(response.json()["status"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
