"""Fit compact Chebyshev series for planetary moons (and planet-centre offsets) from
NAIF's satellite kernels, read over HTTP range requests.

Usage:
    python pipeline/build_moons.py CACHE_DIR public/data \
        --start 1960-01-01 --end 2060-12-31 --fixtures tests/fixtures/moons-reference.json

JPL's own satellite kernels use short intervals tuned for millimetre accuracy, which for
a century of 30 bodies comes to about 330 MB. The app needs far less: this re-fits each
body's position relative to its system barycentre with longer intervals, choosing the
interval and degree that meet TOLERANCE_KM with the fewest coefficients. The output is
the SEPH layout of build_ephemeris.py with float32 coefficients (version 2), which
keep about 7 significant digits: 0.2 km at Iapetus's distance from Saturn.
"""

import argparse
import json
import struct

import numpy as np
from numpy.polynomial import chebyshev as C

from build_ephemeris import HEADER, MAGIC, SEGMENT, VERSION, seconds_past_j2000
from remote_spk import RemoteSPK

NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/"
GENERIC = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/"
TOLERANCE_KM = 1.0

# kernel, bodies (NAIF ids), output file. Planet centres (x99) are offsets from their
# system barycentre. One file per planet system, so the app loads a system's moons
# only when the camera heads there.
KERNELS = [
    ("mar099.bsp", [401, 402], "mars"),
    ("jup365.bsp", [501, 502, 503, 504, 599], "jupiter"),
    ("sat441.bsp", [601, 602, 603, 604, 605, 606, 607, 608, 609, 699], "saturn"),
    ("ura184_part-3.bsp", [701, 702, 703, 704, 705, 799], "uranus"),
    ("nep097.bsp", [801, 899], "neptune"),
    ("plu060.bsp", [901, 999], "pluto"),
    # The largest asteroids, from the DE441 small-body perturber set: Ceres, Pallas, Vesta, Hygiea.
    ("https://ssd.jpl.nasa.gov/ftp/eph/small_bodies/asteroids_de441/sb441-n16.bsp", [2000001, 2000002, 2000004, 2000010], "asteroids"),
]


