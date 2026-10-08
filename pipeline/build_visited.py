"""Orbits of the small bodies spacecraft visited (pipeline/build_shapes.py), from JPL
Horizons, re-fitted as compact Chebyshev series like the moons (build_moons.py).

Usage:
    python pipeline/build_visited.py CACHE_DIR public/data --fixtures tests/fixtures/visited-reference.json

Horizons serves each body's best orbit solution, including the spacecraft tracking
that refined it (Bennu's from OSIRIS-REx radio science, Ryugu's from Hayabusa2), with
planetary perturbations and, for comets, outgassing forces. The table is sampled
daily (Dimorphos about Didymos hourly) and interpolated with cubic Hermite polynomials
from positions and velocities, far within the fit's tolerance.

Heliocentric orbits are relative to the Sun (NAIF 10); Dimorphos is relative to
Didymos's primary, from the DART team's solution in Horizons, which covers 2000-2030.
The heliocentric "Didymos" is the system's barycentre; the app moves the primary off
it by the satellite's share of the mass.
"""

import argparse
import json
import os
import urllib.parse
import urllib.request

import numpy as np

from build_ephemeris import seconds_past_j2000
from build_moons import fit, write

HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
J2000_JD = 2451545.0

# App id, Horizons command, centre (NAIF), start, end, step.
BODIES = [
    (2101955, "2101955", 10, "1960-01-01", "2061-01-01", "1d"),
    (2162173, "DES=2162173;", 10, "1960-01-01", "2061-01-01", "1d"),
    (2025143, "DES=2025143;", 10, "1960-01-01", "2061-01-01", "1d"),
    (2000433, "DES=2000433;", 10, "1960-01-01", "2061-01-01", "1d"),
    (1000012, "DES=1000012;CAP;", 10, "1960-01-01", "2061-01-01", "1d"),
    (1000093, "DES=1000093;CAP;", 10, "1960-01-01", "2061-01-01", "1d"),
    (2486958, "DES=2486958;", 10, "1960-01-01", "2061-01-01", "4d"),
    (2065803, "DES=2065803;", 10, "1960-01-01", "2061-01-01", "1d"),
    (2000021, "DES=2000021;", 10, "1960-01-01", "2061-01-01", "1d"),
    (2002867, "DES=2002867;", 10, "1960-01-01", "2061-01-01", "1d"),
    (20052246, "DES=20052246;", 10, "1960-01-01", "2061-01-01", "1d"),
    (120065803, "120065803", 2065803, "2000-01-03", "2030-12-29", "1h"),
]
HORIZONS_CENTRE = {10: "500@10", 2065803: "500@920065803"}


def horizons(command, centre, start, stop, step, cache):
    key = f"{command}_{centre}_{start}_{stop}_{step}".replace(";", "").replace("=", "").replace(":", "")
    path = os.path.join(cache, f"horizons_{key}.txt")
    if not os.path.exists(path):
        params = {
            "format": "text", "COMMAND": f"'{command}'", "EPHEM_TYPE": "VECTORS", "CENTER": f"'{HORIZONS_CENTRE[centre]}'",
            "START_TIME": f"'{start}'", "STOP_TIME": f"'{stop}'", "STEP_SIZE": f"'{step}'", "OBJ_DATA": "NO",
            "VEC_TABLE": "2", "REF_SYSTEM": "ICRF", "REF_PLANE": "FRAME", "OUT_UNITS": "KM-S", "CSV_FORMAT": "YES",
        }
        with urllib.request.urlopen(HORIZONS + "?" + urllib.parse.urlencode(params), timeout=600) as r:
            text = r.read().decode()
        if "$$SOE" not in text:
            raise RuntimeError(text[-2000:])
        with open(path, "w") as f:
            f.write(text)
    text = open(path).read()
    body = text[text.index("$$SOE") + 5:text.index("$$EOE")]
    rows = []
    for line in body.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        rows.append([float(parts[0])] + [float(p) for p in parts[2:8]])
    return np.array(rows)


def table(app_id, command, centre, start, end, step, cache):
    """All rows over the span, fetched a decade (or for hourly rows a year) at a time."""
    y0, y1 = int(start[:4]), int(end[:4])
    span = 1 if step.endswith("h") else 10
    parts = []
    for y in range(y0, y1, span):
        a = start if y == y0 else f"{y}-01-01"
        b = end if y + span >= y1 else f"{y + span}-01-01"
        parts.append(horizons(command, centre, a, b, step, cache))
    rows = np.concatenate(parts)
    _, keep = np.unique(rows[:, 0], return_index=True)
    rows = rows[keep]
    rows[:, 0] = (rows[:, 0] - J2000_JD) * 86400.0
    return rows


class Hermite:
    """Cubic Hermite interpolation through tabulated positions and velocities."""

    def __init__(self, rows):
        self.t = rows[:, 0]
        self.p = rows[:, 1:4]
        self.v = rows[:, 4:7]

    def __call__(self, t):
        t = np.asarray(t, dtype=float)
        i = np.clip(np.searchsorted(self.t, t) - 1, 0, len(self.t) - 2)
        h = self.t[i + 1] - self.t[i]
        s = ((t - self.t[i]) / h)[:, None]
        h = h[:, None]
        h00 = 2 * s**3 - 3 * s**2 + 1
        h10 = s**3 - 2 * s**2 + s
        h01 = -2 * s**3 + 3 * s**2
        h11 = s**3 - s**2
        return h00 * self.p[i] + h10 * h * self.v[i] + h01 * self.p[i + 1] + h11 * h * self.v[i + 1]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("cache")
    parser.add_argument("outdir")
    parser.add_argument("--fixtures")
    args = parser.parse_args()
    cache = os.path.join(args.cache, "visited")
    os.makedirs(cache, exist_ok=True)
    rng = np.random.default_rng(5)
    segments, fixtures = [], []
    for app_id, command, centre, start, end, step in BODIES:
        rows = table(app_id, command, centre, start, end, step, cache)
        source = Hermite(rows)
        t0 = rows[0, 0]
        t1 = rows[-1, 0]
        # The fit's last interval may run past the table: stop one interval short of its end.
        reach = np.max(np.linalg.norm(rows[:, 1:4], axis=1))
        tol = max(0.0005 if centre != 10 else 1.0, reach * 1e-7)
        nbytes, intlen, coef = fit(source, t0, t1 - 4 * 86400, tol)
        print(f"{app_id}: {len(rows)} rows, {coef.shape[0]} x {coef.shape[2]} coefficients every {intlen / 86400:g} d, "
              f"{nbytes / 1e6:.2f} MB, within {tol:g} km", flush=True)
        segments.append((centre, app_id, t0, intlen, coef))
        # Held-out Horizons rows (between fit nodes) for the gate test.
        for k in rng.choice(len(rows), 12, replace=False):
            if rows[k, 0] < t0 + coef.shape[0] * intlen:
                fixtures.append({"center": centre, "target": app_id, "tdb": float(rows[k, 0]), "km": rows[k, 1:4].tolist(), "tolerance_km": tol * 1.5})
    write(os.path.join(args.outdir, "moons-visited.bin"), segments)
    if args.fixtures:
        with open(args.fixtures, "w") as f:
            json.dump({"source": "JPL Horizons vectors", "cases": fixtures}, f)


if __name__ == "__main__":
    main()
