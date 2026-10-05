"""Measure the local stellar luminosity function from the star catalogue, for the Milky Way glow.

Usage:
    python pipeline/build_milkyway.py public/data src/generated/milkyway.json

The Milky Way's diffuse glow is the light of the stars too faint to be drawn one by one.
The glow model (src/core/milkyway.ts) needs two numbers from real stars near the Sun:

  rhoLocal  the V-band luminosity density at the Sun (solar luminosities per pc^3), which
            normalises the Galactic disc model
  lf        the fraction of that light coming from stars brighter than each absolute V
            magnitude, so the glow can leave out exactly the stars the app draws

Both come from the star octree (pipeline/build_stars.py, so Gaia DR3 and Hipparcos):
stars fainter than M_V = 0 from the 100 pc sphere (complete to Gaia's limit), and the
rarer luminous stars from a 400 pc radius, 200 pc thick cylinder in the Galactic plane
(complete to G = 12 for M_V < 0 apart from heavily reddened stars).
"""

import argparse
import json
import os

import numpy as np

ICRS_TO_GAL = np.array([
    [-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
    [+0.4941094278755837, -0.4448296299600112, +0.7469822444972189],
    [-0.8676661490190047, -0.1980763734312015, +0.4559837761750669],
])
M_SUN_V = 4.83
BINS = np.arange(-8.0, 16.51, 0.5)


def load_stars(data: str):
    index = json.load(open(os.path.join(data, "stars", "index.json")))
    packs: dict[int, bytes] = {}
    pos, absmag = [], []
    for level, cx, cy, cz, half, count, min_m, max_m, pack, offset, parent, children in index["nodes"]:
        if pack not in packs:
            packs[pack] = open(os.path.join(data, "stars", f"pack-{pack}.bin"), "rb").read()
        blob = packs[pack]
        pos.append(np.frombuffer(blob, "<f4", count * 3, offset).reshape(-1, 3))
        absmag.append(np.frombuffer(blob, "<i2", count, offset + 18 * count) / 1000)
    return np.concatenate(pos).astype(float), np.concatenate(absmag)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("data")
    parser.add_argument("out")
    args = parser.parse_args()
    pos, m = load_stars(args.data)
    gal = pos @ ICRS_TO_GAL.T
    r = np.linalg.norm(pos, axis=1)
    cyl = (np.hypot(gal[:, 0], gal[:, 1]) < 400) & (np.abs(gal[:, 2]) < 100)
    lum = 10 ** (-0.4 * (m - M_SUN_V))
    sphere = r < 100
    per_bin_sphere = np.histogram(m[sphere], BINS, weights=lum[sphere])[0] / (4 / 3 * np.pi * 100**3)
    per_bin_cyl = np.histogram(m[cyl], BINS, weights=lum[cyl])[0] / (np.pi * 400**2 * 200)
    centres = (BINS[:-1] + BINS[1:]) / 2
    per_bin = np.where(centres < 0, per_bin_cyl, per_bin_sphere)
    rho = float(per_bin.sum())
    # cum[k]: fraction of the light from stars brighter than BINS[k].
    cum = np.concatenate([[0.0], np.cumsum(per_bin)]) / rho
    out = {
        "source": "Gaia DR3 and Hipparcos stars of the app's catalogue near the Sun (pipeline/build_milkyway.py)",
        "rhoLocal": round(rho, 5),
        "lf": {"m0": float(BINS[0]), "step": 0.5, "cum": [round(float(c), 5) for c in cum]},
    }
    with open(args.out, "w") as f:
        json.dump(out, f, indent=1)
    print(f"local V luminosity density {rho:.4f} Lsun/pc^3; half the light from M_V < {np.interp(0.5, cum, BINS):.2f}")


if __name__ == "__main__":
    main()
