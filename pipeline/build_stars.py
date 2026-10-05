"""Convert the XHIP bright-star catalogue (Anderson & Francis 2012, via the d3-celestial
npm package) into the compact binary the app reads for the background sky.

Usage:
    python pipeline/build_stars.py node_modules/d3-celestial/data/stars.8.json public/data/stars.bin

Layout (little-endian): u32 count, then per star f32 ra (deg), f32 dec (deg),
f32 V magnitude, f32 B-V colour index (NaN when unknown). ICRS, epoch J2000.
"""

import json
import struct
import sys


def main():
    src, out = sys.argv[1], sys.argv[2]
    features = json.load(open(src))["features"]
    rows = []
    for f in features:
        ra, dec = f["geometry"]["coordinates"]
        bv = f["properties"].get("bv")
        rows.append((ra % 360.0, dec, float(f["properties"]["mag"]), float(bv) if bv not in (None, "") else float("nan")))
    rows.sort(key=lambda r: r[2])  # brightest first
    with open(out, "wb") as fh:
        fh.write(struct.pack("<I", len(rows)))
        for row in rows:
            fh.write(struct.pack("<ffff", *row))
    print(f"wrote {out}: {len(rows)} stars, brightest V={rows[0][2]}, faintest V={rows[-1][2]}")


if __name__ == "__main__":
    main()
