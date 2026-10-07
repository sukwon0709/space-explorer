"""Close-up layers for the nebula pictures: real survey detail, then AI-enhanced detail.

Usage (after pipeline/fetch_images.py):
    python pipeline/build_nebula_detail.py DATA_DIR public/data [--only NAMES] [--no-ai]

Each nebula's whole-field picture (public/data/images/<slug>.jpg, DSS2 plates) gets two
nested close-up pictures centred on its best-known feature (the Pillars of Creation, the
Horsehead, the Keyhole ...):

  1. Real: 1024 px at 1 arcsec per pixel (or the whole field, if the nebula is smaller).
     The nebula's large-scale light comes from DSS2 (photographic plates keep extended
     light), and everything finer than 3 arcsec from Pan-STARRS DR1 g, r, i (north of
     -30 deg) or DECaPS DR2 g, r, i (the southern Galactic plane). Those CCD surveys
     resolve about 1 arcsec but subtract large-scale nebulosity with the sky, so only
     their fine detail is used, scaled to match DSS2 at the scales both resolve.
  2. AI-enhanced: the central half of layer 1, upscaled 4 times by Real-ESRGAN (x4plus,
     BSD-3, run on the CPU), i.e. detail below what any survey resolves.

Both are tied to the observations by back-projection: each layer, averaged down onto its
parent's pixels, is forced to equal the parent (residuals are spread back up and the
step repeated). So the whole-field picture, the survey and the AI layer agree at every
scale the parent shows; the AI only adds what lies between the parent's pixels. The
residual left over is recorded in index.json (`match`) and checked by
tests/nebulae.test.ts.

Foreground stars are removed as in fetch_images.py (deeper Gaia queries for the smaller
fields), since the app draws them itself.

Writes public/data/images/detail/<slug>-1.jpg and <slug>-2.jpg and adds a `detail` list
to each nebula in public/data/images/index.json. Raw cutouts, Gaia queries and the
Real-ESRGAN weights are cached in DATA_DIR/images/.

The AI step needs torch (CPU build is enough): pip install torch --index-url
https://download.pytorch.org/whl/cpu
"""

import argparse
import io
import json
import os
import shutil
import urllib.parse

import numpy as np
from astropy.io import fits
from PIL import Image
from scipy import ndimage

from fetch_images import HIPS2FITS, NEBULAE, app_stars, fetch, fill_stars, gaia_foreground, hms, separation, slug, tangent

ESRGAN_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"

# Close-up centre for each nebula (J2000), with what is there (Sesame / SIMBAD positions).
FOCUS = {
    "Orion Nebula": ("05 35 17.3", "-05 23 28", "Trapezium and the Orion Bar"),
    "Lagoon Nebula": ("18 03 41.1", "-24 22 37", "Hourglass Nebula"),
    "Trifid Nebula": ("18 02 23", "-23 01 48", "the dark lanes"),
    "Eagle Nebula": ("18 18 49", "-13 50 10", "Pillars of Creation"),
    "Omega Nebula": ("18 20 40", "-16 11 00", "the bright bar"),
    "Carina Nebula": ("10 45 02.2", "-59 41 60", "Keyhole Nebula and Eta Carinae"),
    "Rosette Nebula": ("06 31 50", "+04 58 00", "NGC 2237 and its globules"),
    "North America Nebula": ("20 51 00", "+44 22 00", "Pelican Nebula, IC 5070"),
    "Helix Nebula": ("22 29 38.5", "-20 50 14", "the ring"),
    "Ring Nebula": ("18 53 35.1", "+33 01 45", "the ring"),
    "Dumbbell Nebula": ("19 59 36.3", "+22 43 16", "the lobes"),
    "Crab Nebula": ("05 34 31.9", "+22 00 52", "the filaments"),
    "Veil Nebula": ("20 56 19", "+31 44 36", "NGC 6992, the Eastern Veil"),
    "Pleiades nebulosity": ("03 46 21.3", "+23 56 28", "IC 349 by Merope"),
    "Horsehead Nebula": ("05 40 59.0", "-02 27 30", "the Horsehead, Barnard 33"),
    "Heart Nebula": ("02 32 42", "+61 27 00", "Melotte 15"),
    "Soul Nebula": ("02 51 00", "+60 25 00", "the central cavity"),
    "California Nebula": ("04 03 18", "+36 25 18", "the bright ridge"),
    "Elephant's Trunk Nebula": ("21 36 41.0", "+57 30 08", "the Elephant's Trunk, vdB 142"),
    "Pacman Nebula": ("00 52 59", "+56 37 19", "the pillars"),
    "Bubble Nebula": ("23 20 48", "+61 12 06", "the bubble"),
    "Cone Nebula": ("06 41 10", "+09 27 00", "the Cone"),
    "Seagull Nebula": ("07 04 25", "-10 27 00", "the head"),
    "Thor's Helmet": ("07 18 30", "-13 13 48", "the helmet"),
    "Running Chicken Nebula": ("11 38 20", "-63 22 00", "Thackeray's globules"),
}

