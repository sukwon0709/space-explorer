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
# Near a small body the body itself may be a km or less across: a couple of metres
# (10 m by the ones over 2 km across).
SMALL_TOLERANCE_KM = 0.002
SMALL_TOLERANCE_LARGE_KM = 0.01
MIN_STEP_S = 2.0
CHUNK = 1000  # epochs per TLIST request
LAST_JD = 2473459.5  # 2060-01-01, the end of the app's planetary ephemeris
ROW = struct.Struct("<8d")
args_cache = "data/spk"

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
    ("near-shoemaker", -93),
    ("deep-impact", -140),
    ("hayabusa2", -37),
    ("dart", -135),
]

# Spheres of influence, km (Laplace, a (m/M)^0.4), and what each sits inside. The Moon's
# is relative to Earth.
SOI = {199: 1.12e5, 299: 6.16e5, 399: 9.25e5, 301: 6.6e4, 499: 5.77e5, 599: 4.82e7, 699: 5.48e7, 799: 5.18e7, 899: 8.68e7, 999: 3.1e6}
PARENT = {301: 399}

# The small bodies the missions visited (src/generated/shapes.json) pull too weakly to
# have a sphere worth the name, so a mission is given relative to one over a stretch of
# its own: the months of a rendezvous, the hours around a flyby (UTC, near enough).
VISITS = {
    "osiris-rex": [(2101955, "2018-08-17", "2021-05-20")],
    "rosetta": [(2002867, "2008-09-05 06:00", "2008-09-06 06:00"), (2000021, "2010-07-10 03:00", "2010-07-11 03:00"),
                (1000012, "2014-05-07", "2016-10-01")],
    "new-horizons": [(2486958, "2018-12-27 05:00", "2019-01-06 05:00")],
    "lucy": [(20052246, "2025-04-19 18:00", "2025-04-21 18:00")],
    "near-shoemaker": [(2000433, "1998-12-23 06:00", "1998-12-24 06:00"), (2000433, "2000-01-15", "2001-03-01")],
    "deep-impact": [(1000093, "2005-07-02", "2005-07-06")],
    "hayabusa2": [(2162173, "2018-05-10", "2019-12-19")],
    "dart": [(120065803, "2022-09-23", "2022-09-27")],
}
# Where Horizons runs on past the end of a mission: NEAR's path continues on Eros's
# surface for years after its last signal (28 February 2001), DART's past Dimorphos as
# if it had missed, and Rosetta's past the comet's surface. DART ends at its impact
# (23:14:24 UTC, the time at Dimorphos), Rosetta at its touchdown (10:39:28 UTC).
STOP = {"near-shoemaker": "2001-03-01", "dart": "2022-09-26 23:14:24", "rosetta": "2016-09-30 10:39:28"}
# Bodies Horizons won't centre vectors on: the spacecraft's heliocentric states minus the
# body's, from the same small-body solution the app's ephemeris file was built from.
DIFFERENCED = {2000021: "DES=2000021;", 20052246: "DES=20052246;", 2162173: "DES=2162173;"}
# Flybys where Horizons's path relative to the body (New Horizons's own navigation
# solution for Arrokoth) and the app's position for the body (JPL's small-body orbit)
# disagree by more than the flyby needs: the body-relative path is kept within two hours
# of the closest approach and shifted to meet the difference of heliocentric states
# toward the window's ends (21,700 km apart for Arrokoth, 5 days out), so the table joins
# with no step.
BLEND = {("new-horizons", 2486958): "2019-01-01 05:33"}
BLEND_CORE_S = 2 * 3600.0
blending: dict[int, tuple[float, float, float, str]] = {}
# Horizons's own code for a centre, where it differs from the app's NAIF id.
HORIZONS_CENTRE = {120065803: 920065803}
SMALL = {b for visits in VISITS.values() for b, _, _ in visits}
# Stretches taken from the mission team's own kernels instead: Hayabusa2 at Ryugu
# (pipeline/hayabusa2.py), Rosetta's asteroid flybys (pipeline/kernel_flybys.py).
LOCAL = {"hayabusa2": [2162173], "rosetta": [2002867, 2000021]}


def tolerance(centre: int) -> float:
    if centre not in SMALL:
        return TOLERANCE_KM
    return SMALL_TOLERANCE_KM if SMALL_RADIUS.get(centre, 0) < 1 else SMALL_TOLERANCE_LARGE_KM


SMALL_RADIUS = {e["id"]: e["radius"] for e in json.load(open(os.path.join(os.path.dirname(__file__), "..", "src", "generated", "shapes.json")))["bodies"].values()}


def utc_jd(text: str) -> float:
    """'YYYY-MM-DD[ HH:MM[:SS]]' UTC as a TDB JD (TDB - UTC taken as 69.184 s, its value
    since 2017; a few seconds less before then)."""
    from datetime import datetime, timezone
    fmt = {10: "%Y-%m-%d", 16: "%Y-%m-%d %H:%M", 19: "%Y-%m-%d %H:%M:%S"}[len(text)]
    d = datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
    return (d.timestamp() + 69.184) / DAY + 2440587.5


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


