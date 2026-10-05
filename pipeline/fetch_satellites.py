"""Snapshot of Earth-satellite orbital elements from CelesTrak (OMM JSON, for SGP4).

The app loads this bundled snapshot and then asks CelesTrak for current elements,
keeping the snapshot when it cannot. Usage:

    python pipeline/fetch_satellites.py public/data/satellites.json
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone

GROUPS = ["stations", "visual", "gps-ops"]
URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP={}&FORMAT=json"
KEEP = [
    "OBJECT_NAME", "OBJECT_ID", "EPOCH", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION",
    "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "NORAD_CAT_ID", "BSTAR",
    "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT",
]


def fetch(group: str) -> list:
    for attempt in range(4):
        try:
            with urllib.request.urlopen(URL.format(group), timeout=60) as r:
                return json.load(r)
        except OSError as e:
            print(f"{group}: {e}; retrying", file=sys.stderr)
            time.sleep(2 ** attempt * 2)
    raise SystemExit(f"could not fetch {group}")


def main(out: str) -> None:
    objects = {}
    for group in GROUPS:
        for o in fetch(group):
            entry = objects.setdefault(o["NORAD_CAT_ID"], {k: o[k] for k in KEEP} | {"GROUPS": []})
            entry["GROUPS"].append(group)
    data = {
        "fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "source": "CelesTrak GP (" + ", ".join(GROUPS) + ")",
        "objects": sorted(objects.values(), key=lambda o: o["NORAD_CAT_ID"]),
    }
    with open(out, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"wrote {len(objects)} objects to {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "public/data/satellites.json")
