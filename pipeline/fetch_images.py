"""Telescope images of the nearest and largest galaxies and the bright nebulae.

Usage:
    python pipeline/fetch_images.py DATA_DIR public/data

For each object, a Digitized Sky Survey 2 colour image (POSS-II and UK Schmidt plates,
via CDS hips2fits) is cut out north up, east left, and cleaned for the app:

  - Foreground Milky Way stars are removed: every Gaia DR3 star in the field with a
    significant parallax or proper motion (members of the LMC or M31 have neither) is
    masked with a radius that grows with its brightness, and the hole is filled from the
    surrounding light (normalised Gaussian interpolation). The app draws those stars
    itself at their own distances.
  - Other catalogue galaxies in the field (M32 and M110 beside M31) are masked the same
    way, since the app draws them in their own places.
  - The sky background is subtracted and the frame fades out at its edge.

Writes public/data/images/<slug>.jpg and public/data/images/index.json, with each
image's centre, field of view and mean linear pixel value (the app scales each image so
that its total light matches the object's catalogue magnitude). Gaia queries and raw
cutouts are cached in DATA_DIR/images/.
"""

import argparse
import io
import json
import math
import os
import re
import time
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image
from scipy import ndimage

HIPS2FITS = "https://alasky.cds.unistra.fr/hips-image-services/hips2fits"
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"

# Galaxies with images, by their names in galaxies/index.json, and image width (px).
GALAXIES = {
    "Andromeda Galaxy": 1024, "Triangulum Galaxy": 1024, "Large Magellanic Cloud": 1024, "Small Magellanic Cloud": 1024,
    "Sculptor Galaxy": 1024, "Bode's Galaxy": 768, "Cigar Galaxy": 512, "Whirlpool Galaxy": 768, "Pinwheel Galaxy": 768,
    "Sombrero Galaxy": 512, "Southern Pinwheel Galaxy": 768, "Centaurus A": 768, "M87 (Virgo A)": 512, "Black Eye Galaxy": 512,
    "Sunflower Galaxy": 512, "M106": 768, "NGC 300": 768, "NGC 55": 768, "M74": 512, "M77": 512, "M66": 512, "M65": 512,
    "Needle Galaxy": 512, "NGC 891": 512, "NGC 2403": 768, "M94": 512, "IC 342": 768, "NGC 6946": 768, "M49": 512, "M86": 512,
    "M84": 512, "M60": 512, "Fornax A": 512, "NGC 1365": 512, "NGC 1399": 512, "Whale Galaxy": 512, "M108": 512, "M109": 512,
    "NGC 7331": 512, "NGC 2903": 512, "M100": 512, "M61": 512, "M99": 512, "M88": 512, "M90": 512, "M58": 512, "M95": 512,
    "M96": 512, "M105": 512, "NGC 3115": 512, "NGC 4945": 768, "Antennae Galaxies": 512, "NGC 1300": 512, "NGC 1097": 512,
    "NGC 2997": 512, "NGC 7793": 512, "NGC 247": 768, "NGC 4449": 512, "M110": 512, "M32": 256, "Barnard's Galaxy": 768,
    "NGC 5195": 512, "M83": 768, "M64": 512, "M63": 512, "M101": 768, "M81": 768, "M82": 512,
}