def base(naif: int | str, center: int) -> dict:
    return {
        "format": "json", "COMMAND": f"'{naif}'", "EPHEM_TYPE": "'VECTORS'", "CENTER": f"'500@{HORIZONS_CENTRE.get(center, center)}'",
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


def visit_windows(slug: str, first: float, last: float) -> list[tuple[int, float, float]]:
    visits = [(b, max(utc_jd(x), first), min(utc_jd(y), last)) for b, x, y in VISITS.get(slug, [])]
    return [v for v in visits if v[1] < v[2]]


def set_blending(slug: str, visits: list[tuple[int, float, float]]) -> None:
    """Make states() blend the windows in BLEND for this mission (see BLEND)."""
    blending.clear()
    for b, x, y in visits:
        if (slug, b) in BLEND:
            blending[b] = (x, y, utc_jd(BLEND[(slug, b)]), f"DES={b};")


def states(naif: int, center: int, jds: list[float]) -> list[tuple[float, tuple[float, ...]]]:
    if center in blending and isinstance(naif, int) and naif < 0:
        a, z, ca, command = blending[center]
        own = states_direct(naif, center, jds)
        craft = states(naif, 10, jds)
        body = states(command, 10, jds)
        out = []
        for (jd, s), (_, c), (_, b) in zip(own, craft, body):
            span = (ca - a) if jd < ca else (z - ca)
            w = min(1.0, max(0.0, (abs(jd - ca) * DAY - BLEND_CORE_S) / (span * DAY - BLEND_CORE_S)))
            out.append((jd, tuple(x + w * (y - q - x) for x, y, q in zip(s, c, b))))
        return out
    return states_direct(naif, center, jds)


def states_direct(naif: int, center: int, jds: list[float]) -> list[tuple[float, tuple[float, ...]]]:
    if center in DIFFERENCED:
        craft = states(naif, 10, jds)
        body = states(DIFFERENCED[center], 10, jds)
        return [(jd, tuple(a - b for a, b in zip(s, t))) for (jd, s), (_, t) in zip(craft, body)]
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


def refine(naif: int, rows: list, skip: set = frozenset()) -> list:
    """rows: (jd, centre, state, run), in order. Intervals never span two centres; those
    relative to a body in `skip` are left as they are."""
    level = 0
    todo = [i for i in range(len(rows) - 1) if rows[i][1] == rows[i + 1][1] and rows[i][1] not in skip and rows[i + 1][0] > rows[i][0]]
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
                if err > tolerance(c) and h / 2 >= MIN_STEP_S:
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
                if sum((p[j] - r[2][j]) ** 2 for j in range(3)) > tolerance(a[1]) ** 2:
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


def local(slug: str, naif: int, rows: list, cache: str) -> list:
    """Replace the rows inside each run relative to a LOCAL[slug] body with the kernels' own."""
    import hayabusa2
    import kernel_flybys
    root = os.path.join(os.path.dirname(__file__), "..")
    shapes = json.load(open(os.path.join(root, "src", "generated", "shapes.json")))["bodies"]
    horizons = lambda cmd, jds, c=10: states(cmd, c, jds)  # noqa: E731

    def provider(centre: int, first_jd: float, last_jd: float) -> list:
        if centre == 2162173:
            entry = next(e for e in shapes.values() if e["id"] == centre)
            gravity = os.path.join(root, "public", "data", "shapes", "ryugu", "gravity.bin")
            return hayabusa2.rows(first_jd, last_jd, horizons, cache, gravity, entry["rotation"])
        return kernel_flybys.rows(centre, first_jd, last_jd, horizons, os.path.join(cache, "rosetta"))

    out = []
    k = 0
    while k < len(rows):
        centre = rows[k][1]
        if centre not in LOCAL[slug]:
            out.append(rows[k])
            k += 1
            continue
        j = k
        while j + 1 < len(rows) and rows[j + 1][1] == centre:
            j += 1
        run = rows[k][3]
        fill = provider(centre, rows[k][0], rows[j][0])
        print(f"  {centre}: {len(fill)} rows from the mission's kernels", flush=True)
        out += [rows[k]] + [(jd, centre, s, run) for jd, s in fill] + [rows[j]]
        k = j + 1
    return out


def build(slug: str, naif: int, out_dir: str) -> None:
    first, last = coverage(naif)
    first += 1 / 1440  # a minute inside the coverage, clear of any edge
    last -= 1 / 1440
    if slug in STOP:
        last = min(last, utc_jd(STOP[slug]))
    print(f"{slug} ({naif}): JD {first:.4f} to {last:.4f}", flush=True)
    sun = grid(naif, 10, first, last, 1.0)
    if sun[-1][0] < last - 1e-6:
        sun += states(naif, 10, [last])
    cs = centres(naif, sun, first, last)
    # Visits to small bodies: their ends become rows, and every row inside is relative
    # to the body.
    visits = visit_windows(slug, first, last)
    if visits:
        daily = {r[0]: c for r, c in zip(sun, cs)}
        extra = sorted(t for t in {t for _, x, y in visits for t in (x, y)} if min(abs(t - d) for d in daily) > 1e-6)
        sun = sorted(sun + states(naif, 10, extra), key=lambda r: r[0])
        cs, c = [], 10
        eps = 1e-7  # days: Horizons prints epochs to 1e-9
        for r in sun:
            c = daily.get(r[0], c)
            inside = [b for b, x, y in visits if x - eps <= r[0] < y - eps or (r[0] >= y - eps and y >= last - eps)]
            cs.append(inside[0] if inside else c)
    set_blending(slug, visits)
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
    if slug in LOCAL:
        rows = local(slug, naif, rows, args_cache)
    rows = refine(naif, rows, set(LOCAL.get(slug, [])))
    dense = len(rows)
    rows = thin(rows)
    print(f"  {dense} rows, thinned to {len(rows)}", flush=True)
    write(os.path.join(out_dir, f"{slug}.bin"), rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out_dir")
    parser.add_argument("slugs", nargs="*")
    parser.add_argument("--thin", action="store_true", help="only re-thin the files already in out_dir")
    parser.add_argument("--kernels", default="data/spk", help="where mission kernels are downloaded (Hayabusa2)")
    args = parser.parse_args()
    global args_cache
    args_cache = args.kernels
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
