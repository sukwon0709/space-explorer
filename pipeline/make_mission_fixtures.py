"""Held-out Horizons positions for tests/missions.test.ts.

For each spacecraft trajectory in public/data/missions/, asks Horizons for the position
at epochs that are not rows of the table: a few spread over the whole flight, and a few
within an hour of its closest passes (src/generated/missions.json), where the path bends
most. Each is given relative to the centre the table uses at that epoch. Where the table
comes from a mission's own kernels instead, Hayabusa2 at Ryugu is checked against the
laser-derived trajectory at times between the table's rows (Rosetta's flybys are checked
by their distances in tests/missions.test.ts).

    python3 pipeline/make_mission_fixtures.py
"""
import bisect
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(__file__))
from fetch_missions import DAY, J2000_JD, LOCAL, MISSIONS, read, set_blending, states, visit_windows  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..")


def kernel_points(slug: str, rows: list, rng: random.Random, n: int = 12) -> list:
    """Positions from the laser-derived kernel, inside its arcs and off the table's rows."""
    import spiceypy as sp
    import hayabusa2
    path = hayabusa2.fetch(hayabusa2.LIDAR, os.environ.get("KERNELS", "data/spk"))
    sp.furnsh(path)
    cov = sp.spkcov(path, -37, sp.cell_double(4000))
    arcs = [sp.wnfetd(cov, j) for j in range(sp.wncard(cov))]
    jds = [r[0] for r in rows]
    out = []
    for a, b in rng.sample(arcs, n):
        et = rng.uniform(a + 0.25 * (b - a), b - 0.25 * (b - a))
        jd = J2000_JD + et / DAY
        i = bisect.bisect_right(jds, jd) - 1
        if rows[i][1] != 2162173 or jd in (jds[i], jds[i + 1]):
            continue
        p, _ = sp.spkpos("-37", et, "J2000", "NONE", "2162173")
        out.append({"slug": slug, "tdb": round(et, 3), "centre": 2162173, "position": [round(float(x), 4) for x in p], "source": "JAXA laser-derived trajectory"})
    sp.unload(path)
    return out


def main():
    moments = json.load(open(os.path.join(ROOT, "src/generated/missions.json")))
    rng = random.Random(1977)
    out = []
    for slug, naif in MISSIONS:
        path = os.path.join(ROOT, "public/data/missions", f"{slug}.bin")
        if not os.path.exists(path) or slug not in moments:
            continue
        rows = read(path)
        jds = [r[0] for r in rows]
        first, last = jds[0], jds[-1]
        # The table's blended flyby windows (fetch_missions.BLEND), as built.
        set_blending(slug, visit_windows(slug, first - 1 / 1440, last + 1 / 1440))
        epochs = [rng.uniform(first, last) for _ in range(6)]
        passes = [m for m in moments[slug]["moments"] if m.get("key") and "body" in m]
        for m in rng.sample(passes, min(4, len(passes))):
            epochs.append(m["tdb"] / DAY + J2000_JD + rng.uniform(-1, 1) / 24)
        by_centre = {}
        for jd in sorted(epochs):
            jd = min(last, max(first, jd))
            i = max(0, min(len(rows) - 2, bisect.bisect_right(jds, jd) - 1))
            if jd in (jds[i], jds[i + 1]):
                jd += 37.0 / DAY  # off the rows
            by_centre.setdefault(rows[i][1], []).append(jd)
        for centre, list_ in by_centre.items():
            if centre in LOCAL.get(slug, []):
                continue
            for jd, s in states(naif, centre, list_):
                out.append({"slug": slug, "tdb": round((jd - J2000_JD) * DAY, 3), "centre": centre, "position": [round(x, 4) for x in s[:3]]})
        if slug == "hayabusa2":
            out += kernel_points(slug, rows, rng)
        print(f"{slug}: {len(epochs)} epochs", flush=True)
    json.dump(out, open(os.path.join(ROOT, "tests/fixtures/missions-reference.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
