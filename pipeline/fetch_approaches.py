"""Close approaches to Earth worth watching, 1960-2060, as geocentric tracks.

Usage:
    python pipeline/fetch_approaches.py public/data/events tests/fixtures/approaches-reference.json

For each object the JPL SBDB Close-Approach Data API (CAD) gives the time, distance and
speed of the closest approach; the JPL Horizons API then gives a geocentric ICRF state
table (TDB) around it. The app interpolates positions with cubic Hermite polynomials
from positions and velocities, so the step is the longest of a few candidates for
which that interpolation reproduces positions Horizons computes half way between the
samples, near the closest approach where the path bends most, to within 0.5 km.
Very close flybys need short steps, so their tables span less time.

Each track is written as <slug>.json: { name, designation, comet, center: 399, frame: 'ICRF',
start (TDB s past J2000), step (s), positions (km, x y z flattened), velocities (km/s) }.
The fixture keeps CAD's values and a few held-out Horizons positions for the test.
"""

import argparse
import json
import os
import time
import urllib.parse
import urllib.request

CAD = "https://ssd-api.jpl.nasa.gov/cad.api"
HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
J2000_JD = 2451545.0
AU_KM = 149597870.7

# slug, display name, CAD designation, Horizons command, comet?, CAD date window
OBJECTS = [
    ("iras-araki-alcock-1983", "C/1983 H1 (IRAS-Araki-Alcock)", "C/1983 H1", "DES=C/1983 H1;", True, ("1983-05-01", "1983-05-20")),
    ("hyakutake-1996", "C/1996 B2 (Hyakutake)", "C/1996 B2", "DES=C/1996 B2;", True, ("1996-03-15", "1996-04-05")),
    # Fragments of 73P: Horizons records chosen for the orbit solution CAD uses for 2006
    # (fragment B's designation also prefixes BA..BY; C's 2006 pass is fitted by the
    # solution with a 2012 epoch, K114/1).
    ("73p-b-2006", "73P/Schwassmann-Wachmann 3-B", "73P-B", "90000744;", True, ("2006-05-01", "2006-05-31")),
    ("73p-c-2006", "73P/Schwassmann-Wachmann 3-C", "73P-C", "90000747;", True, ("2006-05-01", "2006-05-31")),
    ("252p-2016", "252P/LINEAR", "252P", "DES=252P; CAP<2017;", True, ("2016-03-10", "2016-03-31")),
    ("46p-wirtanen-2018", "46P/Wirtanen", "46P", "DES=46P; CAP<2019;", True, ("2018-12-01", "2018-12-31")),
    ("toutatis-2004", "4179 Toutatis", "4179", "4179;", False, ("2004-09-20", "2004-10-10")),
    ("2005-yu55-2011", "308635 (2005 YU55)", "308635", "308635;", False, ("2011-11-01", "2011-11-15")),
    ("duende-2013", "367943 Duende (2012 DA14)", "367943", "367943;", False, ("2013-02-10", "2013-02-20")),
    ("2012-tc4-2017", "(2012 TC4)", "2012 TC4", "DES=2012 TC4;", False, ("2017-10-05", "2017-10-20")),
    ("2023-bu-2023", "(2023 BU)", "2023 BU", "DES=2023 BU;", False, ("2023-01-20", "2023-02-05")),
    ("1999-an10-2027", "137108 (1999 AN10)", "137108", "137108;", False, ("2027-08-01", "2027-08-15")),
    ("apophis-2029", "99942 Apophis", "99942", "99942;", False, ("2029-04-05", "2029-04-20")),
]
STEPS_MIN = [120, 60, 30, 20, 10, 5, 2, 1]
MAX_SAMPLES = 3000
TOLERANCE_KM = 0.5


def get_json(url: str, params: dict) -> dict:
    full = url + "?" + urllib.parse.urlencode(params)
    for attempt in range(5):
        try:
            with urllib.request.urlopen(full, timeout=180) as r:
                return json.load(r)
        except Exception:
            if attempt == 4:
                raise
            time.sleep(3 + 5 * attempt)
    raise AssertionError


def cad(des: str, window: tuple[str, str]) -> dict:
    d = get_json(CAD, {"des": des, "date-min": window[0], "date-max": window[1], "dist-max": "1", "body": "Earth"})
    f = d["fields"]
    rows = [dict(zip(f, r)) for r in d["data"]]
    row = min(rows, key=lambda r: float(r["dist"]))
    return {"jd": float(row["jd"]), "date": row["cd"], "dist_au": float(row["dist"]), "dist_km": float(row["dist"]) * AU_KM, "v_rel": float(row["v_rel"]), "orbit_id": row["orbit_id"]}


