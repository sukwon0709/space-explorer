"""NASA's published path of totality for a solar eclipse, as a test fixture.

Usage:
    python pipeline/fetch_eclipse.py tests/fixtures/eclipse-2027-08-02.json

Parses Fred Espenak's path table (NASA GSFC eclipse web site): northern and southern
limits and the central line every two minutes, the central duration, and the value of
Delta T (TT - UT1) the predictions assume. Also records IERS Bulletin A's predicted
UT1 - UTC for the day, which the app's Earth orientation follows, so the test can
compare like with like.
"""

import argparse
import html
import json
import re
import urllib.request

URL = "https://eclipse.gsfc.nasa.gov/SEpath/SEpath2001/SE2027Aug02Tpath.html"
IERS = "https://datacenter.iers.org/data/latestVersion/finals.data.iau2000.txt"
DATE = "2027-08-02"


def angle(deg, minutes, hemi):
    v = int(deg) + float(minutes) / 60
    return -v if hemi in "SW" else v


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out")
    args = parser.parse_args()
    with urllib.request.urlopen(URL, timeout=120) as r:
        text = html.unescape(re.sub(r"<[^>]+>", "", r.read().decode("latin-1")))
    point = r"(\d+) (\d+\.\d)([NS]) (\d+) (\d+\.\d)([EW])"
    rows = []
    for m in re.finditer(rf"^ (\d\d):(\d\d)   {point}  {point}  {point}  (\d\.\d+) +(\d+) +(\d+) +(\d+) +(\d+)m(\d+\.\d)s", text, flags=re.M):
        g = m.groups()
        rows.append({
            "utc": f"{DATE}T{g[0]}:{g[1]}:00Z",
            "north": [angle(*g[2:5]), angle(*g[5:8])],
            "south": [angle(*g[8:11]), angle(*g[11:14])],
            "central": [angle(*g[14:17]), angle(*g[17:20])],
            "width_km": int(g[23]),
            "duration_s": int(g[24]) * 60 + float(g[25]),
        })
    delta_t = float(re.search(r"T\s*=\s*([\d.]+)\s*seconds", text).group(1))
    ge = re.search(r"Greatest Eclipse:\s+Time =\s+(\d\d):(\d\d):([\d.]+) UT\s+Lat =\s+(\d+)°([\d.]+)'([NS])\s+Long =\s+(\d+)°([\d.]+)'([EW])", text)
    dur = re.search(r"Central Duration =\s+(\d+)m([\d.]+)s", text)
    with urllib.request.urlopen(IERS, timeout=120) as r:
        finals = r.read().decode()
    yy, mm, dd = DATE[2:4], int(DATE[5:7]), int(DATE[8:10])
    line = next(l for l in finals.splitlines() if l[:6] == f"{yy}{mm:2d}{dd:2d}")
    ut1_utc = float(line[58:68])
    out = {
        "source": URL,
        "ephemerides": "VSOP87/ELP2000-85 (Espenak)",
        "delta_t": delta_t,
        "lunar_radius_k": 0.272281,
        "iers_ut1_utc": ut1_utc,
        "iers_source": IERS,
        "greatest": {
            "utc": f"{DATE}T{ge.group(1)}:{ge.group(2)}:{float(ge.group(3)):04.1f}Z",
            "lat": angle(ge.group(4), ge.group(5), ge.group(6)),
            "lon": angle(ge.group(7), ge.group(8), ge.group(9)),
            "duration_s": int(dur.group(1)) * 60 + float(dur.group(2)),
        },
        "path": rows,
    }
    with open(args.out, "w") as f:
        json.dump(out, f, indent=1)
    print(f"wrote {args.out}: {len(rows)} rows, delta T {delta_t} s, greatest {out['greatest']}")


if __name__ == "__main__":
    main()