# Bright nebulae: centre (J2000), angular size of the image (degrees), distance (pc) with
# its source, integrated V magnitude (Messier and NGC catalogue values) and kind.
NEBULAE = [
    ("Orion Nebula", ["M42", "NGC 1976"], "05 35 17.3", "-05 23 28", 1.4, 390, "Gaia DR2, Kounkel et al. 2018", 4.0, "emission"),
    ("Lagoon Nebula", ["M8", "NGC 6523"], "18 03 37", "-24 23 12", 1.6, 1250, "Gaia DR2, Damiani et al. 2019", 6.0, "emission"),
    ("Trifid Nebula", ["M20", "NGC 6514"], "18 02 23", "-23 01 48", 0.6, 1200, "Gaia DR2, Kuhn et al. 2019", 6.3, "emission"),
    ("Eagle Nebula", ["M16", "NGC 6611", "Pillars of Creation"], "18 18 48", "-13 49 00", 0.7, 1740, "Gaia DR2, Kuhn et al. 2019", 6.0, "emission"),
    ("Omega Nebula", ["M17", "Swan Nebula", "NGC 6618"], "18 20 26", "-16 10 36", 0.7, 1680, "Gaia DR2, Kuhn et al. 2019", 6.0, "emission"),
    ("Carina Nebula", ["NGC 3372", "Eta Carinae Nebula"], "10 45 08", "-59 52 04", 2.6, 2350, "Gaia DR2, Göppl and Preibisch 2022", 3.0, "emission"),
    ("Rosette Nebula", ["NGC 2237", "Caldwell 49"], "06 33 45", "+04 59 54", 1.6, 1550, "Gaia DR2, Kuhn et al. 2019", 6.0, "emission"),
    ("North America Nebula", ["NGC 7000", "Pelican Nebula", "IC 5070"], "20 55 00", "+44 20 00", 3.2, 795, "Gaia DR2, Kuhn et al. 2020", 4.0, "emission"),
    ("Helix Nebula", ["NGC 7293"], "22 29 38.5", "-20 50 14", 0.45, 200, "Gaia EDR3 central star", 7.6, "planetary nebula"),
    ("Ring Nebula", ["M57", "NGC 6720"], "18 53 35.1", "+33 01 45", 0.07, 790, "Gaia EDR3 central star", 8.8, "planetary nebula"),
    ("Dumbbell Nebula", ["M27", "NGC 6853"], "19 59 36.3", "+22 43 16", 0.2, 390, "Gaia EDR3 central star", 7.5, "planetary nebula"),
    ("Crab Nebula", ["M1", "NGC 1952"], "05 34 31.9", "+22 00 52", 0.15, 2000, "Trimble 1973", 8.4, "supernova remnant"),
    ("Veil Nebula", ["Cygnus Loop", "NGC 6960", "NGC 6992"], "20 51 00", "+30 40 00", 3.6, 735, "Fesen et al. 2021", 7.0, "supernova remnant"),
    ("Pleiades nebulosity", ["Merope Nebula", "NGC 1435"], "03 46 30", "+24 00 00", 1.8, 136, "Gaia DR2 cluster parallax", 8.0, "reflection"),
    ("Horsehead Nebula", ["Barnard 33", "IC 434", "Flame Nebula", "NGC 2024"], "05 41 00", "-02 18 00", 1.3, 400, "Gaia DR2, Zucker et al. 2019", 7.3, "emission"),
    ("Heart Nebula", ["IC 1805"], "02 32 42", "+61 27 00", 2.4, 2100, "Gaia DR2", 6.5, "emission"),
    ("Soul Nebula", ["IC 1848"], "02 51 00", "+60 25 00", 2.0, 2100, "Gaia DR2", 6.5, "emission"),
    ("California Nebula", ["NGC 1499"], "04 03 18", "+36 25 18", 2.8, 450, "Lada et al. 2009", 6.0, "emission"),
    ("Elephant's Trunk Nebula", ["IC 1396"], "21 39 06", "+57 30 00", 3.0, 925, "Gaia DR2, Sicilia-Aguilar et al. 2019", 6.0, "emission"),
    ("Pacman Nebula", ["NGC 281"], "00 52 59", "+56 37 19", 0.6, 2800, "Gaia DR2", 7.4, "emission"),
    ("Bubble Nebula", ["NGC 7635"], "23 20 48", "+61 12 06", 0.4, 2700, "Gaia DR2", 10.0, "emission"),
    ("Cone Nebula", ["NGC 2264", "Christmas Tree Cluster"], "06 41 06", "+09 53 00", 1.2, 720, "Gaia DR2, Maíz Apellániz 2019", 6.5, "emission"),
    ("Seagull Nebula", ["IC 2177"], "07 04 25", "-10 27 00", 2.2, 1100, "Gaia DR2", 7.0, "emission"),
    ("Thor's Helmet", ["NGC 2359"], "07 18 30", "-13 13 48", 0.25, 3670, "Gaia DR2 central star", 10.0, "emission"),
    ("Running Chicken Nebula", ["IC 2944"], "11 38 20", "-63 22 00", 1.4, 1800, "Gaia DR2", 6.0, "emission"),
    ("Tarantula Nebula", ["30 Doradus", "NGC 2070"], "05 38 42", "-69 06 03", 0.7, 49590, "LMC, Pietrzyński et al. 2019", 8.0, "emission"),
]