PX1 = 1024        # real layer, pixels across
SCALE1 = 1.0      # its pixel size, arcsec (finer for small nebulae: it covers the whole field)
SPLIT = 3.0       # arcsec: finer than this from the CCD survey, coarser from DSS2
SPLIT_SAT = 30.0  # where the plates saturate, the survey supplies structure up to this size
AI = 4            # AI upscaling factor
PX2 = 2048        # AI layer, pixels across (the central PX2 / AI pixels of layer 1)


# CCD surveys, best first: the H-alpha surveys of the Galactic plane keep nebulae clean;
# Pan-STARRS and DECaPS over-subtract bright nebulosity with the sky, leaving deep negative
# holes, so a field is used only if it has few of those (see usable()).
SURVEYS = [
    ("CDS/P/VPHAS/DR4", ["Halpha", "r", "i"], "VPHAS+ DR4"),
    ("CDS/P/IPHAS/DR2", ["halpha", "r", "i"], "IPHAS DR2"),
    ("CDS/P/DECaPS/DR2", ["g", "r", "i"], "DECaPS DR2"),
    ("CDS/P/PanSTARRS/DR1", ["g", "r", "i"], "Pan-STARRS DR1"),
]


def usable(a: np.ndarray) -> tuple[bool, float]:
    """Covers the field and has few pixels far below the sky (over-subtraction or blanks)."""
    nan = float(np.isnan(a).mean())
    if nan > 0.5:
        return False, 1.0
    junk = float(holes(a).mean()) + nan
    return junk < 0.1, junk


def holes(a: np.ndarray) -> np.ndarray:
    """Pixels far below the sky: over-subtracted nebulosity (deep negative holes) or blanks."""
    v = np.nan_to_num(a, nan=float(np.nanmedian(a)))
    hp = v - ndimage.median_filter(v, 5)
    noise = 1.4826 * np.median(np.abs(hp - np.median(hp)))
    return np.isnan(a) | (v < -5 * noise)


def cutout(hips: str, ra: float, dec: float, fov: float, px: int, fmt: str, path: str) -> bytes:
    params = {"hips": hips, "width": px, "height": px, "fov": fov, "ra": ra, "dec": dec, "projection": "TAN", "format": fmt}
    return fetch(f"{HIPS2FITS}?{urllib.parse.urlencode(params)}", path)


