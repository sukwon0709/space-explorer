"""Spacecraft trajectories from JPL Horizons, sampled so the app can interpolate them.

Usage:
    python pipeline/fetch_missions.py public/data/missions [slug ...]
    python pipeline/fetch_missions.py --thin public/data/missions   # re-thin existing files

Each mission is written as <slug>.bin: little-endian float64 rows of
(TDB seconds past J2000, centre NAIF id, x, y, z km, vx, vy, vz km/s), ICRF, relative to
the centre: the Sun in cruise, a planet (or the Moon) inside its sphere of influence.
These are the navigation teams' reconstructed (and, for missions still flying,
predicted) trajectories as Horizons serves them.

Why a centre: a flyby was reconstructed relative to its planet, and that is the
geometry that matters there. Horizons chains the same data to the barycentre through
whatever planetary ephemeris the team used at the time, so barycentric positions can
disagree with the planet-relative ones by thousands of km (14,000 km at Neptune in
1989, when Neptune's position was known less well). The app adds the centre's
position from its own DE440, so a flyby passes the planet exactly as navigated. Where
the centre changes the row is repeated in both frames; the two can differ by that
same amount, far from anything (at the edge of the sphere of influence).

The app interpolates between rows with cubic Hermite polynomials from positions and
velocities. Rows are chosen adaptively: starting from a daily grid, an interval is
split while the Hermite curve through its ends misses the position Horizons gives at
its midpoint by more than TOLERANCE_KM, so cruise needs a row a day and a close flyby or
a burn gets rows minutes or seconds apart. Every midpoint checked is a real Horizons
position; split midpoints become rows. Then rows are dropped again wherever the
Hermite curve over the longer interval still passes within TOLERANCE_KM of every row it
skips, so quiet cruise ends up with rows weeks apart.
"""

import argparse
import json
import os
import struct
import sys
import time
import urllib.parse
import urllib.request

HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
# Long epoch lists go to the file interface as a POST (GET URLs over ~2 kB are refused).
HORIZONS_FILE = "https://ssd.jpl.nasa.gov/api/horizons_file.api"
J2000_JD = 2451545.0
DAY = 86400.0
TOLERANCE_KM = 0.5
MIN_STEP_S = 2.0
CHUNK = 1000  # epochs per TLIST request
LAST_JD = 2473459.5  # 2060-01-01, the end of the app's planetary ephemeris
ROW = struct.Struct("<8d")

MISSIONS = [
    ("voyager-1", -31),
    ("voyager-2", -32),
    ("pioneer-10", -23),
    ("pioneer-11", -24),
    ("galileo", -77),
    ("cassini", -82),
    ("new-horizons", -98),
    ("juno", -61),
    ("rosetta", -226),
    ("parker-solar-probe", -96),
    ("osiris-rex", -64),
    ("artemis-1", -1023),
    ("artemis-2", -1024),
    ("juice", -28),
    ("lucy", -49),
]

# Spheres of influence, km (Laplace, a (m/M)^0.4), and what each sits inside. The Moon's
# is relative to Earth.
SOI = {199: 1.12e5, 299: 6.16e5, 399: 9.25e5, 301: 6.6e4, 499: 5.77e5, 599: 4.82e7, 699: 5.48e7, 799: 5.18e7, 899: 8.68e7, 999: 3.1e6}
PARENT = {301: 399}


