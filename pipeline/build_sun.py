"""Build the Sun's surface map from an SDO/HMI continuum image.

SDO's HMI instrument images the photosphere in white light every 15 minutes. NASA's
"flattened" quick-look (HMIIF) already has limb darkening divided out and is rotated
so solar north is up, so each pixel is the photosphere's relative brightness: sunspots
dark, faculae a little bright. This script projects one image back onto the Sun's
surface in the IAU_SUN frame (the frame the renderer rotates the Sun with), using
the sub-Earth point JPL Horizons gives for the image time, and writes an
equirectangular map. Only the hemisphere facing Earth at that time was seen; the far
side is filled with quiet photosphere (relative brightness 1), and the seam is
blended over the outer part of the disc where the projection is foreshortened.

The renderer puts limb darkening back and records the image time on screen: spots
evolve over days, so the map is a snapshot, not a forecast.

Usage:
    python pipeline/build_sun.py 2026-09-21T23:45:00 OUT_DIR/sun.jpg src/generated/sun.json
"""

import argparse
import io
import json
import re
import urllib.request
from datetime import datetime

import numpy as np
from PIL import Image

BROWSE = "https://sdo.gsfc.nasa.gov/assets/img/browse/{t:%Y/%m/%d}/{t:%Y%m%d_%H%M%S}_4096_HMIIF.jpg"
HORIZONS = (
    "https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND='10'&CENTER='500@399'"
    "&MAKE_EPHEM=YES&EPHEM_TYPE=OBSERVER&QUANTITIES='14'&ANG_FORMAT=DEG&TLIST='{t:%Y-%m-%d %H:%M:%S}'"
)
# Brightness stored in the 8-bit map is relative intensity / SCALE.
SCALE = 1.25


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url.replace(" ", "%20"), timeout=120) as r:
        return r.read()


def sub_earth(t: datetime) -> tuple[float, float]:
    """Apparent sub-Earth longitude (east) and latitude on the Sun, IAU_SUN, degrees."""
    text = fetch(HORIZONS.format(t=t)).decode()
    row = text.split("$$SOE")[1].split("$$EOE")[0].strip()
    lon, lat = map(float, re.findall(r"-?\d+\.\d+", row)[-2:])
    return lon, lat


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("time", help="HMI image time, UTC, on a 15-minute boundary")
    parser.add_argument("out")
    parser.add_argument("manifest")
    parser.add_argument("--width", type=int, default=2048)
    args = parser.parse_args()
    t = datetime.fromisoformat(args.time)

    image = np.asarray(Image.open(io.BytesIO(fetch(BROWSE.format(t=t)))).convert("RGB"), dtype=np.float64)
    lum = image @ [0.2126, 0.7152, 0.0722]
    disc = lum > 40
    disc[int(0.95 * len(disc)) :, : len(disc) // 3] = False  # the caption at the bottom left
    ys, xs = np.nonzero(disc)
    cx, cy, radius = xs.mean(), ys.mean(), np.sqrt(disc.sum() / np.pi)
    quiet = np.median(lum[disc])
    print(f"disc centre ({cx:.1f}, {cy:.1f}) radius {radius:.1f} px, quiet Sun level {quiet:.0f}")
    # Some browse images are truncated (grey below the last row received): reject them.
    if radius > 0.48 * len(lum) or abs(cx - len(lum) / 2) > 0.02 * len(lum) or abs(cy - len(lum) / 2) > 0.02 * len(lum):
        raise RuntimeError("the disc is not a centred circle; the image is probably incomplete, try another time")

    lon0, lat0 = np.radians(sub_earth(t))
    e = np.array([np.cos(lat0) * np.cos(lon0), np.cos(lat0) * np.sin(lon0), np.sin(lat0)])
    up = np.array([0.0, 0.0, 1.0]) - e[2] * e
    up /= np.linalg.norm(up)
    right = np.cross(up, e)  # viewer looks along -e; right x up = e

    w, h = args.width, args.width // 2
    lon = np.radians(-180 + (np.arange(w) + 0.5) * 360 / w)
    lat = np.radians(90 - (np.arange(h) + 0.5) * 180 / h)
    lon, lat = np.meshgrid(lon, lat)
    v = np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], axis=-1)
    mu = v @ e
    px = np.clip(np.rint(cx + radius * (v @ right)), 0, lum.shape[1] - 1).astype(int)
    py = np.clip(np.rint(cy - radius * (v @ up)), 0, lum.shape[0] - 1).astype(int)
    seen = lum[py, px] / quiet
    weight = np.clip((mu - 0.15) / 0.25, 0, 1)
    weight = weight * weight * (3 - 2 * weight)
    relative = weight * seen + (1 - weight)

    Image.fromarray(np.clip(relative / SCALE * 255, 0, 255).round().astype(np.uint8), "L").save(args.out, quality=90)
    manifest = {
        "source": "NASA SDO/HMI continuum intensitygram (flattened quick-look), projected to IAU_SUN",
        "time": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sub_earth_deg": [float(np.degrees(lon0)), float(np.degrees(lat0))],
        "scale": SCALE,
        "coverage": float((weight > 0).mean()),
    }
    with open(args.manifest, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"wrote {args.out} and {args.manifest}: {manifest}")


if __name__ == "__main__":
    main()