def vectors(command: str, params: dict) -> list[tuple[float, list[float]]]:
    base = {
        "format": "json", "COMMAND": f"'{command}'", "EPHEM_TYPE": "VECTORS", "CENTER": "'500@399'",
        "REF_PLANE": "FRAME", "REF_SYSTEM": "ICRF", "VEC_TABLE": "2", "OUT_UNITS": "KM-S",
        "TIME_TYPE": "TDB", "VEC_LABELS": "NO", "CSV_FORMAT": "YES", "OBJ_DATA": "NO",
    }
    result = get_json(HORIZONS, {**base, **params})["result"]
    if "$$SOE" not in result:
        raise RuntimeError(result[:3000])
    rows = []
    for line in result.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines():
        v = [x.strip() for x in line.split(",")]
        rows.append((float(v[0]), [float(x) for x in v[2:8]]))
    return rows


def hermite(t0: float, h: float, a: list[float], b: list[float], t: float) -> list[float]:
    s = (t - t0) / h
    h00, h10, h01, h11 = 2 * s**3 - 3 * s**2 + 1, s**3 - 2 * s**2 + s, -2 * s**3 + 3 * s**2, s**3 - s**2
    return [h00 * a[i] + h10 * h * a[i + 3] + h01 * b[i] + h11 * h * b[i + 3] for i in range(3)]


def tlist(command: str, jds: list[float]) -> list[tuple[float, list[float]]]:
    return vectors(command, {"TLIST": " ".join(f"'{jd:.9f}'" for jd in jds), "TLIST_TYPE": "JD"})


def build(slug, name, des, command, comet, window, out_dir):
    c = cad(des, window)
    closest = round(c["jd"] * 24) / 24  # whole hour (TDB) near the closest approach
    for step_min in STEPS_MIN:
        h = step_min * 60
        half_days = min(10.0, MAX_SAMPLES * h / 86400 / 2)
        half_days = max(1.0, round(half_days))
        start, stop = closest - half_days, closest + half_days
        rows = vectors(command, {"START_TIME": f"'JD{start:.6f}'", "STOP_TIME": f"'JD{stop:.6f}'", "STEP_SIZE": f"'{step_min} m'"})
        # Held out: midpoints of the twelve intervals around the closest approach.
        k = min(range(len(rows)), key=lambda i: abs(rows[i][0] - c["jd"]))
        idx = [i for i in range(k - 6, k + 6) if 0 <= i < len(rows) - 1]
        checks = tlist(command, [(rows[i][0] + rows[i + 1][0]) / 2 for i in idx])
        worst = 0.0
        for i, (jd, s) in zip(idx, checks):
            p = hermite(0, h, rows[i][1], rows[i + 1][1], h / 2)
            worst = max(worst, sum((p[j] - s[j]) ** 2 for j in range(3)) ** 0.5)
        print(f"{slug}: step {step_min} min, {len(rows)} samples, worst midpoint error {worst:.3f} km")
        if worst < TOLERANCE_KM:
            break
    else:
        raise RuntimeError(f"{slug}: no step reaches {TOLERANCE_KM} km")
    track = {
        "name": name, "designation": des, "comet": comet, "center": 399, "frame": "ICRF",
        "start": round((rows[0][0] - J2000_JD) * 86400, 3), "step": h,
        "positions": [round(v, 2) for _, s in rows for v in s[:3]],
        "velocities": [round(v, 6) for _, s in rows for v in s[3:]],
    }
    with open(os.path.join(out_dir, f"{slug}.json"), "w") as f:
        json.dump(track, f, separators=(",", ":"))
    # Extra held-out points away from the closest approach, for the test.
    far = [rows[i][0] + (rows[i + 1][0] - rows[i][0]) * 0.37 for i in range(0, len(rows) - 1, max(1, len(rows) // 9))]
    more = tlist(command, far)
    return {
        "slug": slug, "name": name, "designation": des, "comet": comet, "cad": c, "step": h,
        "checks": [{"tdb": round((jd - J2000_JD) * 86400, 4), "km": [round(v, 4) for v in s[:3]]} for jd, s in checks + more],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out_dir")
    parser.add_argument("fixture")
    args = parser.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    refs = [build(*o, args.out_dir) for o in OBJECTS]
    with open(args.fixture, "w") as f:
        json.dump({"source": "JPL SBDB Close-Approach Data API and JPL Horizons API (geocentric ICRF vectors, TDB)", "approaches": refs}, f, indent=0)
    print(f"wrote {len(refs)} tracks to {args.out_dir} and {args.fixture}")


if __name__ == "__main__":
    main()