def get(params: dict) -> str:
    if "TLIST" in params:
        # The file interface: one KEY='value' line each, TLIST continuing one epoch a line.
        lines = ["!$$SOF"] + [f"{k}={v}" for k, v in params.items() if k not in ("format", "TLIST")]
        lines += ["TLIST="] + params["TLIST"].split(" ")
        boundary = "horizons-input-boundary"
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"format\"\r\n\r\njson\r\n"
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"input\"; filename=\"input.txt\"\r\n"
                f"Content-Type: text/plain\r\n\r\n" + "\n".join(lines) + f"\n\r\n--{boundary}--\r\n").encode()
        request = urllib.request.Request(HORIZONS_FILE, data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    else:
        request = urllib.request.Request(HORIZONS + "?" + urllib.parse.urlencode(params))
    for attempt in range(6):
        try:
            with urllib.request.urlopen(request, timeout=300) as r:
                return json.load(r)["result"]
        except Exception as err:  # network hiccups and 503s from a busy service
            if attempt == 5:
                raise
            print(f"  retry after {err}", file=sys.stderr)
            time.sleep(4 + 8 * attempt)
    raise AssertionError


def base(naif: int, center: int) -> dict:
    return {
        "format": "json", "COMMAND": f"'{naif}'", "EPHEM_TYPE": "'VECTORS'", "CENTER": f"'500@{center}'",
        "REF_PLANE": "'FRAME'", "REF_SYSTEM": "'ICRF'", "VEC_TABLE": "'2'", "OUT_UNITS": "'KM-S'",
        "TIME_TYPE": "'TDB'", "VEC_LABELS": "'NO'", "CSV_FORMAT": "'YES'", "OBJ_DATA": "'NO'", "VEC_CORR": "'NONE'",
    }


def parse(result: str) -> list[tuple[float, tuple[float, ...]]]:
    if "$$SOE" not in result:
        raise RuntimeError(result[:2000])
    rows = []
    for line in result.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines():
        v = [x.strip() for x in line.split(",")]
        rows.append((float(v[0]), tuple(float(x) for x in v[2:8])))
    return rows


def coverage(naif: int) -> tuple[float, float]:
    """First and last JD (TDB) Horizons has for the spacecraft, from its own messages."""
    import re

    def edge(start: str, stop: str, word: str) -> float | None:
        r = get({**base(naif, 0), "START_TIME": f"'{start}'", "STOP_TIME": f"'{stop}'", "STEP_SIZE": "'1d'"})
        m = re.search(rf"{word} A\.D\. (\d{{4}}-[A-Z]{{3}}-\d\d \d\d:\d\d:\d\d\.\d+) TDB", r)
        if not m:
            return None
        cal = get({**base(10, 0), "START_TIME": f"'{m.group(1)}'", "STOP_TIME": f"'{m.group(1)[:11]} 23:59'", "STEP_SIZE": "'1d'"})
        return parse(cal)[0][0]

    first = edge("1950-01-01", "1950-01-02", "prior to")
    last = edge("2059-12-30", "2059-12-31", "after")
    if first is None:
        raise RuntimeError(f"{naif}: no start found")
    return first, min(last if last is not None else LAST_JD, LAST_JD)


def states(naif: int, center: int, jds: list[float]) -> list[tuple[float, tuple[float, ...]]]:
    out = []
    for k in range(0, len(jds), CHUNK):
        part = jds[k:k + CHUNK]
        rows = parse(get({**base(naif, center), "TLIST": " ".join(f"'{jd:.10f}'" for jd in part), "TLIST_TYPE": "'JD'"}))
        if len(rows) != len(part):
            raise RuntimeError(f"{naif}: asked {len(part)} epochs, got {len(rows)}")
        out.extend(rows)
    return out


def grid(naif: int, center: int, first: float, last: float, step_days: float) -> list[tuple[float, tuple[float, ...]]]:
    rows = []
    span = 20000 * step_days
    t = first
    while t < last:
        stop = min(last, t + span)
        n = max(1, round((stop - t) / step_days))
        rows.extend(parse(get({**base(naif, center), "START_TIME": f"'JD{t:.9f}'", "STOP_TIME": f"'JD{stop:.9f}'", "STEP_SIZE": f"'{n}'"})))
        t = stop
    # Each window repeats its first epoch as the previous one's last.
    clean = []
    for r in rows:
        if not clean or r[0] > clean[-1][0] + 1e-9:
            clean.append(r)
    return clean


def hermite_at(a, b, h: float, s: float) -> tuple[float, float, float]:
    s2, s3 = s * s, s * s * s
    h00, h10, h01, h11 = 2 * s3 - 3 * s2 + 1, (s3 - 2 * s2 + s) * h, -2 * s3 + 3 * s2, (s3 - s2) * h
    return tuple(h00 * a[i] + h10 * a[i + 3] + h01 * b[i] + h11 * b[i + 3] for i in range(3))


def centres(naif: int, rows: list, first: float, last: float) -> list[int]:
    """The centre for each row of a Sun-relative daily grid: the innermost sphere of
    influence the spacecraft is in, else the Sun."""
    out = [10] * len(rows)
    rel = {}
    for body in SOI:
        # The spacecraft relative to the body, straight from Horizons, on the same grid.
        try:
            g = grid(naif, body, first, last, 1.0)
        except RuntimeError as err:
            print(f"  no vectors relative to {body}: {str(err)[:200]}", file=sys.stderr)
            continue
        if [r[0] for r in g[:len(rows)]] != [r[0] for r in rows[:len(g)]] or len(g) < len(rows) - 1:
            raise RuntimeError(f"{naif}: grid relative to {body} does not match")
        rel[body] = [r[1] for r in g] + [g[-1][1]] * (len(rows) - len(g))
    for i in range(len(rows)):
        inside = [b for b in rel if sum(x * x for x in rel[b][i][:3]) ** 0.5 < SOI[b]]
        # The Moon's sphere sits inside Earth's: the innermost wins.
        inside.sort(key=lambda b: b in PARENT, reverse=True)
        if inside:
            out[i] = inside[0]
    return out


def refine(naif: int, rows: list) -> list:
    """rows: (jd, centre, state, run), in order. Intervals never span two centres."""
    level = 0
    todo = [i for i in range(len(rows) - 1) if rows[i][1] == rows[i + 1][1] and rows[i + 1][0] > rows[i][0]]
    while todo:
        level += 1
        new = []
        by_centre = {}
        for i in todo:
            by_centre.setdefault(rows[i][1], []).append(i)
        for c, idx in by_centre.items():
            mids = [(rows[i][0] + rows[i + 1][0]) / 2 for i in idx]
            truth = states(naif, c, mids)
            for i, (jd, s) in zip(idx, truth):
                a, b = rows[i][2], rows[i + 1][2]
                h = (rows[i + 1][0] - rows[i][0]) * DAY
                p = hermite_at(a, b, h, 0.5)
                err = sum((p[k] - s[k]) ** 2 for k in range(3)) ** 0.5
                if err > TOLERANCE_KM and h / 2 >= MIN_STEP_S:
                    new.append((jd, c, s, rows[i][3]))
        print(f"  level {level}: {len(todo)} intervals checked, {len(new)} split", flush=True)
        if not new:
            break
        # Where a centre change repeats an epoch, the earlier run's row comes first.
        rows = sorted(rows + new, key=lambda r: (r[0], r[3]))
        index = {(r[0], r[1]): k for k, r in enumerate(rows)}
        todo = []
        for jd, c, _, _ in new:
            k = index[(jd, c)]
            todo += [k - 1, k]
    return rows


def thin(rows: list, max_skip: int = 256) -> list:
    """Drop rows the Hermite curve between their neighbours reproduces within tolerance."""
    keep = [rows[0]]
    i = 0
    n = len(rows)
    while i < n - 1:
        best = i + 1
        k = i + 2
        while k < n and k - i <= max_skip and rows[k][1] == rows[i][1] and rows[k][0] > rows[k - 1][0]:
            a, b = rows[i], rows[k]
            h = (b[0] - a[0]) * DAY
            ok = True
            for r in rows[i + 1:k]:
                p = hermite_at(a[2], b[2], h, (r[0] - a[0]) * DAY / h)
                if sum((p[j] - r[2][j]) ** 2 for j in range(3)) > TOLERANCE_KM ** 2:
                    ok = False
                    break
            if not ok:
                break
            best = k
            k += 1
        keep.append(rows[best])
        i = best
    return keep


def write(path: str, rows: list) -> None:
    with open(path, "wb") as f:
        for jd, c, s, *_ in rows:
            f.write(ROW.pack((jd - J2000_JD) * DAY, c, *s))


def read(path: str) -> list:
    data = open(path, "rb").read()
    out = []
    for k in range(0, len(data), ROW.size):
        t, c, *s = ROW.unpack_from(data, k)
        out.append((t / DAY + J2000_JD, int(c), tuple(s), len(out)))
    return out


def build(slug: str, naif: int, out_dir: str) -> None:
    first, last = coverage(naif)
    first += 1 / 1440  # a minute inside the coverage, clear of any edge
    last -= 1 / 1440
    print(f"{slug} ({naif}): JD {first:.4f} to {last:.4f}", flush=True)
    sun = grid(naif, 10, first, last, 1.0)
    if sun[-1][0] < last - 1e-6:
        sun += states(naif, 10, [last])
    cs = centres(naif, sun, first, last)
    # Runs of one centre; where it changes, the epoch is repeated in both frames.
    rows = []
    k = 0
    run = 0
    while k < len(sun):
        c = cs[k]
        j = k
        while j + 1 < len(sun) and cs[j + 1] == c:
            j += 1
        jds = [r[0] for r in sun[k:j + 1]]
        if j + 1 < len(sun):
            jds.append(sun[j + 1][0])
        part = [(r[0], 10, r[1], run) for r in sun[k:j + 1]] if c == 10 else [(jd, c, s, run) for jd, s in states(naif, c, jds[:j + 1 - k])]
        if j + 1 < len(sun):
            # The first epoch of the next run, in this run's frame.
            part += [(jd, c, s, run) for jd, s in states(naif, c, jds[-1:])]
        if c != 10:
            print(f"  {c} from JD {jds[0]:.2f} to {jds[-1]:.2f}", flush=True)
        rows += part
        k = j + 1
        run += 1
    rows = refine(naif, rows)
    dense = len(rows)
    rows = thin(rows)
    print(f"  {dense} rows, thinned to {len(rows)}", flush=True)
    write(os.path.join(out_dir, f"{slug}.bin"), rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out_dir")
    parser.add_argument("slugs", nargs="*")
    parser.add_argument("--thin", action="store_true", help="only re-thin the files already in out_dir")
    args = parser.parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    for slug, naif in MISSIONS:
        if args.slugs and slug not in args.slugs:
            continue
        path = os.path.join(args.out_dir, f"{slug}.bin")
        if args.thin:
            if os.path.exists(path):
                rows = read(path)
                write(path, thin(rows))
                print(f"{slug}: {len(rows)} rows to {os.path.getsize(path) // ROW.size}")
            continue
        build(slug, naif, args.out_dir)


if __name__ == "__main__":
    main()
