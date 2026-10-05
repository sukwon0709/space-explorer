"""Resample the Edenhofer et al. (2024) 3D dust map onto a box the app can ray-march.

Usage:
    python pipeline/build_dust.py DATA_DIR public/data

Input: DATA_DIR/edenhofer_mean_std_healpix.fits, the posterior mean dust density on
HEALPix spheres (nside 256) at 516 log-spaced distances from 69 to 1,250 pc
(https://zenodo.org/records/10658339), in units of the Zhang, Green and Rix (2023)
extinction E per parsec.

Outputs
  public/data/dust.bin, dust.json   a heliocentric Galactic box, |x|, |y| <= 1,250 pc and
                                    |z| <= 400 pc, in 256 x 256 x 80 cells (9.8 x 9.8 x
                                    10 pc), each the mean density over the cell (8 samples),
                                    stored as uint8 v with A_V per pc = scale * (v / 255)^2.
                                    x runs fastest (toward the Galactic centre), then y
                                    (toward l = 90), then z (toward the north Galactic pole).
  DATA_DIR/dust-grid.npz            the same grid as float A_V per pc, for build_stars.py

E is converted to A_V with A_V = 2.8 E (Edenhofer et al. 2024, section 2). As a check, the
median ratio of Gaia DR3 GSP-Phot A_V (A_G / 0.789, Wang and Chen 2019) to the map's
integrated E for stars 300-1,000 pc away is printed; GSP-Phot runs high at low
extinction, so it comes out somewhat above 2.8. Stars beyond the box get no dust from
beyond it.
"""

import argparse
import json
import os

import healpy as hp
import numpy as np
import pandas as pd
from astropy.io import fits

SHAPE = (256, 256, 80)
LO = np.array([-1250.0, -1250.0, -400.0])
HI = np.array([1250.0, 1250.0, 400.0])
AG_PER_AV = 0.789
AV_PER_E = 2.8


def sample_density(mean, centers, inner, p):
    """E per pc at heliocentric Galactic points p (n, 3): nearest HEALPix pixel, linear in distance."""
    r = np.linalg.norm(p, axis=1)
    pix = hp.vec2pix(256, p[:, 0], p[:, 1], p[:, 2], nest=True)
    lr, lc = np.log(np.maximum(r, 1e-3)), np.log(centers)
    f = np.interp(lr, lc, np.arange(len(centers)))
    i0 = np.clip(np.floor(f).astype(int), 0, len(centers) - 2)
    w = np.clip(f - i0, 0, 1)
    out = mean[i0, pix] * (1 - w) + mean[i0 + 1, pix] * w
    # Inside the innermost shell the map gives only the integral out to 68.8 pc.
    inside = r < centers[0]
    out[inside] = inner[pix[inside]] / 68.8
    out[r > centers[-1]] = 0
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    parser.add_argument("out")
    args = parser.parse_args()
    with fits.open(os.path.join(args.data, "edenhofer_mean_std_healpix.fits"), memmap=True) as f:
        print("reading the map")
        mean = np.asarray(f["MEAN"].data, dtype=np.float32)
        centers = np.asarray(f["RADIAL PIXEL CENTERS"].data["radial pixel centers"], dtype=np.float64)
        inner = np.asarray(f["MEAN OF INTEGRATED INNER 68.8 PC"].data, dtype=np.float32)

    cell = (HI - LO) / np.array(SHAPE)
    grid = np.zeros(SHAPE[::-1], np.float32)  # (z, y, x)
    xs = LO[0] + (np.arange(SHAPE[0]) + 0.5) * cell[0]
    ys = LO[1] + (np.arange(SHAPE[1]) + 0.5) * cell[1]
    offsets = np.array([[dx, dy, dz] for dx in (-0.25, 0.25) for dy in (-0.25, 0.25) for dz in (-0.25, 0.25)]) * cell
    X, Y = np.meshgrid(xs, ys, indexing="xy")  # (y, x)
    for k in range(SHAPE[2]):
        z = LO[2] + (k + 0.5) * cell[2]
        base = np.stack([X.ravel(), Y.ravel(), np.full(X.size, z)], axis=-1)
        acc = np.zeros(len(base))
        for o in offsets:
            acc += sample_density(mean, centers, inner, base + o)
        grid[k] = (acc / len(offsets)).reshape(X.shape)
        if k % 10 == 0:
            print(f"slice {k + 1}/{SHAPE[2]}")

    # Check E -> A_V against Gaia GSP-Phot for stars 300-1,000 pc away in the box.
    gaia = pd.read_csv(os.path.join(args.data, "stars", "gaia-g10.csv"),
                       usecols=["ra", "dec", "parallax", "parallax_error", "ag_gspphot"])
    gaia = gaia[np.isfinite(gaia.ag_gspphot) & (gaia.parallax > 1) & (gaia.parallax < 3.3) & (gaia.parallax > 10 * gaia.parallax_error)]
    from build_stars import Dust, ICRS_TO_GAL, unit

    pos = unit(gaia.ra.to_numpy(), gaia.dec.to_numpy()) * (1000 / gaia.parallax.to_numpy())[:, None]
    gal = pos @ ICRS_TO_GAL.T
    keep = np.all((gal > LO) & (gal < HI), axis=1)
    np.savez(os.path.join(args.data, "dust-grid-e.npz"), density=grid.transpose(2, 1, 0), lo=LO + cell / 2, hi=HI - cell / 2)
    e_int = Dust(os.path.join(args.data, "dust-grid-e.npz")).extinction_from_sun(pos[keep])
    av = gaia.ag_gspphot.to_numpy()[keep] / AG_PER_AV
    good = e_int > 0.05
    ratio = av[good] / e_int[good]
    scale = AV_PER_E
    print(f"Gaia GSP-Phot A_V / E = {np.median(ratio):.3f} (median of {int(good.sum())} Gaia stars 300-1000 pc; 16-84%: "
          f"{np.percentile(ratio, 16):.2f}-{np.percentile(ratio, 84):.2f}); using {scale}")

    av_grid = grid * scale
    top = float(np.percentile(av_grid[av_grid > 0], 99.99))
    q = np.clip(np.round(np.sqrt(np.clip(av_grid / top, 0, 1)) * 255), 0, 255).astype(np.uint8)
    q.tofile(os.path.join(args.out, "dust.bin"))  # (z, y, x) C order = x fastest
    with open(os.path.join(args.out, "dust.json"), "w") as f:
        json.dump({"shape": list(SHAPE), "lo": (LO + cell / 2).tolist(), "hi": (HI - cell / 2).tolist(), "scale": top,
                   "units": "A_V per pc = scale * (v / 255)^2", "source": "Edenhofer et al. 2024 (mean), E to A_V x %.3f" % scale}, f, indent=1)
    decoded = (q.astype(np.float32) / 255) ** 2 * top
    np.savez(os.path.join(args.data, "dust-grid.npz"), density=decoded.transpose(2, 1, 0), lo=LO + cell / 2, hi=HI - cell / 2)
    print(f"wrote dust.bin ({q.size} cells), peak A_V {top:.4f} mag/pc")


if __name__ == "__main__":
    main()
