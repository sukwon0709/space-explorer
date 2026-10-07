"""Named surface features (craters, mountains, plains...) of every world the app can land
on, from the IAU Gazetteer of Planetary Nomenclature, for the search box.

Usage (from the repository root):
    python pipeline/build_features.py DATA_DIR public/data/features.json

Downloads each body's nomenclature centre points (USGS Astrogeology, shapefile) into
DATA_DIR/names and keeps adopted features: name, planetocentric latitude, east
longitude, diameter (km) and feature type. Lettered satellite craters ("Copernicus A",
seven thousand on the Moon) are left out. The gazetteer gives centre longitudes in
each body's customary direction (west for some moons) but extents always east; the
centre is put in the east system when most of a body's centres fall outside their
extents unless flipped.
"""

import argparse
import json
import os
import struct
import urllib.request
import zipfile

NAMES = "https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/{}_nomenclature_center_pts.zip"
BODIES = {
    "MERCURY": 199, "VENUS": 299, "TITAN": 606, "MOON": 301, "MARS": 499, "PHOBOS": 401, "CERES": 2000001, "VESTA": 2000004,
    "IO": 501, "EUROPA": 502, "GANYMEDE": 503, "CALLISTO": 504, "ENCELADUS": 602, "TETHYS": 603,
    "DIONE": 604, "RHEA": 605, "IAPETUS": 608, "TRITON": 801, "PLUTO": 999, "CHARON": 901,
}


def read_dbf(path):
    raw = open(path, "rb").read()
    count, header, record = struct.unpack_from("<IHH", raw, 4)
    fields, o = [], 32
    while raw[o] != 0x0D:
        fields.append((raw[o:o + 11].split(b"\0")[0].decode(), raw[o + 16]))
        o += 32
    rows = []
    for i in range(count):
        r = raw[header + i * record:header + (i + 1) * record]
        p, row = 1, {}
        for name, length in fields:
            row[name] = r[p:p + length].decode("utf-8", "replace").strip()
            p += length
        rows.append(row)
    return rows


def west_centre(row):
    """True if this centre lies in its (east) extent only when read as west longitude;
    None if the extent doesn't decide."""
    try:
        c = float(row["center_lon"]) % 360
        lo, hi = float(row["min_lon"]) % 360, float(row["max_lon"]) % 360
    except ValueError:
        return None

    def inside(v):
        return lo <= v <= hi if lo <= hi else v >= lo or v <= hi

    east, west = inside(c), inside((360 - c) % 360)
    return None if east == west else west


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    parser.add_argument("out")
    args = parser.parse_args()
    cache = os.path.join(args.data, "names")
    os.makedirs(cache, exist_ok=True)
    out = {}
    for target, body in BODIES.items():
        dbf = os.path.join(cache, f"{target}_nomenclature_center_pts.dbf")
        if not os.path.exists(dbf):
            path = os.path.join(cache, f"{target}.zip")
            urllib.request.urlretrieve(NAMES.format(target), path)
            zipfile.ZipFile(path).extractall(cache)
        rows = [r for r in read_dbf(dbf) if r["approval"] == "Adopted by IAU" and r["clean_name"] and r["type"] != "Satellite Feature"]
        votes = [v for v in map(west_centre, rows) if v is not None]
        west = sum(votes) > len(votes) / 2
        features = []
        for row in rows:
            lon = float(row["center_lon"])
            lon = ((-lon if west else lon) + 180) % 360 - 180
            features.append([row["clean_name"], round(float(row["center_lat"]), 4), round(lon, 4),
                             round(float(row["diameter"] or 0), 2), row["type"].split(",")[0]])
        features.sort(key=lambda f: -f[3])
        out[str(body)] = features
        print(f"{target}: {len(features)} features, centres in {'west' if west else 'east'} longitude ({sum(votes)}/{len(votes)} west)")
    with open(args.out, "w") as f:
        json.dump({"source": "IAU Gazetteer of Planetary Nomenclature (USGS Astrogeology)", "fields": ["name", "lat", "lon", "diameter_km", "type"], "bodies": out}, f, separators=(",", ":"), ensure_ascii=False)
    print(f"wrote {args.out}: {os.path.getsize(args.out) / 1e3:.0f} kB")


if __name__ == "__main__":
    main()
