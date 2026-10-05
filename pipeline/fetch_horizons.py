"""Fetch independent reference positions from the JPL Horizons API.

The ephemeris test compares the app's positions against these, which checks the whole
chain (conversion, Chebyshev evaluation, segment chaining) against JPL's own service
rather than against the kernel we converted. Horizons currently uses DE441, which
agrees with DE440 to well under a metre over this range.

Usage:
    python pipeline/fetch_horizons.py tests/fixtures/horizons-reference.json
"""

import argparse
import json
import urllib.parse
import urllib.request

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
J2000_JD = 2451545.0

# NAIF ids the app draws (5..9 are system barycentres, as in the app).
BODIES = [10, 199, 299, 399, 301, 499, 5, 6, 7, 8, 9]
# Julian dates (TDB) spread across the bundled 1960-2060 range, including the Apollo 11
# landing and today.
EPOCHS = [2437000.5, 2440423.5, 2444000.25, 2447891.75, 2451545.0, 2455197.5, 2458849.125, 2461318.5, 2463000.5, 2466000.0, 2468000.5]


def fetch(body: int) -> list[dict]:
    params = {
        "format": "json",
        "COMMAND": f"'{body}'",
        "EPHEM_TYPE": "VECTORS",
        "CENTER": "'500@0'",
        "REF_PLANE": "FRAME",
        "REF_SYSTEM": "ICRF",
        "VEC_TABLE": "1",
        "OUT_UNITS": "KM-S",
        "TIME_TYPE": "TDB",
        "VEC_LABELS": "NO",
        "CSV_FORMAT": "YES",
        "TLIST": "'" + "' '".join(str(jd) for jd in EPOCHS) + "'",
    }
    url = API + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=60) as r:
        result = json.load(r)["result"]
    block = result.split("$$SOE")[1].split("$$EOE")[0]
    rows = []
    for line in block.strip().splitlines():
        fields = [f.strip() for f in line.split(",")]
        jd = float(fields[0])
        rows.append({"target": body, "tdb": (jd - J2000_JD) * 86400.0, "km": [float(v) for v in fields[2:5]]})
    if len(rows) != len(EPOCHS):
        raise RuntimeError(f"body {body}: expected {len(EPOCHS)} rows, got {len(rows)}\n{result[:2000]}")
    print(f"{body}: {len(rows)} epochs")
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    args = parser.parse_args()
    cases = [row for body in BODIES for row in fetch(body)]
    with open(args.out, "w") as f:
        json.dump({"source": "JPL Horizons API, vectors, ICRF, SSB centre, TDB", "cases": cases}, f, indent=0)
    print(f"wrote {args.out}: {len(cases)} positions")


if __name__ == "__main__":
    main()
