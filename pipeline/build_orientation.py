"""Build the body orientation file (Earth and Moon) from NAIF SPICE kernels.

Earth: ITRF93, from NAIF's Earth orientation kernels. They carry the measured
       IERS Earth orientation (UT1, polar motion, precession and nutation) from
       1962 to the kernel's release date, and IERS predictions after that.
Moon:  MOON_ME (mean Earth / polar axis), the frame LRO's LOLA and LROC maps use,
       from the DE440 lunar libration angles plus the fixed PA-to-ME offset.

SPICE gives the ICRF-to-body rotation matrix at any epoch. This script samples it,
turns each matrix into 3-1-3 Euler angles (phi, theta, psi), unwraps them, and fits
Chebyshev polynomials per fixed-length record. The output uses the same file layout
as the ephemeris (see build_ephemeris.py), with the three components being angles
in radians instead of km. The fit error is checked here and in
tests/orientation.test.ts against SPICE matrices at epochs that were not fitted.

Usage:
    python pipeline/build_orientation.py KERNEL_DIR public/data/orientation.bin \
        --start 1962-02-01 --end 2060-12-31 --fixtures tests/fixtures/orientation-reference.json
KERNEL_DIR needs naif0012.tls, earth_1962_*_combined.bpc, earth_latest_high_prec.bpc,
earth_assoc_itrf93.tf, moon_pa_de440_200625.bpc and moon_de440_250416.tf
(all from https://naif.jpl.nasa.gov/pub/naif/generic_kernels/).
"""

import argparse
import glob
import json
import os
import struct

import numpy as np
import spiceypy as sp

from build_ephemeris import HEADER, MAGIC, SEGMENT, VERSION

# body id, SPICE frame, record length (days), coefficients per angle
BODIES = [
    (399, "ITRF93", 2.0, 14),
    (301, "MOON_ME", 8.0, 14),
]


def load_kernels(directory: str) -> None:
    patterns = ["naif0012.tls", "earth_assoc_itrf93.tf", "earth_1962_*_combined.bpc", "earth_latest_high_prec.bpc", "moon_de440_*.tf", "moon_pa_de440_*.bpc"]
    for pattern in patterns:  # later kernels take priority where they overlap
        matches = sorted(glob.glob(os.path.join(directory, pattern)))
        if not matches:
            raise FileNotFoundError(f"{pattern} not found in {directory}")
        sp.furnsh(matches[-1])


def euler313(m: np.ndarray) -> tuple[float, float, float]:
    """Angles with m = R3(psi) R1(theta) R3(phi), using frame-rotation matrices."""
    theta = np.arccos(np.clip(m[2, 2], -1, 1))
    phi = np.arctan2(m[2, 0], -m[2, 1])
    psi = np.arctan2(m[0, 2], m[1, 2])
    return phi, theta, psi


def matrix313(phi: float, theta: float, psi: float) -> np.ndarray:
    def r1(a):
        c, s = np.cos(a), np.sin(a)
        return np.array([[1, 0, 0], [0, c, s], [0, -s, c]])

    def r3(a):
        c, s = np.cos(a), np.sin(a)
        return np.array([[c, s, 0], [-s, c, 0], [0, 0, 1]])

    return r3(psi) @ r1(theta) @ r3(phi)


def angles(frame: str, ets: np.ndarray) -> np.ndarray:
    return np.array([euler313(np.array(sp.pxform("J2000", frame, et))) for et in ets])


def rotation_error(a: np.ndarray, b: np.ndarray) -> float:
    """Angle (radians) of the rotation between two matrices."""
    r = a @ b.T
    # sin(angle) from the antisymmetric part; arccos of the trace loses precision near 0.
    axis = np.array([r[1, 2] - r[2, 1], r[2, 0] - r[0, 2], r[0, 1] - r[1, 0]]) / 2
    return float(np.arcsin(min(1.0, np.linalg.norm(axis))))