# Nebulae in a galaxy that has its own image.
WITHIN = {"Tarantula Nebula": "Large Magellanic Cloud"}


def hms(ra: str, dec: str) -> tuple[float, float]:
    h, m, s = (float(x) for x in ra.split())
    sign = -1 if dec.strip().startswith("-") else 1
    d, dm, ds = (abs(float(x)) for x in dec.split())
    return 15 * (h + m / 60 + s / 3600), sign * (d + dm / 60 + ds / 3600)


def fetch(url: str, path: str, data: dict | None = None) -> bytes:
    if os.path.exists(path):
        return open(path, "rb").read()
    body = urllib.parse.urlencode(data).encode() if data else None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=body), timeout=600) as r:
                blob = r.read()
            break
        except OSError as err:
            if attempt == 4:
                raise
            print(f"  retrying after {err}", flush=True)
            time.sleep(5 * 2**attempt)
    open(path, "wb").write(blob)
    return blob


def gaia_foreground(ra: float, dec: float, radius: float, cache: str) -> np.ndarray:
    """Gaia stars in the field that are in the foreground: ra, dec, G."""
    # Wide fields in the Galactic plane hold millions of Gaia stars: go less deep there
    # (the archive times out), which still removes every star the app draws itself.
    glim = 11.5 if radius > 2 else 13 if radius > 0.8 else 16 if radius > 0.3 else 18.5
    query = (
        "SELECT ra, dec, phot_g_mean_mag AS g, parallax, parallax_over_error AS poe, pmra, pmdec FROM gaiadr3.gaia_source "
        f"WHERE 1 = CONTAINS(POINT(ra, dec), CIRCLE({ra:.5f}, {dec:.5f}, {radius:.4f})) AND phot_g_mean_mag < {glim}"
    )
    blob = fetch(GAIA_TAP, cache, {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query})
    rows = [ln.split(",") for ln in blob.decode().strip().split("\n")[1:]]
    if not rows:
        return np.zeros((0, 3))
    a = np.array([[float(x) if x else np.nan for x in r] for r in rows])
    pm = np.hypot(np.nan_to_num(a[:, 5]), np.nan_to_num(a[:, 6]))
    # Foreground: a parallax measured above 5 sigma (and above 0.15 mas), or moving
    # faster than any member of the Magellanic Clouds or a Local Group galaxy could.
    fg = ((np.nan_to_num(a[:, 4]) > 5) & (np.nan_to_num(a[:, 3]) > 0.15)) | (pm > 4)
    # Bright stars without astrometry (too bright for Gaia's solution) are foreground.
    fg |= np.isnan(a[:, 3]) & (a[:, 2] < 10)
    return a[fg][:, :3]


def tangent(ra0, dec0, ra, dec):
    """Gnomonic projection (degrees): x toward east, y toward north."""
    ra0, dec0, ra, dec = (np.radians(v) for v in (ra0, dec0, ra, dec))
    c = np.sin(dec0) * np.sin(dec) + np.cos(dec0) * np.cos(dec) * np.cos(ra - ra0)
    x = np.cos(dec) * np.sin(ra - ra0) / c
    y = (np.cos(dec0) * np.sin(dec) - np.sin(dec0) * np.cos(dec) * np.cos(ra - ra0)) / c
    return np.degrees(x), np.degrees(y)


