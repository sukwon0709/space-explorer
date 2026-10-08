"""Rosetta's asteroid flybys, relative to the asteroid, from ESA's own kernels.

Horizons has Rosetta, and Šteins and Lutetia from JPL's small-body orbits, but those
orbits are not the ones ESA's flight dynamics solved for at the flybys: differenced, they
put Rosetta 580 km from Šteins instead of the 803 km measured. ESA archived both the
spacecraft trajectory and the asteroid orbit it navigated with (spiftp.esac.esa.int,
ROSETTA/kernels/spk):

    ORHR_______________00122.BSP   Rosetta, reconstructed (heliocentric)
    ORHO_______________00077.BSP   Šteins, ESOC orbit
    ORHS_______________00109.BSP   Lutetia, ESOC orbit

Rosetta minus the asteroid from these gives the flyby as ESA measured it: Šteins at
802.6 km, 18:38:20 UTC on 5 September 2008; Lutetia at 3,168 km, 15:44:56 UTC on
10 July 2010. Toward the ends of the window (12 hours out, 400,000 km and more away) the
path is shifted to meet Horizons's difference, so it joins the rest of the table with no
step: the shift is zero within two hours of the closest approach.
"""

import os
import urllib.request

import numpy as np

ARCHIVE = "https://spiftp.esac.esa.int/data/SPICE/ROSETTA/kernels/spk/"
CRAFT = "ORHR_______________00122.BSP"
BODIES = {2002867: "ORHO_______________00077.BSP", 2000021: "ORHS_______________00109.BSP"}
J2000_JD = 2451545.0
DAY = 86400.0
EXACT_S = 2 * 3600.0


def fetch(name: str, cache: str) -> str:
    path = os.path.join(cache, name)
    if not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)
        print(f"  downloading {name}", flush=True)
        urllib.request.urlretrieve(ARCHIVE + name, path + ".part")
        os.replace(path + ".part", path)
    return path


def rows(body: int, first_jd: float, last_jd: float, horizons_states, cache: str):
    """Rosetta relative to `body`, (jd, state) strictly between first_jd and last_jd."""
    import spiceypy as sp
    paths = [fetch(CRAFT, cache), fetch(BODIES[body], cache)]
    for p in paths:
        sp.furnsh(p)
    a, z = (first_jd - J2000_JD) * DAY, (last_jd - J2000_JD) * DAY

    def rel(t: float) -> np.ndarray:
        s, _ = sp.spkezr("-226", t, "J2000", "NONE", str(body))
        return np.array(s)

    # Closest approach, to a tenth of a second.
    ts = np.arange(a, z, 60.0)
    d = [np.linalg.norm(rel(t)[:3]) for t in ts]
    lo, hi = ts[max(0, int(np.argmin(d)) - 1)], ts[min(len(ts) - 1, int(np.argmin(d)) + 1)]
    while hi - lo > 0.1:
        m1, m2 = lo + (hi - lo) / 3, hi - (hi - lo) / 3
        if np.linalg.norm(rel(m1)[:3]) < np.linalg.norm(rel(m2)[:3]):
            hi = m2
        else:
            lo = m1
    ca = (lo + hi) / 2
    # Rows: every 10 s within 10 minutes of the pass, then spreading out (thinning drops
    # what the curve doesn't need).
    near = np.arange(ca - 600, ca + 600, 10.0)
    t = np.unique(np.concatenate([near, ca + np.geomspace(600, z - ca, 200), ca - np.geomspace(600, ca - a, 200)]))
    t = t[(t > a + 1) & (t < z - 1)]
    s = np.array([rel(x) for x in t])
    # Meet Horizons's difference toward the ends of the window.
    h = np.array([q for _, q in horizons_states(-226, list(J2000_JD + t / DAY), body)])
    w = np.clip((np.abs(t - ca) - EXACT_S) / (np.where(t < ca, ca - a, z - ca) - EXACT_S), 0, 1)
    s = s + w[:, None] * (h - s)
    for p in paths:
        sp.unload(p)
    print(f"  {body}: closest {np.linalg.norm(rel_at(s, t, ca)):.1f} km at {sp.etcal(ca)} TDB (ESA kernels)", flush=True)
    return [(J2000_JD + x / DAY, tuple(float(v) for v in q)) for x, q in zip(t, s)]


def rel_at(s: np.ndarray, t: np.ndarray, ca: float) -> np.ndarray:
    return s[int(np.argmin(np.abs(t - ca))), :3]