def fit_body(frame: str, t0: float, t1: float, days: float, ncoef: int):
    intlen = days * 86400.0
    nrec = int(np.ceil((t1 - t0) / intlen))
    # Chebyshev-Lobatto nodes per record. Angles are unwrapped inside each record only:
    # unwrapping psi (2*pi a day) across decades accumulates ~1e-7 rad of rounding.
    nodes = np.cos(np.pi * np.arange(2 * ncoef)[::-1] / (2 * ncoef - 1))
    ets = (t0 + (np.arange(nrec)[:, None] + (nodes[None, :] + 1) / 2) * intlen).ravel()
    values = np.unwrap(angles(frame, ets).reshape(nrec, len(nodes), 3), axis=1)
    coef = np.empty((nrec, 3, ncoef))
    for r in range(nrec):
        for axis in range(3):
            coef[r, axis] = np.polynomial.chebyshev.chebfit(nodes, values[r, :, axis], ncoef - 1)
    return t0, intlen, coef


def check(frame: str, t0: float, intlen: float, coef: np.ndarray, samples: int = 4000) -> float:
    rng = np.random.default_rng(301)
    worst = 0.0
    for et in rng.uniform(t0, t0 + intlen * len(coef), samples):
        r = min(int((et - t0) // intlen), len(coef) - 1)
        s = 2 * (et - t0 - r * intlen) / intlen - 1
        a = [np.polynomial.chebyshev.chebval(s, coef[r, axis]) for axis in range(3)]
        worst = max(worst, rotation_error(matrix313(*a), np.array(sp.pxform("J2000", frame, et))))
    return worst


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("kernels")
    parser.add_argument("out")
    parser.add_argument("--start", default="1962-02-01")
    parser.add_argument("--end", default="2060-12-31")
    parser.add_argument("--fixtures", help="also write SPICE reference matrices (JSON) for the tests")
    args = parser.parse_args()
    load_kernels(args.kernels)
    t0, t1 = sp.str2et(args.start + " TDB"), sp.str2et(args.end + " TDB")

    if args.fixtures:
        rng = np.random.default_rng(399)
        cases = [
            {"body": body, "tdb": float(et), "matrix": np.array(sp.pxform("J2000", frame, et)).ravel().tolist()}
            for body, frame, *_ in BODIES
            for et in np.concatenate([[t0 + 1, t1 - 1], rng.uniform(t0, t1, 150)])
        ]
        with open(args.fixtures, "w") as f:
            json.dump({"source": "SPICE pxform J2000 -> ITRF93 / MOON_ME, row-major", "cases": cases}, f)
        print(f"wrote {args.fixtures}: {len(cases)} reference matrices")

    segments = []
    for body, frame, days, ncoef in BODIES:
        init, intlen, coef = fit_body(frame, t0, t1, days, ncoef)
        worst = check(frame, init, intlen, coef)
        print(f"{frame}: {len(coef)} records x {ncoef} coefficients, worst fit error {worst:.2e} rad")
        if worst > 5e-8:  # 5e-8 rad is 30 cm on Earth's surface
            raise RuntimeError(f"{frame} fit error {worst} rad is too large")
        segments.append((1, body, init, intlen, coef))  # centre 1 = J2000/ICRF

    offset = HEADER.size + SEGMENT.size * len(segments)
    offset += -offset % 8
    with open(args.out, "wb") as f:
        f.write(HEADER.pack(MAGIC, VERSION, len(segments), 0))
        data_offsets = []
        for center, target, init, intlen, coef in segments:
            nrec, _, ncoef = coef.shape
            f.write(SEGMENT.pack(center, target, init, intlen, ncoef, nrec, offset, 0))
            data_offsets.append(offset)
            offset += coef.nbytes
        f.write(b"\0" * (data_offsets[0] - f.tell()))
        for (*_, coef), at in zip(segments, data_offsets):
            assert f.tell() == at
            f.write(np.ascontiguousarray(coef, dtype="<f8").tobytes())
    print(f"wrote {args.out}: {offset / 1e6:.2f} MB, {args.start}..{args.end}")


if __name__ == "__main__":
    main()