def clean(img: np.ndarray, fov: float, ra0: float, dec0: float, stars: np.ndarray, others: list) -> np.ndarray:
    """Background-subtracted, star-free linear image (float, 0..)."""
    n = img.shape[0]
    pix = fov / n * 3600  # arcsec per pixel
    lin = (img / 255.0) ** 2.2
    mask = np.zeros((n, n), bool)
    yy, xx = np.mgrid[0:n, 0:n]

    def cut(ra, dec, r_arcsec):
        x, y = tangent(ra0, dec0, ra, dec)
        cx = n / 2 - x * 3600 / pix  # east is left
        cy = n / 2 - y * 3600 / pix  # north is up (row 0 at the top)
        r = r_arcsec / pix
        if cx < -r or cy < -r or cx > n + r or cy > n + r:
            return
        x0, x1 = int(max(0, cx - r - 1)), int(min(n, cx + r + 2))
        y0, y1 = int(max(0, cy - r - 1)), int(min(n, cy + r + 2))
        sub = (xx[y0:y1, x0:x1] - cx) ** 2 + (yy[y0:y1, x0:x1] - cy) ** 2 < r * r
        mask[y0:y1, x0:x1] |= sub

    for ra, dec, g in stars:
        cut(ra, dec, max(2.2 * pix, 4.0 * 10 ** (0.18 * (16 - g))))
    for ra, dec, r in others:
        cut(ra, dec, r)
    keep = (~mask).astype(float)
    out = lin.copy()
    # Fill the holes from the surrounding light, at a scale about the holes' size.
    for sigma in (2, 6, 18, 54):
        w = ndimage.gaussian_filter(keep, sigma)
        for c in range(3):
            v = ndimage.gaussian_filter(lin[..., c] * keep, sigma) / np.maximum(w, 1e-6)
            fill = mask & (w > 0.05)
            out[..., c] = np.where(fill & (keep < 0.5), v, out[..., c])
        keep = np.maximum(keep, (w > 0.05).astype(float))
        if keep.min() >= 0.5:
            break
    # Background: the faintest quarter of the frame's edge, per colour.
    edge = np.concatenate([out[:n // 16].reshape(-1, 3), out[-n // 16:].reshape(-1, 3),
                           out[:, :n // 16].reshape(-1, 3), out[:, -n // 16:].reshape(-1, 3)])
    out = np.clip(out - np.percentile(edge, 40, axis=0), 0, None)
    # Fade out toward the frame's edge (a circle).
    r = np.hypot(xx - n / 2 + 0.5, yy - n / 2 + 0.5) / (n / 2)
    out *= np.clip((1 - r) / 0.15, 0, 1)[..., None]
    return out


def encode(lin: np.ndarray, path: str) -> list[float]:
    """Store sqrt-encoded (the app squares it back), and return the mean linear value per channel."""
    peak = np.percentile(lin.max(axis=2), 99.995) or 1.0
    scaled = np.clip(lin / peak, 0, 1)
    Image.fromarray(np.round(np.sqrt(scaled) * 255).astype(np.uint8)).save(path, quality=90)
    stored = (np.asarray(Image.open(path), float) / 255) ** 2
    return [round(float(v), 6) for v in stored.reshape(-1, 3).mean(axis=0)]


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("data")
    parser.add_argument("out")
    parser.add_argument("--only", help="comma-separated names")
    args = parser.parse_args()
    cache = os.path.join(args.data, "images")
    os.makedirs(cache, exist_ok=True)
    out_dir = os.path.join(args.out, "images")
    os.makedirs(out_dir, exist_ok=True)
    index = json.load(open(os.path.join(args.out, "galaxies", "index.json")))
    blob = open(os.path.join(args.out, "galaxies", "local.bin"), "rb").read()
    n = index["local"]
    pos = np.frombuffer(blob, "<f4", n * 3).reshape(-1, 3).astype(float)
    radius_code = np.frombuffer(blob, np.uint8, n, 12 * n + n)
    flags = np.frombuffer(blob, np.uint8, n, 12 * n + 6 * n)
    named = {g["name"]: g for g in index["named"]}
    for g in index["named"]:
        for a in g["aka"]:
            named.setdefault(a, g)
    d = np.linalg.norm(pos, axis=1)
    gra = np.degrees(np.arctan2(pos[:, 1], pos[:, 0])) % 360
    gdec = np.degrees(np.arcsin(pos[:, 2] / np.maximum(d, 1e-12)))
    r25 = 0.05 * 10 ** (radius_code / 60) * np.where(flags & 16, 3.0, 3.2)  # kpc
    r25_deg = np.degrees(r25 * 1e-3 / np.maximum(d, 1e-9))

    existing = json.load(open(os.path.join(out_dir, "index.json"))) if os.path.exists(os.path.join(out_dir, "index.json")) else {}
    entries = {e["name"]: e for e in existing.get("images", [])}
    only = set(args.only.split(",")) if args.only else None
    jobs = []
    seen = set()
    for name, width in GALAXIES.items():
        g = named.get(name)
        if g is None or g["i"] in seen:
            print(f"skipping {name}: not in the catalogue or already listed")
            continue
        seen.add(g["i"])
        i = g["i"]
        fov = float(min(16, max(0.05, 2.4 * r25_deg[i])))
        jobs.append(dict(name=g["name"], kind="galaxy", ra=float(gra[i]), dec=float(gdec[i]), fov=fov, width=width, index=i))
    for name, aka, ra, dec, fov, dist, source, vmag, kind in NEBULAE:
        r, dd = hms(ra, dec)
        job = dict(name=name, aka=aka, kind=kind, ra=r, dec=dd, fov=fov, width=768 if fov > 1 else 512,
                   dist=dist, source=source, V=vmag)
        if name in WITHIN:
            # Already in its galaxy's own image: a target, but not drawn twice.
            job["within"] = WITHIN[name]
        jobs.append(job)
    def save() -> None:
        with open(os.path.join(out_dir, "index.json"), "w") as f:
            json.dump({"source": "DSS2 colour (POSS-II, UKSTU) via CDS hips2fits; foreground stars removed with Gaia DR3",
                       "images": list(entries.values())}, f, indent=1)

    failed = []
    for job in jobs:
        if only and job["name"] not in only:
            continue
        try:
            entries[job["name"]] = process(job, cache, out_dir, n, gra, gdec, r25_deg)
        except OSError as err:
            print(f"  failed: {err}", flush=True)
            failed.append(job["name"])
            continue
        save()
    save()
    if failed:
        print("failed (run again with --only to retry):", ",".join(failed))


def process(job: dict, cache: str, out_dir: str, n: int, gra, gdec, r25_deg) -> dict:
    s = slug(job["name"])
    print(f"{job['name']}: {job['fov']:.2f} deg", flush=True)
    w = job["width"]
    params = {"hips": "CDS/P/DSS2/color", "width": w, "height": w, "fov": job["fov"], "ra": job["ra"], "dec": job["dec"],
              "projection": "TAN", "format": "png"}
    raw = fetch(f"{HIPS2FITS}?{urllib.parse.urlencode(params)}", os.path.join(cache, f"{s}.png"))
    img = np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"), float)
    stars = gaia_foreground(job["ra"], job["dec"], job["fov"] * 0.72, os.path.join(cache, f"{s}-gaia.csv"))
    others = []
    if job["kind"] == "galaxy":
        # Other catalogue galaxies in the frame big enough to show.
        x, y = tangent(job["ra"], job["dec"], gra, gdec)
        inside = (np.abs(x) < job["fov"] / 2) & (np.abs(y) < job["fov"] / 2) & (np.arange(n) != job["index"])
        inside &= r25_deg * 3600 > 20
        for k in np.nonzero(inside)[0]:
            others.append((gra[k], gdec[k], r25_deg[k] * 3600 * 1.1))
        # Not a galaxy's own core (Gaia lists some nuclei and knots) either.
        core = r25_deg[job["index"]] * 3600 * 0.04
        sep = np.hypot(*tangent(job["ra"], job["dec"], stars[:, 0], stars[:, 1])) * 3600 if len(stars) else np.zeros(0)
        stars = stars[sep > core]
    lin = clean(img, job["fov"], job["ra"], job["dec"], stars, others)
    mean = encode(lin, os.path.join(out_dir, f"{s}.jpg"))
    e = {k: v for k, v in job.items() if k not in ("width", "index")}
    e.update(file=f"{s}.jpg", mean=mean, masked=int(len(stars)))
    return e


if __name__ == "__main__":
    main()