def untangent(ra0: float, dec0: float, x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Inverse gnomonic projection (degrees in, degrees out)."""
    ra0, dec0 = np.radians(ra0), np.radians(dec0)
    x, y = np.radians(x), np.radians(y)
    rho = np.hypot(x, y)
    c = np.arctan(rho)
    sinc, cosc = np.sin(c), np.cos(c)
    with np.errstate(invalid="ignore", divide="ignore"):
        dec = np.arcsin(cosc * np.sin(dec0) + np.where(rho > 0, y * sinc * np.cos(dec0) / rho, 0))
    ra = ra0 + np.arctan2(x * sinc, rho * np.cos(dec0) * cosc - y * np.sin(dec0) * sinc)
    return np.degrees(ra) % 360, np.degrees(dec)


def pixel_map(child: dict, parent: dict) -> tuple[np.ndarray, np.ndarray]:
    """Where each child pixel's centre falls in the parent's pixel grid (continuous column, row)."""
    n, p = child["px"], child["fov"] / child["px"]
    i, j = np.mgrid[0:n, 0:n]
    x = (n / 2 - (j + 0.5)) * p  # east, degrees
    y = (n / 2 - (i + 0.5)) * p  # north
    ra, dec = untangent(child["ra"], child["dec"], x, y)
    px, py = tangent(parent["ra"], parent["dec"], ra, dec)
    m, q = parent["px"], parent["fov"] / parent["px"]
    return m / 2 - px / q, m / 2 - py / q


class SkipNebula(Exception):
    """No close-up worth showing for this nebula."""


class Projector:
    """Averages a child image onto its parent's pixels, and spreads parent residuals back."""

    def __init__(self, child: dict, parent: dict):
        u, v = pixel_map(child, parent)
        self.u, self.v = u, v
        self.m = parent["px"]
        # Parent pixel centres in child pixel coordinates (the mapping is affine to well
        # under a pixel over these small fields).
        n = child["px"]
        jj, ii = np.meshgrid(np.arange(n) + 0.5, np.arange(n) + 0.5)
        A = np.stack([np.ones(n * n), u.ravel(), v.ravel()], 1)
        cj = np.linalg.lstsq(A, jj.ravel(), rcond=None)[0]
        ci = np.linalg.lstsq(A, ii.ravel(), rcond=None)[0]
        pr, pc = np.mgrid[0:self.m, 0:self.m] + 0.5
        self.cx = (cj[0] + cj[1] * pc + cj[2] * pr).ravel() - 0.5
        self.cy = (ci[0] + ci[1] * pc + ci[2] * pr).ravel() - 0.5
        self.ratio = (parent["fov"] / parent["px"]) / (child["fov"] / child["px"])
        self.valid = (self.cx >= 0) & (self.cy >= 0) & (self.cx <= n - 1) & (self.cy <= n - 1)
        # Parent pixels lying wholly on the child.
        h = self.ratio / 2
        self.inside = ((self.cx >= h - 0.5) & (self.cy >= h - 0.5) & (self.cx <= n - h - 0.5) & (self.cy <= n - h - 0.5)).reshape(self.m, self.m)
        # The parent pixels the child must reproduce (callers may drop unreliable ones).
        self.covered = self.inside.copy()

    def down(self, a: np.ndarray) -> np.ndarray:
        """The child averaged over each parent pixel: a box-like blur the size of a parent
        pixel, sampled at the parent pixels' centres (binning would beat against a
        non-integer pixel ratio)."""
        out = np.zeros((self.m, self.m, 3))
        for c in range(3):
            if self.ratio > 1.5:
                b = ndimage.uniform_filter(ndimage.gaussian_filter(a[..., c], self.ratio / 4), int(round(self.ratio)) | 1)
            else:
                b = a[..., c]
            vals = ndimage.map_coordinates(b, [self.cy, self.cx], order=1, mode="nearest")
            out[..., c] = np.where(self.valid, vals, 0).reshape(self.m, self.m)
        return out

    def up(self, r: np.ndarray) -> np.ndarray:
        # Residuals past the child's edge are extended from the nearest pixel inside it.
        idx = ndimage.distance_transform_edt(~self.inside, return_distances=False, return_indices=True)
        r = r[idx[0], idx[1]]
        out = np.stack([ndimage.map_coordinates(r[..., c], [self.v - 0.5, self.u - 0.5], order=1, mode="nearest")
                        for c in range(3)], -1)
        # Bilinear spreading leaves a grid of parent-pixel pyramids that down() cannot see
        # (its box averages them out), so they would never be corrected: smooth them away.
        if self.ratio > 1.5:
            out = ndimage.gaussian_filter(out, (self.ratio / 3, self.ratio / 3, 0))
        return out

    def match(self, child: np.ndarray, parent: np.ndarray, steps: int = 24) -> tuple[np.ndarray, float]:
        """Back-projection: the child, made to average to the parent on every covered pixel."""
        for _ in range(steps):
            r = np.where(self.covered[..., None], parent - self.down(child), 0)
            child = np.clip(child + self.up(r), 0, None)
        r = np.abs(parent - self.down(child))[self.covered]
        return child, float(r.mean() / max(parent[self.covered].mean(), 1e-12))


def read_jpg(path: str) -> np.ndarray:
    """A stored picture in its linear units (the app squares the stored value)."""
    return (np.asarray(Image.open(path).convert("RGB"), float) / 255) ** 2


def encode(lin: np.ndarray, path: str) -> float:
    """Store sqrt-encoded relative to a peak, returned in the parent picture's units."""
    # A few bright stars would otherwise take most of the 8 bits: they clip instead.
    peak = float(np.percentile(lin.max(axis=2), 99.9)) or 1.0
    Image.fromarray(np.round(np.sqrt(np.clip(lin / peak, 0, 1)) * 255).astype(np.uint8)).save(path, quality=90)
    return peak


def inpaint(a: np.ndarray, known: np.ndarray) -> np.ndarray:
    """Fill the unknown pixels from the surrounding known ones, at growing scales."""
    out, known = a.copy(), known.copy()
    for sigma in (2, 6, 18, 54, 162):
        w = ndimage.gaussian_filter(known.astype(float), sigma)
        todo = ~known & (w > 0.02)
        v = ndimage.gaussian_filter(out * known, sigma) / np.maximum(w, 1e-6)
        out[todo] = v[todo]
        known = known | todo
        if known.all():
            break
    return out


def fill_holes(lin: np.ndarray, grow: int = 4, max_area: int | None = None) -> np.ndarray:
    """Fill the black pits that saturated star cores leave (a survey's dropped pixels, or
    the plates' burnt-out cores), with their bright rims, from the nebula around them.
    max_area keeps real dark globules: only pits up to that many pixels are filled."""
    lum = lin.mean(axis=2)
    ref = ndimage.zoom(ndimage.median_filter(lum[::2, ::2], 15), 2, order=1)[:lum.shape[0], :lum.shape[1]]
    pits = (lum < 0.25 * ref) & (ref > np.percentile(ref, 30))
    if max_area is not None:
        lab, n = ndimage.label(pits)
        area = ndimage.sum(pits, lab, np.arange(1, n + 1))
        pits = np.isin(lab, 1 + np.flatnonzero(area <= max_area))
    if not pits.any():
        return lin
    # With the star's bright halo around the pit, which the whole-field picture does not
    # have either (its stars are removed).
    halo = (lum > 1.5 * ref) & ndimage.binary_dilation(pits, iterations=4 * grow)
    known = ~ndimage.binary_dilation(pits | halo, iterations=grow)
    return np.stack([inpaint(lin[..., c], known) for c in range(3)], -1)


def hybrid(dss8: np.ndarray, bands: list[np.ndarray], scale: float) -> tuple[np.ndarray, list[float]]:
    """DSS2 for the large scales, the CCD survey's own detail for the fine ones (linear, DSS2 units).

    The survey's three bands are merged into one detail image (each band normalised to its
    own noise, bad pixels left out), and added to each DSS2 colour with a gain fitted where
    both resolve. Where the plates saturate (bright cores), the survey also supplies the
    structure between SPLIT and SPLIT_SAT, which the plates lost.
    """
    dss = (dss8 / 255) ** 2.2
    ccd = np.stack(bands, -1)
    bad = np.stack([holes(b) for b in bands], -1)
    for c in range(3):
        # Saturated or filled pixels sit at the band's ceiling.
        top = np.nanmax(ccd[..., c])
        bad[..., c] |= ccd[..., c] >= top - 0.02 * (top - np.nanmedian(ccd[..., c]))
        bad[..., c] = ndimage.binary_dilation(bad[..., c], iterations=3)
    s, big = SPLIT / scale, SPLIT_SAT / scale

    def fine(a, w, sigma):
        return a - ndimage.gaussian_filter(a * w, sigma) / np.maximum(ndimage.gaussian_filter(w, sigma), 1e-6)

    # One detail image: each band's detail over its noise, averaged over the good bands.
    num = np.zeros(ccd.shape[:2])
    den = np.zeros(ccd.shape[:2])
    for c in range(3):
        w = (~bad[..., c]).astype(float)
        d = np.where(bad[..., c], 0, np.nan_to_num(ccd[..., c]))
        hp = fine(d, w, big) * w
        noise = 1.4826 * np.median(np.abs(hp[w > 0] - np.median(hp[w > 0])))
        num += hp / max(noise, 1e-30)
        den += w
    good = den > 0
    # Gaps where no band is usable (saturated or blank) are filled from their surroundings.
    lum = inpaint(np.where(good, num / np.maximum(den, 1), 0), good)
    lum3 = fine(lum, np.ones_like(lum), s)          # finer than SPLIT
    band = lum - lum3                                # SPLIT .. SPLIT_SAT
    sat = ndimage.gaussian_filter((dss8 >= 245).any(-1).astype(float), 3 * s)
    gains, corr = [], []
    fit = good & (sat < 0.05)
    for c in range(3):
        # Scale the survey to DSS2 where both resolve (SPLIT to 3 SPLIT) and the plate is unsaturated.
        x = (ndimage.gaussian_filter(lum, s) - ndimage.gaussian_filter(lum, 3 * s))[fit]
        y = (ndimage.gaussian_filter(dss[..., c], s) - ndimage.gaussian_filter(dss[..., c], 3 * s))[fit]
        g = float(np.sum(x * y) / max(np.sum(x * x), 1e-30)) if x.size > 1000 else 0.0
        r = float(np.corrcoef(x, y)[0, 1]) if x.size > 1000 else 0.0
        if not np.isfinite(g) or g <= 0 or r < 0.3:
            g = 0.0  # the survey does not match DSS2 here: keep DSS2 alone
        gains.append(g)
        corr.append(round(r, 3))
    gains = np.array(gains)
    low3 = np.stack([ndimage.gaussian_filter(dss[..., c], s) for c in range(3)], -1)
    low_big = np.stack([ndimage.gaussian_filter(dss[..., c], big) for c in range(3)], -1)
    # In saturated parts the survey's mid-scale structure modulates the plate's (flat) light,
    # keeping the plate's colour.
    tot = np.maximum(low_big.sum(-1), 1e-6)
    factor = np.clip(1 + band * gains.sum() / tot, 0, None)[..., None]
    out = low3 * (1 - sat[..., None]) + low_big * factor * sat[..., None] + lum3[..., None] * gains
    return np.clip(out, 0, None), corr


class Upscaler:
    """Real-ESRGAN x4plus (RRDBNet, 23 blocks), CPU, in overlapping tiles."""

    def __init__(self, weights: str):
        import torch
        import torch.nn as nn
        import torch.nn.functional as F

        class RDB(nn.Module):
            def __init__(self, nf=64, gc=32):
                super().__init__()
                self.conv1 = nn.Conv2d(nf, gc, 3, 1, 1)
                self.conv2 = nn.Conv2d(nf + gc, gc, 3, 1, 1)
                self.conv3 = nn.Conv2d(nf + 2 * gc, gc, 3, 1, 1)
                self.conv4 = nn.Conv2d(nf + 3 * gc, gc, 3, 1, 1)
                self.conv5 = nn.Conv2d(nf + 4 * gc, nf, 3, 1, 1)
                self.lrelu = nn.LeakyReLU(0.2, True)

            def forward(self, x):
                x1 = self.lrelu(self.conv1(x))
                x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
                x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
                x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
                return self.conv5(torch.cat((x, x1, x2, x3, x4), 1)) * 0.2 + x

        class RRDB(nn.Module):
            def __init__(self):
                super().__init__()
                self.rdb1, self.rdb2, self.rdb3 = RDB(), RDB(), RDB()

            def forward(self, x):
                return self.rdb3(self.rdb2(self.rdb1(x))) * 0.2 + x

        class RRDBNet(nn.Module):
            def __init__(self):
                super().__init__()
                self.conv_first = nn.Conv2d(3, 64, 3, 1, 1)
                self.body = nn.Sequential(*[RRDB() for _ in range(23)])
                self.conv_body = nn.Conv2d(64, 64, 3, 1, 1)
                self.conv_up1 = nn.Conv2d(64, 64, 3, 1, 1)
                self.conv_up2 = nn.Conv2d(64, 64, 3, 1, 1)
                self.conv_hr = nn.Conv2d(64, 64, 3, 1, 1)
                self.conv_last = nn.Conv2d(64, 3, 3, 1, 1)
                self.lrelu = nn.LeakyReLU(0.2, True)

            def forward(self, x):
                f = self.conv_first(x)
                f = f + self.conv_body(self.body(f))
                f = self.lrelu(self.conv_up1(F.interpolate(f, scale_factor=2, mode="nearest")))
                f = self.lrelu(self.conv_up2(F.interpolate(f, scale_factor=2, mode="nearest")))
                return self.conv_last(self.lrelu(self.conv_hr(f)))

        self.torch = torch
        self.net = RRDBNet()
        state = torch.load(weights, map_location="cpu")
        self.net.load_state_dict(state.get("params_ema", state))
        self.net.eval()
        torch.set_num_threads(os.cpu_count() or 4)

    def __call__(self, img: np.ndarray, tile: int = 128, pad: int = 12) -> np.ndarray:
        """img: H x W x 3 in 0..1 (display-encoded). Returns 4H x 4W x 3."""
        h, w, _ = img.shape
        out = np.zeros((h * AI, w * AI, 3), np.float32)
        src = np.pad(img, ((pad, pad), (pad, pad), (0, 0)), mode="reflect").astype(np.float32)
        with self.torch.no_grad():
            for y in range(0, h, tile):
                for x in range(0, w, tile):
                    th, tw = min(tile, h - y), min(tile, w - x)
                    t = src[y:y + th + 2 * pad, x:x + tw + 2 * pad]
                    r = self.net(self.torch.from_numpy(t.transpose(2, 0, 1)[None].copy()))[0].clamp(0, 1).numpy()
                    out[y * AI:(y + th) * AI, x * AI:(x + tw) * AI] = r.transpose(1, 2, 0)[pad * AI:(pad + th) * AI, pad * AI:(pad + tw) * AI]
        return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("data")
    parser.add_argument("out")
    parser.add_argument("--only", help="comma-separated names")
    parser.add_argument("--no-ai", action="store_true", help="real survey layer only")
    args = parser.parse_args()
    cache = os.path.join(args.data, "images")
    os.makedirs(cache, exist_ok=True)
    img_dir = os.path.join(args.out, "images")
    out_dir = os.path.join(img_dir, "detail")
    os.makedirs(out_dir, exist_ok=True)
    index_path = os.path.join(img_dir, "index.json")
    index = json.load(open(index_path))
    entries = {e["name"]: e for e in index["images"]}
    only = set(args.only.split(",")) if args.only else None
    upscale = None
    if not args.no_ai:
        weights = os.path.join(cache, "RealESRGAN_x4plus.pth")
        fetch(ESRGAN_URL, weights)
        upscale = Upscaler(weights)
    bright = app_stars(args.out)
    for name, *_ in NEBULAE:
        e = entries.get(name)
        if not e or "file" not in e or name not in FOCUS or (only and name not in only):
            continue
        try:
            e["detail"] = build(e, cache, img_dir, out_dir, bright, upscale)
        except OSError as err:
            print(f"  failed: {err} (run again with --only to retry)", flush=True)
            continue
        except SkipNebula as why:
            print(f"  no close-up: {why}", flush=True)
            e.pop("detail", None)
            e.pop("repaired", None)
            s = slug(name)
            original = os.path.join(cache, f"{s}-base.jpg")
            if os.path.exists(original):
                shutil.copy(original, os.path.join(img_dir, e["file"]))
                e["mean"] = [round(float(v), 6) for v in read_jpg(original).reshape(-1, 3).mean(axis=0)]
            for k in (1, 2):
                if os.path.exists(os.path.join(out_dir, f"{s}-{k}.jpg")):
                    os.remove(os.path.join(out_dir, f"{s}-{k}.jpg"))
        with open(index_path, "w") as f:
            json.dump(index, f, indent=1)


def build(e: dict, cache: str, img_dir: str, out_dir: str, bright: np.ndarray, upscale) -> list[dict]:
    s = slug(e["name"])
    fra, fdec, what = FOCUS[e["name"]]
    ra1, dec1 = hms(fra, fdec)
    base_px = Image.open(os.path.join(img_dir, e["file"])).size[0]
    base = {"ra": e["ra"], "dec": e["dec"], "fov": e["fov"], "px": base_px}
    fov1 = min(e["fov"], PX1 * SCALE1 / 3600)
    # Keep the close-up inside the whole-field picture's bright part.
    x, y = tangent(e["ra"], e["dec"], ra1, dec1)
    lim = max(0.0, 0.5 * e["fov"] - fov1 / 2)
    if np.hypot(x, y) > lim:
        k = lim / np.hypot(x, y)
        ra1, dec1 = untangent(e["ra"], e["dec"], np.array(x * k), np.array(y * k))
        ra1, dec1 = float(ra1), float(dec1)
    scale1 = fov1 / PX1 * 3600
    l1 = {"ra": ra1, "dec": dec1, "fov": fov1, "px": PX1}
    raw = cutout("CDS/P/DSS2/color", ra1, dec1, fov1, PX1, "png", os.path.join(cache, f"{s}-1-dss.png"))
    dss = np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"), float)
    bands, sname = [], "DSS2 alone"
    for hips, names, label in SURVEYS:
        tag = hips.split("/")[2].lower()
        ok, junk = True, 0.0
        for b in names:  # every band must cover the field cleanly
            probe = cutout(f"{hips}/{b}", ra1, dec1, fov1, 256, "fits", os.path.join(cache, f"{s}-1-{tag}-{b}-probe.fits"))
            good, j = usable(fits.getdata(io.BytesIO(probe)).astype(float))
            ok, junk = ok and good, max(junk, j)
            if not ok:
                break
        print(f"  {label}: {'used' if ok else 'not usable'} (junk {junk:.3f})", flush=True)
        if ok:
            for b in names:
                blob = cutout(f"{hips}/{b}", ra1, dec1, fov1, PX1, "fits", os.path.join(cache, f"{s}-1-{tag}-{b}.fits"))
                bands.append(fits.getdata(io.BytesIO(blob)).astype(float)[::-1])  # FITS rows run south to north
            sname = label
            break
    print(f"{e['name']}: {what}, {fov1 * 60:.1f}' at {scale1:.2f}\"/px from DSS2 + {sname}", flush=True)
    lin, corr = hybrid(dss, bands, scale1) if bands else ((dss / 255) ** 2.2, [0.0, 0.0, 0.0])
    # Dense Milky Way fields time out the Gaia archive at faint limits: go less deep there.
    for glim in (16.5, 14.5, 12.5):
        try:
            stars = gaia_foreground(ra1, dec1, fov1 * 0.72, os.path.join(cache, f"{s}-1-gaia-{glim:g}.csv"), glim)
            break
        except OSError as err:
            print(f"  Gaia to G {glim} failed ({err}), trying shallower", flush=True)
    else:
        raise OSError("Gaia archive unavailable")
    near = separation(ra1, dec1, bright[:, 0], bright[:, 1]) < fov1 * 0.72
    stars = np.concatenate([stars, bright[near]]) if near.any() else stars
    # The CCD survey shows stars smaller than the plates do: smaller holes.
    lin = fill_stars(lin, fov1, ra1, dec1, stars, [], star_scale=0.4)
    lin = fill_holes(lin)
    # Into the whole-field picture's units: a linear fit where the plates are unsaturated.
    # The whole-field picture as fetch_images.py made it (kept, since it is repaired below).
    original = os.path.join(cache, f"{s}-base.jpg")
    if not os.path.exists(original):
        shutil.copy(os.path.join(img_dir, e["file"]), original)
    parent = read_jpg(original)
    proj = Projector(l1, base)
    sat = ndimage.binary_dilation((parent >= (250 / 255) ** 2).any(-1), iterations=1)
    fit = proj.covered & ~sat
    if fit.sum() < 50:
        raise SkipNebula("the plates are saturated over the whole close-up")
    lo = proj.down(lin)[fit]
    hi = parent[fit]
    for c in range(3):
        a, b = np.polyfit(lo[:, c], hi[:, c], 1)
        lin[..., c] = np.clip(a * lin[..., c] + b, 0, None)
    if not bands and (dss >= 245).any(-1).mean() > 0.25:
        raise SkipNebula("the plates are saturated over the close-up and no CCD survey covers it")
    # Where the plates saturated, the whole-field picture is repaired from the close-up (the
    # survey's light averaged onto its pixels), blending in over a few pixels at the edge.
    inner = ndimage.gaussian_filter(ndimage.binary_erosion(proj.inside, iterations=3).astype(float), 1.5)
    w = (ndimage.gaussian_filter(sat.astype(float), 1.0) * inner)[..., None]
    parent = parent * (1 - w) + proj.down(lin) * w
    # The plates' burnt-out star cores (a pixel or two) would otherwise be copied into the
    # close-ups by the back-projection.
    parent = fill_holes(parent, grow=1, max_area=6)
    # Rescale so the repaired picture fits its 8 bits again, and store it.
    k = max(1.0, float(np.percentile(parent.max(axis=2), 99.995)))
    parent, lin = parent / k, lin / k
    Image.fromarray(np.round(np.sqrt(np.clip(parent, 0, 1)) * 255).astype(np.uint8)).save(os.path.join(img_dir, e["file"]), quality=90)
    e["mean"] = [round(float(v), 6) for v in read_jpg(os.path.join(img_dir, e["file"])).reshape(-1, 3).mean(axis=0)]
    e["repaired"] = round(float(w.mean()), 4)
    # Back-projection: the close-up made to average to the stored (repaired) picture,
    # which is what the app shows, everywhere.
    parent = read_jpg(os.path.join(img_dir, e["file"]))
    lin, match1 = proj.match(lin, parent)
    gain1 = encode(lin, os.path.join(out_dir, f"{s}-1.jpg"))
    layers = [{
        "file": f"detail/{s}-1.jpg", "ra": round(ra1, 6), "dec": round(dec1, 6), "fov": round(fov1, 6), "px": PX1,
        "gain": round(gain1, 6), "kind": "survey", "what": what,
        "source": f"DSS2 above {SPLIT:.0f}\", {sname} below" if max(corr) > 0 else "DSS2",
        "survey": sname if max(corr) > 0 else None,
        "arcsec": round(scale1, 3), "match": round(match1, 5), "corr": corr,
    }]
    if upscale is None:
        return layers
    # AI: the central PX2 / AI pixels of the real layer, 4 times finer.
    n = PX2 // AI
    o = (PX1 - n) // 2
    crop = lin[o:o + n, o:o + n]
    peak = float(np.percentile(crop.max(axis=2), 99.995)) or 1.0
    up = upscale(np.sqrt(np.clip(crop / peak, 0, 1))).astype(float) ** 2 * peak
    l2 = {"ra": ra1, "dec": dec1, "fov": fov1 * n / PX1, "px": PX2}
    # Exactly AI x AI child pixels per parent pixel: the crop is the parent here.
    crop_grid = {"ra": ra1, "dec": dec1, "fov": fov1 * n / PX1, "px": n}
    up, match2 = Projector(l2, crop_grid).match(up, crop)
    gain2 = encode(up, os.path.join(out_dir, f"{s}-2.jpg"))
    layers.append({
        "file": f"detail/{s}-2.jpg", "ra": round(ra1, 6), "dec": round(dec1, 6), "fov": round(l2["fov"], 6), "px": PX2,
        "gain": round(gain2, 6), "kind": "ai", "what": what,
        "source": f"Real-ESRGAN x4plus from the {layers[0]['source']} layer, back-projected",
        "arcsec": round(scale1 / AI, 3), "match": round(match2, 5),
    })
    print(f"  match: survey {match1:.4f}, AI {match2:.4f}; survey/DSS2 correlation {corr}", flush=True)
    return layers


if __name__ == "__main__":
    main()