class Source:
    """Evaluates a body's JPL Chebyshev records at arbitrary epochs (vectorised)."""

    def __init__(self, pieces):
        self.pieces = pieces

    def __call__(self, t):
        t = np.asarray(t, dtype=float)
        out = np.empty((len(t), 3))
        for k, (a, b, init, intlen, coef) in enumerate(self.pieces):
            last = k == len(self.pieces) - 1
            mask = (t >= a) & ((t < b) | last) if k else (t < b) | last
            if mask.any():
                out[mask] = self.piece(init, intlen, coef, t[mask])
        return out

    @staticmethod
    def piece(init, intlen, coef, t):
        idx = np.clip(((t - init) // intlen).astype(int), 0, len(coef) - 1)
        s = 2 * (t - (init + idx * intlen)) / intlen - 1
        out = np.empty((len(t), 3))
        c = coef[idx]  # (n, 3, ncoef)
        # Clenshaw over all samples at once.
        b1 = np.zeros((len(t), 3))
        b2 = np.zeros((len(t), 3))
        for k in range(c.shape[2] - 1, 0, -1):
            b0 = 2 * s[:, None] * b1 - b2 + c[:, :, k]
            b2, b1 = b1, b0
        out[:] = s[:, None] * b1 - b2 + c[:, :, 0]
        return out


def fit(source, t0, t1, tol):
    """Best (bytes, intlen, coef[nrec, 3, ncoef]) for the span: try interval lengths and degrees."""
    span = t1 - t0
    best = None
    for days in [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512]:
        intlen = days * 86400.0
        nrec = int(np.ceil(span / intlen))
        # Probe the degree on a sample of intervals, then confirm on all of them.
        probe = np.linspace(0, nrec - 1, min(nrec, 60)).astype(int)
        for ncoef in range(6, 61):
            if best and nrec * ncoef * 3 * 4 >= best[0]:
                break
            if fits(source, t0, intlen, probe, ncoef, tol * 0.8):
                coef = fit_all(source, t0, intlen, nrec, ncoef)
                if check(source, t0, intlen, coef, tol):
                    best = (coef.nbytes // 2, intlen, coef)
                break
    return best


def nodes(ncoef):
    k = np.arange(ncoef * 2)
    return np.cos(np.pi * (k + 0.5) / (ncoef * 2))  # 2x oversampled Chebyshev nodes


def fit_interval(source, start, intlen, ncoef):
    x = nodes(ncoef)
    p = source(start + (x + 1) / 2 * intlen)
    return np.stack([C.chebfit(x, p[:, a], ncoef - 1) for a in range(3)])


def max_error(source, start, intlen, coef):
    x = np.linspace(-1, 1, 4 * coef.shape[1] + 1)
    p = source(start + (x + 1) / 2 * intlen)
    q = np.stack([C.chebval(x, coef[a]) for a in range(3)], axis=1)
    return np.max(np.linalg.norm(p - q, axis=1))


def fits(source, t0, intlen, probe, ncoef, tol):
    for i in probe:
        c = fit_interval(source, t0 + i * intlen, intlen, ncoef)
        if max_error(source, t0 + i * intlen, intlen, c) > tol * 0.7:
            return False
    return True


def fit_all(source, t0, intlen, nrec, ncoef):
    x = nodes(ncoef)
    t = (t0 + np.arange(nrec)[:, None] * intlen + (x[None, :] + 1) / 2 * intlen).ravel()
    p = source(t).reshape(nrec, len(x), 3)
    # Least squares at the nodes for every interval at once: coef = pinv(V) @ p.
    V = C.chebvander(x, ncoef - 1)
    P = np.linalg.pinv(V)
    return np.einsum("kn,rna->rak", P, p)


def check(source, t0, intlen, coef, tol):
    nrec, _, ncoef = coef.shape
    x = np.linspace(-1, 1, 3 * ncoef + 1)
    t = (t0 + np.arange(nrec)[:, None] * intlen + (x[None, :] + 1) / 2 * intlen).ravel()
    p = source(t).reshape(nrec, len(x), 3)
    V = C.chebvander(x, ncoef - 1)
    q = np.einsum("nk,rak->rna", V, coef.astype(np.float32).astype(float))
    err = np.max(np.linalg.norm(p - q, axis=2))
    return err <= tol


def write(path, segments):
    """SEPH version 2: the version 1 layout with float32 coefficients."""
    offset = HEADER.size + SEGMENT.size * len(segments)
    offset += -offset % 8
    with open(path, "wb") as f:
        f.write(HEADER.pack(MAGIC, 2, len(segments), 0))
        starts = []
        for center, target, init, intlen, coef in segments:
            nrec, _, ncoef = coef.shape
            f.write(SEGMENT.pack(center, target, init, intlen, ncoef, nrec, offset, 0))
            starts.append(offset)
            offset += coef.size * 4
        f.write(b"\0" * (starts[0] - f.tell()))
        for *_, coef in segments:
            f.write(np.ascontiguousarray(coef, dtype="<f4").tobytes())
    print(f"wrote {path}: {offset / 1e6:.1f} MB", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("cache")
    parser.add_argument("outdir", help="writes moons-<system>.bin here")
    parser.add_argument("--start", default="1960-01-01")
    parser.add_argument("--end", default="2060-12-31")
    parser.add_argument("--fixtures")
    parser.add_argument("--only", help="comma-separated systems to rebuild (fixtures are then merged)")
    args = parser.parse_args()
    t0, t1 = seconds_past_j2000(args.start), seconds_past_j2000(args.end)

    fixtures = []
    if args.only and args.fixtures:
        try:
            with open(args.fixtures) as f:
                rebuilt = set()
                for kernel, bodies, system in KERNELS:
                    if system in args.only.split(","):
                        rebuilt.update(bodies)
                fixtures = [c for c in json.load(f)["cases"] if c["target"] not in rebuilt]
        except FileNotFoundError:
            pass
    rng = np.random.default_rng(3)
    for kernel, bodies, system in KERNELS:
        if args.only and system not in args.only.split(","):
            continue
        spk = RemoteSPK(kernel if kernel.startswith("https:") else NAIF + kernel, args.cache)
        segments = []
        for body in bodies:
            # Read past the end: the last fitted interval may run beyond t1.
            center, pieces = spk.chebyshev(body, t0, t1 + 300 * 86400)
            source = Source(pieces)
            # float32 keeps ~7 digits, so far-out bodies (asteroids, ~4e8 km from the Sun)
            # get a tolerance relative to their distance from the centre.
            reach = np.max(np.linalg.norm(source(np.linspace(t0, t1, 2000)), axis=1))
            tol = max(TOLERANCE_KM, reach * 1e-7)
            nbytes, fit_len, fitted = fit(source, t0, t1, tol)
            print(f"{kernel} {body}: {fitted.shape[0]} x {fitted.shape[2]} coefficients every {fit_len / 86400:g} d, {nbytes / 1e6:.2f} MB, within {tol:g} km", flush=True)
            segments.append((center, body, t0, fit_len, fitted))
            for t in rng.uniform(t0, t1, 30):
                fixtures.append({"center": center, "target": body, "tdb": float(t), "km": source([t])[0].tolist(), "tolerance_km": tol})
        write(f"{args.outdir}/moons-{system}.bin", segments)
    if args.fixtures:
        with open(args.fixtures, "w") as f:
            json.dump({"source": "NAIF satellite kernels " + ", ".join(k for k, *_ in KERNELS), "tolerance_km": TOLERANCE_KM, "cases": fixtures}, f)


if __name__ == "__main__":
    main()
