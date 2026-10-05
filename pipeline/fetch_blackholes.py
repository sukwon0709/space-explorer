"""The stars orbiting Sgr A*, and the Event Horizon Telescope images to compare with.

Usage:
    python pipeline/fetch_blackholes.py DATA_DIR public/data

Writes public/data/blackholes/:

  - sstars.json: the orbits of the 40 S-stars around Sgr A* from 25 years of VLT and
    Keck astrometry (Gillessen et al. 2017, VizieR J/ApJ/837/30, table 3), with S2
    replaced by the GRAVITY 2020 orbit (A&A 636, L5, Table 1). Semi-major axes are in
    arcseconds; the app turns them into AU at its distance to Sgr A*.
  - m87-eht.jpg and sgra-eht.jpg: the EHT images of M87* (2017 data, ESO eso1907a) and
    Sgr A* (ESO eso2208-eht-mwa), credit EHT Collaboration, CC BY 4.0. ESO gives no
    angular scale for them, so each is scaled so that its ring (the radius where the
    azimuthally averaged brightness peaks) has the diameter the EHT measured: 42 and
    51.8 microarcseconds. The crops are centred on the ring, up to 160 microarcseconds square.
  - eht.json: the field of view of each crop.

Downloads are cached in DATA_DIR/blackholes/.
"""

import argparse
import io
import json
import os
import urllib.request

import numpy as np
from PIL import Image

VIZIER = "https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=J/ApJ/837/30/table3&-out.all&-out.max=100"
IMAGES = {
    # name: (url, measured ring diameter in microarcseconds)
    "m87-eht": ("https://cdn.eso.org/images/large/eso1907a.jpg", 42.0),
    "sgra-eht": ("https://cdn.eso.org/images/large/eso2208-eht-mwa.jpg", 51.8),
}
FIELD_UAS = 160.0
SIZE = 256

# GRAVITY Collaboration 2020 (arXiv:2004.07187), Table 1.
S2_GRAVITY = {"a": 0.125058, "e": 0.884649, "i": 134.567, "Omega": 228.171, "omega": 66.263, "tp": 2018.379, "period": 16.0455}


def fetch(url: str, cache: str) -> bytes:
    if os.path.exists(cache):
        with open(cache, "rb") as f:
            return f.read()
    req = urllib.request.Request(url, headers={"User-Agent": "space-explorer pipeline"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    with open(cache, "wb") as f:
        f.write(data)
    return data


def sstars(cache_dir: str) -> list:
    text = fetch(VIZIER, os.path.join(cache_dir, "gillessen2017.tsv")).decode()
    rows = [line.split("\t") for line in text.splitlines() if line and not line.startswith("#")]
    header, rows = rows[0], rows[3:]
    col = {name: k for k, name in enumerate(header)}
    out = []
    for r in rows:
        if len(r) < len(header):
            continue
        name = r[col["Star"]].strip()
        star = {
            "name": name,
            "a": float(r[col["a"]]), "e": float(r[col["e"]]), "i": float(r[col["i"]]),
            "Omega": float(r[col["Omega"]]), "omega": float(r[col["w"]]), "tp": float(r[col["Tp"]]),
            "period": float(r[col["Per"]]) if r[col["Per"]].strip() else None,
            "K": float(r[col["Kmag"]]), "type": r[col["SpT"]].strip() or "e",
            "source": "Gillessen et al. 2017",
        }
        if star["a"] <= 0 or star["e"] >= 1:
            continue  # unbound or unconstrained fits
        if name == "S2":
            star.update(S2_GRAVITY, source="GRAVITY 2020")
        out.append(star)
    return out


def ring_image(data: bytes, ring_uas: float) -> tuple:
    """Crop the image around its ring, scaled to FIELD_UAS, and return it with the scale used."""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    a = np.asarray(img, dtype=np.float64) / 255.0
    lum = a @ np.array([0.2126, 0.7152, 0.0722])
    h, w = lum.shape
    # Centre: the dark middle of the ring, the faintest point (on a blurred copy) near
    # the centroid of the bright ring.
    bright = np.where(lum > 0.5 * lum.max(), lum, 0)
    yy, xx = np.mgrid[0:h, 0:w]
    cy0, cx0 = (bright * yy).sum() / bright.sum(), (bright * xx).sum() / bright.sum()
    k = max(1, min(h, w) // 200)
    small = lum[: h // k * k, : w // k * k].reshape(h // k, k, w // k, k).mean(axis=(1, 3))
    small = sum(np.roll(np.roll(small, dy, 0), dx, 1) for dy in range(-3, 4) for dx in range(-3, 4)) / 49
    sy, sx = np.mgrid[0 : small.shape[0], 0 : small.shape[1]]
    near = np.hypot(sy * k - cy0, sx * k - cx0) < 0.15 * min(h, w)
    j = np.argmin(np.where(near, small, np.inf))
    cy, cx = (j // small.shape[1] + 0.5) * k, (j % small.shape[1] + 0.5) * k
    # Ring radius: where the azimuthally averaged brightness peaks.
    rr = np.hypot(yy - cy, xx - cx)
    rmax = int(min(h, w) * 0.45)
    profile = np.bincount(rr.astype(int).ravel(), weights=lum.ravel(), minlength=rmax)[:rmax]
    counts = np.bincount(rr.astype(int).ravel(), minlength=rmax)[:rmax]
    profile = profile / np.maximum(counts, 1)
    peak = int(np.argmax(profile[5:])) + 5
    # Refine with a parabola through the peak.
    y0, y1, y2 = profile[peak - 1], profile[peak], profile[peak + 1]
    peak_f = peak + 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2)
    uas_per_px = ring_uas / (2 * peak_f)
    half = min(FIELD_UAS / 2 / uas_per_px, cx, cy, w - cx, h - cy)
    box = (cx - half, cy - half, cx + half, cy + half)
    crop = img.resize((SIZE, SIZE), Image.LANCZOS, box=box)
    return crop, uas_per_px, peak_f, 2 * half * uas_per_px


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("data_dir")
    ap.add_argument("out_dir")
    args = ap.parse_args()
    cache = os.path.join(args.data_dir, "blackholes")
    out = os.path.join(args.out_dir, "blackholes")
    os.makedirs(cache, exist_ok=True)
    os.makedirs(out, exist_ok=True)

    stars = sstars(cache)
    with open(os.path.join(out, "sstars.json"), "w") as f:
        json.dump({"source": "Gillessen et al. 2017 (VizieR J/ApJ/837/30); S2: GRAVITY 2020", "stars": stars}, f, separators=(",", ":"))
    print(f"{len(stars)} S-stars")

    meta = {}
    for name, (url, ring) in IMAGES.items():
        data = fetch(url, os.path.join(cache, os.path.basename(url)))
        crop, scale, radius, field = ring_image(data, ring)
        crop.save(os.path.join(out, f"{name}.jpg"), quality=90)
        meta[name] = {"field": round(field, 2), "ring": ring, "credit": "EHT Collaboration", "licence": "CC BY 4.0", "source": url}
        print(f"{name}: ring radius {radius:.1f} px, {scale:.4f} uas/px")
    with open(os.path.join(out, "eht.json"), "w") as f:
        json.dump(meta, f, indent=1)


if __name__ == "__main__":
    main()
