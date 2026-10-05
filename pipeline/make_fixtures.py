"""Write reference positions computed by jplephem (JPL's reference SPK reader for Python).

The TypeScript ephemeris tests compare against these, so any error in the
conversion or the Chebyshev evaluation shows up as a position mismatch.
"""

import argparse
import json

import numpy as np
from jplephem.spk import SPK

J2000_JD = 2451545.0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("kernel")
    parser.add_argument("out")
    parser.add_argument("--start", default="1990-01-01")
    parser.add_argument("--end", default="2050-12-31")
    parser.add_argument("--samples", type=int, default=200)
    args = parser.parse_args()

    kernel = SPK.open(args.kernel)
    t0 = (np.datetime64(args.start) - np.datetime64("2000-01-01T12:00")) / np.timedelta64(1, "s")
    t1 = (np.datetime64(args.end) - np.datetime64("2000-01-01T12:00")) / np.timedelta64(1, "s")
    rng = np.random.default_rng(421)
    # Random epochs plus both ends, so record boundaries and range edges are exercised.
    epochs = np.concatenate([[t0, t1], rng.uniform(t0, t1, args.samples)])

    cases = []
    for seg in kernel.segments:
        for t in epochs:
            whole = J2000_JD + np.floor(t / 86400.0)
            frac = (t - np.floor(t / 86400.0) * 86400.0) / 86400.0
            pos = seg.compute(whole, frac)
            cases.append({"center": seg.center, "target": seg.target, "tdb": float(t), "km": [float(v) for v in pos]})

    with open(args.out, "w") as f:
        json.dump({"kernel": args.kernel.split("/")[-1], "cases": cases}, f)
    print(f"wrote {args.out}: {len(cases)} reference positions")


if __name__ == "__main__":
    main()
