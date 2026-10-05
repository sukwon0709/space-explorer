"""The cosmic microwave background map for the app.

Usage:
    python pipeline/build_cmb.py DATA_DIR public/data

Reads the Planck PR3 SMICA temperature map (DATA_DIR/galaxies/planck-cmb.fits, Galactic
plate carree, from fetch_galaxies.py) and writes public/data/cmb.png: 8-bit greyscale,
north Galactic pole at the top, longitude 0 at the centre and increasing to the left,
with the temperature difference from the 2.7255 K mean mapped linearly from -500 uK (0)
to +500 uK (255). The app colours it (false colour: the light is microwaves).
"""

import argparse
import json
import os

import numpy as np
from astropy.io import fits
from PIL import Image

RANGE_UK = 500.0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("data")
    parser.add_argument("out")
    args = parser.parse_args()
    with fits.open(os.path.join(args.data, "galaxies", "planck-cmb.fits")) as f:
        h = f[0].header
        t = np.asarray(f[0].data, float) * 1e6  # K to uK
    assert h["CTYPE1"].startswith("GLON") and h["CDELT1"] < 0 and h["CDELT2"] > 0
    # FITS rows run from the south; images from the top.
    t = t[::-1]
    print(f"{t.shape[1]} x {t.shape[0]}: rms {np.std(t):.1f} uK, {np.mean(np.abs(t) > RANGE_UK) * 100:.2f}% beyond +-{RANGE_UK:.0f} uK")
    v = np.clip((t + RANGE_UK) / (2 * RANGE_UK), 0, 1)
    Image.fromarray(np.round(v * 255).astype(np.uint8), "L").save(os.path.join(args.out, "cmb.png"), optimize=True)
    with open(os.path.join(args.out, "cmb.json"), "w") as f:
        json.dump({"source": "Planck PR3 SMICA (ESA, Planck Collaboration 2020), via CDS hips2fits",
                   "rangeMicroKelvin": RANGE_UK, "meanKelvin": 2.7255}, f, indent=1)


if __name__ == "__main__":
    main()
