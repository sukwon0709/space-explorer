"""3D models of the nearest and largest galaxies, built from survey images.

Usage:
    python pipeline/build_galaxy_models.py DATA_DIR public/data [--only "Name,Name"]

Each galaxy is cut out of the sharpest colour survey that covers it, cleaned of
foreground stars (pipeline/fetch_images.py), and split into the parts of a galaxy the
app then draws as a volume it can fly around and through:

  Bulge  A Sersic profile fitted to the light along the major axis (an exponential disc
         plus a Sersic bulge, plate-saturated cores left out of the fit), as an oblate
         spheroid of intrinsic axis ratio 0.6. Its colour is the image's at the centre.
         Elliptical and lenticular galaxies are all bulge.
  Disc   The rest of the light, deprojected onto the galaxy's own plane: the inclination
         follows from the axis ratio (intrinsic thickness 0.2), and the face-on light is
         corrected for the galaxy's own dust. The stars are spread over a sech^2 layer of
         scale height z0 = 0.2 scale lengths (Kregel et al. 2002, Xilouris et al. 1999).
         Nearly edge-on galaxies, whose face can't be seen from Earth, get a smooth
         exponential disc with the fitted scale length and the image's colour.
  Dust   A thinner layer (z0 / 2) with a smooth exponential part (face-on central
         optical depth 0.7 in V, scale length 1.4 disc scale lengths, as fitted to
         edge-on spirals by Xilouris et al. 1999) plus the lanes seen in the image:
         where the light is redder than the bulge-plus-smoothed-disc model, the colour
         excess gives the optical depth (R_V = 3.1). The side of the disc whose lanes
         redden the bulge more is the near side.

Sources, best first: SDSS DR9 g, r, i (linear fluxes) where it covers the galaxy, else
the Digitized Sky Survey 2 colour plates (as fetch_images.py). Writes
public/data/galaxies/models/<slug>.jpg (face-on light, square-root encoded),
<slug>-dust.jpg (face-on lane optical depth), and models.json with every parameter;
tests/fixtures/galaxy-models-reference.json keeps a low-resolution copy of a few
galaxies' sky images and model maps for the gate test (tests/galaxymodels.test.ts).
"""

import argparse
import io
import json
import math
import os
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image
from scipy import ndimage, special

from fetch_images import (HIPS2FITS, app_stars, blur, clean_linear, fetch, gaia_foreground,
                          separation, slug, tangent)

# The galaxies modelled, by their names in galaxies/index.json, with the width (px) of
# their old flat pictures (fetch_images.py once drew them).
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
    "M83": 768, "M64": 512, "M63": 512, "M101": 768, "M81": 768, "M82": 512,
}

# Image width (px): the showcase galaxies at the highest resolution.
WIDTH = {"Andromeda Galaxy": 4096, "Large Magellanic Cloud": 3072, "Small Magellanic Cloud": 2048, "Triangulum Galaxy": 3072}
SHOWCASE = {"Whirlpool Galaxy", "Pinwheel Galaxy", "Bode's Galaxy", "Sombrero Galaxy", "Southern Pinwheel Galaxy",
            "Centaurus A", "Sculptor Galaxy", "Cigar Galaxy", "Black Eye Galaxy", "Sunflower Galaxy", "M106", "NGC 300",
            "NGC 55", "NGC 2403", "IC 342", "NGC 6946", "NGC 4945", "M74", "Needle Galaxy", "NGC 891", "NGC 1365",
            "NGC 1300", "Barnard's Galaxy", "Whale Galaxy", "NGC 7331", "M83", "M101", "M81", "M64", "M63"}
# Interacting companions in their partner's picture: each is fitted there as a spheroid,
# subtracted (its tidal light stays with the partner) and drawn as its own model at the
# partner's distance.
COMPANIONS = {"Whirlpool Galaxy": ["NGC 5195"]}
# Bulges the image can't measure on its own (a saturated core, or a bulge that dominates
# the light): effective radius (kpc, at the catalogue distance) and Sersic index from
# deeper photometry. M31: Courteau et al. 2011;
# M104 and NGC 4565: Kormendy and Ho 2013, Kormendy and Barentine 2010.
PRIORS = {"Andromeda Galaxy": (1.0, 2.2), "Sombrero Galaxy": (2.3, 4.0), "Needle Galaxy": (1.0, 1.5)}
# Where the catalogue's axis ratio is the bulge's outline, not the disc's: the disc's own
# (M104 is 84 degrees from face-on, its dust lane shows). "ring": its dust lies in a ring
# (Bendo et al. 2006), whose radius and depth are fitted to the image.
GEOMETRY = {"Sombrero Galaxy": {"q": 0.224, "ring": True}}
# Late-type and irregular galaxies (Sc and later, de Vaucouleurs RC3): no bulge to speak
# of, only a nucleus.
BULGELESS = {"Triangulum Galaxy", "Southern Pinwheel Galaxy", "Large Magellanic Cloud", "Small Magellanic Cloud", "NGC 300", "NGC 55", "NGC 2403",
             "NGC 7793", "NGC 247", "Barnard's Galaxy", "NGC 4449", "IC 342", "NGC 6946", "M74", "Pinwheel Galaxy", "Whale Galaxy",
             "M108", "M99", "M61", "NGC 2997", "Antennae Galaxies", "Cigar Galaxy", "NGC 4945", "Sculptor Galaxy"}
# Where the catalogue's position is not the galaxy's nucleus (J2000, NED).
CENTRES = {"Whirlpool Galaxy": (202.469575, 47.195258)}
# Irregular galaxies are thick: their stars' scale height relative to the scale length.
THICK = {"Large Magellanic Cloud": 0.3, "Small Magellanic Cloud": 0.6, "Barnard's Galaxy": 0.4, "NGC 4449": 0.4,
         "Cigar Galaxy": 0.35, "NGC 55": 0.3}
BULGE_Q0 = 0.6           # intrinsic axis ratio of a bulge
DISC_Z0 = 0.2            # sech^2 scale height of the stars / disc scale length
DUST_Z0 = 0.5            # dust scale height / stars' scale height
DUST_TAU0 = 0.7          # smooth dust: face-on central V optical depth
DUST_SCALE = 1.4         # smooth dust: scale length / stars' scale length
EDGE_ON = 0.25           # cos(i) below which the face is not seen
SDSS_BANDS = ("i", "r", "g")
# Colour excess per unit V optical depth, in ln(R / B) of each survey's red and blue
# channels: SDSS i and g (A_g - A_i = 0.58 A_V), the DSS2 IIIaF and IIIaJ plates (0.45).
REDDENING = {"SDSS": 0.58 * 1.086 * 0.921, "DSS2": 0.45 * 1.086 * 0.921}
# The colour excess of light mixed with dust is diluted (half the light is in front).
MIXING = 2.0
# Galaxies whose plates get Pan-STARRS DR1's finer detail and unsaturated core.
PS1_DETAIL = {"Andromeda Galaxy"}
# Scale (pixels, Gaussian sigma) above which the plates' light is kept.
PS1_SCALE = 12.0
# The plates' pixel noise for those galaxies (PS1's resolved stars are not noise).
PLATE_NOISE: dict[str, float] = {}
# Their plates as they were (the bulge and disc are fitted to these: PS1's sky subtraction
# leaves its core's light out of step with the disc around it).
PLATE_ONLY: dict[str, tuple[np.ndarray, np.ndarray]] = {}
FIXTURE = ["Whirlpool Galaxy", "Andromeda Galaxy", "Sombrero Galaxy", "Needle Galaxy", "Triangulum Galaxy", "M87 (Virgo A)"]


def sersic_b(n: float) -> float:
    return 2 * n - 1 / 3 + 4 / (405 * n) + 46 / (25515 * n * n)


def survey_image(job: dict, cache: str) -> tuple[np.ndarray, str, np.ndarray]:
    """Linear RGB cutout (north up, east left), its survey, and a mask of saturated pixels."""
    s, w = f'{slug(job["name"])}-{job["ra"]:.4f}{job["dec"]:+.4f}', job["width"]
    base = {"width": w, "height": w, "fov": job["fov"], "ra": job["ra"], "dec": job["dec"], "projection": "TAN"}
    if job["dec"] > -12 and job["fov"] < 1.2:
        from astropy.io import fits

        bands = []
        for b in SDSS_BANDS:
            url = f"{HIPS2FITS}?{urllib.parse.urlencode({**base, 'hips': f'CDS/P/SDSS9/{b}', 'format': 'fits'})}"
            raw = fetch(url, os.path.join(cache, f"{s}-{w}-sdss-{b}.fits"))
            bands.append(np.flipud(fits.getdata(io.BytesIO(raw)).astype(float)))
        cube = np.stack(bands, axis=-1)
        yy, xx = np.mgrid[0:w, 0:w]
        inside = np.hypot(xx - w / 2, yy - w / 2) < w / 2
        blank = ~np.isfinite(cube).all(axis=2) | (cube == 0).all(axis=2)
        if blank[inside].mean() < 0.002:
            cube = np.nan_to_num(cube)
            # Balance the bands so that sunlight is white (solar g - r = 0.46, r - i = 0.14).
            cube[..., 0] *= 10 ** (-0.4 * 0.14)
            cube[..., 2] *= 10 ** (0.4 * 0.46)
            return cube, "SDSS", np.zeros((w, w), bool)
    # The plates' own scans (photographic density), not the colour survey, whose stretch
    # clips the bright parts of a large galaxy. Density to light: E = 10^((D - sky) / S) - 1,
    # the plate's straight-line response, with S fitted where the colour survey is not
    # clipped (so the colours keep its calibration).
    from astropy.io import fits

    url = f"{HIPS2FITS}?{urllib.parse.urlencode({**base, 'hips': 'CDS/P/DSS2/color', 'format': 'png'})}"
    png = np.asarray(Image.open(io.BytesIO(fetch(url, os.path.join(cache, f"{s}-{w}-dss.png")))).convert("RGB"), float)
    out = np.zeros((w, w, 3))
    saturated = np.zeros((w, w), bool)
    for c, band in ((0, "red"), (2, "blue")):
        url = f"{HIPS2FITS}?{urllib.parse.urlencode({**base, 'hips': f'CDS/P/DSS2/{band}', 'format': 'fits'})}"
        D = np.flipud(np.nan_to_num(fits.getdata(io.BytesIO(fetch(url, os.path.join(cache, f"{s}-{w}-dss-{band}.fits")))).astype(float)))
        edge = np.concatenate([D[: w // 10].ravel(), D[-w // 10:].ravel(), D[:, : w // 10].ravel(), D[:, -w // 10:].ravel()])
        sky = np.median(edge)
        ref = (png[..., c] / 255.0) ** 2.2
        use = (png[..., c] > 30) & (png[..., c] < 235) & (D > sky)
        sub = np.nonzero(use.ravel())[0][:: max(1, use.sum() // 200000)]
        dd, rr = D.ravel()[sub] - sky, ref.ravel()[sub]
        best = (np.inf, 1.0, 1e4)
        for S in np.geomspace(2000, 60000, 80):
            e = 10 ** (dd / S) - 1
            a = np.median(rr / e)
            err = np.mean(np.log((a * e + 1e-4) / (rr + 1e-4)) ** 2)
            if err < best[0]:
                best = (err, a, S)
        _, a, S = best
        out[..., c] = a * (10 ** (np.clip(D - sky, -5 * S, None) / S) - 1)
        # The plate's response flattens well before it is black: the top quarter of its
        # density range (set by the brightest stars) is not to be trusted.
        saturated |= D > sky + 0.75 * (D.max() - sky)
        print(f"  DSS2 {band}: S = {S:.0f} per decade", flush=True)
    if job["name"] in PS1_DETAIL:
        PLATE_ONLY[job["name"]] = (out.copy(), saturated.copy())
        out, saturated = ps1_detail(out, saturated, base, s, w, cache, job["name"])
    out[..., 1] = 0.5 * (out[..., 0] + out[..., 2])
    return out, "DSS2", saturated


def ps1_detail(out: np.ndarray, saturated: np.ndarray, base: dict, s: str, w: int, cache: str,
               job_name: str) -> tuple[np.ndarray, np.ndarray]:
    """Pan-STARRS DR1's sharper, unsaturated detail on the plates' large-scale light.

    The PS1 stacks are sharper (seeing about 1.2" against the plates' 3") and do not
    saturate in a bright core, but their sky subtraction took out a large galaxy's broad
    glow. So the plates keep the scales above PSF1_SCALE and PS1 gives everything finer,
    scaled to the plates' units where both see the same structure; where the plates
    saturate, PS1 gives the whole core, raised to meet the plates around it."""
    from astropy.io import fits

    yy, xx = np.mgrid[0:w, 0:w]
    rr = np.hypot(xx - w / 2, yy - w / 2)
    # PS1's g stacks are corrupt in a bright core, so its r gives the detail for both of
    # the plates' bands, by ratio (the colours stay the plates').
    url = f"{HIPS2FITS}?{urllib.parse.urlencode({**base, 'hips': 'CDS/P/PanSTARRS/DR1/r', 'format': 'fits'})}"
    P = np.flipud(fits.getdata(io.BytesIO(fetch(url, os.path.join(cache, f"{s}-{w}-ps1-r.fits")))).astype(float))
    # Where PS1 has no data (gaps between its cells), the plates alone.
    missing = ndimage.binary_dilation(~np.isfinite(P) | (P == 0), iterations=int(2 * PS1_SCALE))
    P = np.nan_to_num(P)
    D = out[..., 0]
    lum0 = luminance(np.stack([D, 0.5 * (D + out[..., 2]), out[..., 2]], axis=-1))
    PLATE_NOISE[job_name] = float(1.4826 * np.median(np.abs((lum0 - ndimage.median_filter(lum0, 5))[w // 8:-w // 8, w // 8:-w // 8])))
    smooth = ndimage.gaussian_filter(D, PS1_SCALE)
    # PS1 in the plates' units, matched on isophotes just fainter than the saturated core
    # (the bulge, where PS1's sky subtraction took off only a near-constant; medians, so
    # stars don't count): D = k P + c.
    labels, _ = ndimage.label(ndimage.binary_closing(saturated, iterations=3))
    core0 = labels == labels[w // 2, w // 2] if labels[w // 2, w // 2] else rr < 0.02 * w
    top = float(np.percentile(smooth[core0], 5))
    levels = np.geomspace(0.2 * top, 0.8 * top, 12)
    clear = ~ndimage.binary_dilation(saturated, iterations=3) & (rr < 0.3 * w)
    pts = []
    for lo, hi in zip(levels[:-1], levels[1:]):
        band_ = (smooth > lo) & (smooth <= hi) & clear
        if band_.sum() > 50:
            pts.append((np.median(D[band_]), np.median(P[band_])))
    pts = np.array(pts)
    (k, offset), *_ = np.linalg.lstsq(np.stack([pts[:, 1], np.ones(len(pts))], axis=1), pts[:, 0], rcond=None)
    sharp = k * P + offset
    # Finer than PS1_SCALE, PS1's structure; coarser, the plates'.
    detail = smooth + k * (P - ndimage.gaussian_filter(P, PS1_SCALE))
    # The saturated core: PS1 itself.
    core = ndimage.binary_dilation(core0, iterations=6)
    blend = np.clip(ndimage.gaussian_filter(core.astype(float), 6) * 1.5, 0, 1)
    red = (1 - blend) * detail + blend * sharp
    gain = red / np.maximum(smooth, 1e-6 * smooth.max())
    # Only on the galaxy: on the empty sky the ratio would make PS1's noise the picture.
    edge = smooth[rr > 0.45 * w]
    bg = float(np.median(edge))
    sd = 1.4826 * float(np.median(np.abs(edge - bg))) + 1e-12
    on = np.maximum(np.clip((smooth - bg - 3 * sd) / (30 * sd), 0, 1), blend)
    # PS1's own artefacts (rings around its saturated stars) would cut holes in the light.
    gain = np.where(missing & ~core, 1.0, 1 + on * (np.maximum(gain, 0.2) - 1))
    for c in (0, 2):
        # Each band gets the same fine structure, as a ratio of its own smooth light; in
        # the core, the colour just outside it.
        sm_c = ndimage.gaussian_filter(out[..., c], PS1_SCALE)
        ring = ndimage.binary_dilation(core, iterations=10) & ~ndimage.binary_dilation(core, iterations=4)
        ratio = float(np.median(sm_c[ring] / np.maximum(smooth[ring], 1e-12))) if ring.any() else 1.0
        sm_c = (1 - blend) * sm_c + blend * smooth * ratio
        out[..., c] = sm_c * gain
    print(f"  PS1 r: x{k:.4g} + {offset:.3g} to the plate, core {int(core.sum())} px", flush=True)
    # PS1 does not saturate on a galaxy's core; only on bright stars (which are removed).
    saturated = saturated & ~core
    return out, saturated


def gaia_cone(ra: float, dec: float, radius: float, glim: float, cache: str, depth: int = 0) -> np.ndarray:
    """Foreground Gaia stars in a cone; a cone too crowded for the archive is split in four."""
    import fetch_images

    path = f"{cache}.csv"
    if os.path.exists(path) or depth >= 3:
        return gaia_foreground(ra, dec, radius, path, glim=glim)
    query = (
        "SELECT ra, dec, phot_g_mean_mag AS g, parallax, parallax_over_error AS poe, pmra, pmdec FROM gaiadr3.gaia_source "
        f"WHERE 1 = CONTAINS(POINT(ra, dec), CIRCLE({ra:.5f}, {dec:.5f}, {radius:.4f})) AND phot_g_mean_mag < {glim}"
    )
    body = urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query}).encode()
    try:
        with urllib.request.urlopen(urllib.request.Request(fetch_images.GAIA_TAP, data=body), timeout=300) as r:
            open(path, "wb").write(r.read())
        return gaia_foreground(ra, dec, radius, path, glim=glim)
    except OSError as err:
        print(f"  Gaia cone {radius:.2f} deg: {err}; splitting", flush=True)
    parts = []
    for k, (dx, dy) in enumerate(((-1, -1), (-1, 1), (1, -1), (1, 1))):
        d2 = dec + dy * radius * 0.5
        r2 = (ra + dx * radius * 0.5 / max(math.cos(math.radians(d2)), 0.05)) % 360
        parts.append(gaia_cone(r2, d2, radius * 0.72, glim, f"{cache}-{k}", depth + 1))
    return np.concatenate(parts)


def luminance(rgb: np.ndarray) -> np.ndarray:
    return rgb @ np.array([0.2126, 0.7152, 0.0722])


def ellipse_profile(lum: np.ndarray, r_ell: np.ndarray, radii: np.ndarray, bad: np.ndarray):
    """Median light in elliptical annuli (radius along the major axis, px), and whether
    the annulus holds saturated pixels."""
    edges = np.concatenate([[0], np.sqrt(radii[:-1] * radii[1:]), [radii[-1] * 1.05]])
    label = np.digitize(r_ell, edges)
    idx = np.arange(1, len(edges))
    vals = np.asarray(ndimage.median(lum, label, idx))
    sat = np.asarray(ndimage.mean(bad.astype(float), label, idx)) > 0.02
    empty = np.asarray(ndimage.sum(np.ones_like(lum), label, idx)) < 3
    return np.where(empty, np.nan, vals), sat | empty


def fit_profile(r: np.ndarray, data: np.ndarray, noise: float, spheroid: bool, rmax: float, prior=None, h_cat=None,
                late=False):
    """Exponential disc plus Sersic bulge (or a Sersic alone) along the major axis.
    Returns (disc I0, disc h, bulge I0, bulge re, bulge n), lengths in px."""
    sigma = 0.08 * np.abs(data) + 2 * noise
    best = (np.inf, None)
    ns = (0.6, 0.8, 1, 1.5, 2, 2.5, 3, 4, 5) if spheroid else (1, 1.5, 2, 2.5, 3, 4)
    if prior:
        ns = (prior[1],)
    # A bulge is more compact than its disc (r_e / h is about 0.2: Graham and Worley 2008).
    res = [prior[0]] if prior else np.geomspace(max(0.6, r[0]), rmax * (1.0 if spheroid else 0.2), 48)
    # Discs: within a factor of two of the catalogue's scale length (D25 / 6.4, Freeman).
    hs = [np.inf] if spheroid else np.geomspace(0.5 * h_cat, 1.6 * h_cat, 32) if h_cat else np.geomspace(0.12 * rmax, 0.8 * rmax, 32)
    for n in ns:
        b = sersic_b(n)
        for re in res:
            sb = np.exp(-b * (r / re) ** (1 / n))
            for h in hs:
                if re > 0.5 * h:
                    continue
                sd = np.exp(-r / h) if np.isfinite(h) else np.zeros_like(r)
                # Plus a constant: what the sky subtraction left.
                A = np.stack([sd / sigma, sb / sigma, 1 / sigma], axis=1)
                y = data / sigma
                coef, *_ = np.linalg.lstsq(A, y, rcond=None)
                coef[:2] = np.maximum(coef[:2], 0)
                chi = np.sum((A @ coef - y) ** 2)
                if chi < best[0]:
                    best = (chi, (coef[0], h, coef[1], re, n))
    if not spheroid and not prior:
        # A disc alone, unless the bulge makes the fit clearly better.
        best = (np.inf, None) if late else (best[0] / 0.7, best[1])
        for h in hs:
            A = np.stack([np.exp(-r / h) / sigma, 1 / sigma], axis=1)
            coef, *_ = np.linalg.lstsq(A, data / sigma, rcond=None)
            I = max(coef[0], 0)
            chi = np.sum((A @ [I, coef[1]] - data / sigma) ** 2)
            if chi < best[0]:
                best = (chi, (I, h, 0.0, res[0], 1.0))
    return best[1]


def fit_2d(lum: np.ndarray, c: tuple, major: np.ndarray, minor: np.ndarray, q: float, qb: float, r25_px: float,
           h_cat: float, noise: float, bad: np.ndarray, late: bool, prior=None):
    """Exponential disc (flattened by the inclination) plus a rounder Sersic bulge, fitted
    to the inner galaxy in 2D: the two differ along the minor axis, which a profile along
    the major axis can't tell apart. Returns (disc I0, h, bulge I0, re, n, bulge axis ratio on
    the sky), px."""
    n = lum.shape[0]
    half = int(max(24, 0.45 * r25_px))
    f = max(1, half // 64)
    x0, y0 = int(c[0]) - half, int(c[1]) - half
    sl = (slice(max(y0, 0), min(y0 + 2 * half, n)), slice(max(x0, 0), min(x0 + 2 * half, n)))
    crop, cbad = lum[sl], bad[sl]
    hh, ww = crop.shape[0] // f * f, crop.shape[1] // f * f
    data = crop[:hh, :ww].reshape(hh // f, f, ww // f, f).mean(axis=(1, 3))
    keep = ~cbad[:hh, :ww].reshape(hh // f, f, ww // f, f).any(axis=(1, 3))
    yy, xx = np.mgrid[0:hh // f, 0:ww // f].astype(float) * f + (f - 1) / 2
    xx += sl[1].start - c[0]
    yy += sl[0].start - c[1]
    a = xx * major[0] + yy * major[1]
    b = xx * minor[0] + yy * minor[1]
    # Saturated pixels only say the light is at least this much: the bulge's, toward the
    # minor axis (along the major axis the inner disc adds its own).
    low = ~keep & (np.hypot(a, b / max(q, 0.06)) < 0.2 * r25_px) & (np.abs(a) < np.abs(b))
    low_y = data[low]
    low_rd = np.hypot(a, b / max(q, 0.06))[low]
    rd = np.hypot(a, b / max(q, 0.06))[keep]
    # The bulge's own flattening on the sky: from round down to the disc's (an intrinsic
    # axis ratio seen at this inclination).
    qbs = sorted({round(float(v), 3) for v in np.linspace(max(qb, q), 1.0, 6)} | {round(qb, 3)})
    rbs = {v: (np.hypot(a, b / v)[keep], np.hypot(a, b / v)[low]) for v in qbs}
    y = data[keep]
    w = 1 / (0.1 * np.abs(y) + 2 * noise / f)
    hs = np.geomspace(0.5 * h_cat, 1.6 * h_cat, 12)
    ns = (prior[1],) if prior else (1, 1.5, 2, 2.5, 3, 4)
    # An exponential disc; seen edge-on, summed along the line of sight: (x/h) K1(x/h).
    edge = q <= 0.06
    shape = (lambda r, h: np.where(r > 0, (np.maximum(r, 1e-9) / h) * special.k1(np.maximum(r, 1e-9) / h), 1.0)) if edge \
        else (lambda r, h: np.exp(-r / h))

    def disc_fit(sel):
        best = (np.inf, None)
        for h in hs:
            A = np.stack([shape(rd[sel], h) * w[sel], w[sel]], axis=1)
            coef, *_ = np.linalg.lstsq(A, y[sel] * w[sel], rcond=None)
            coef[0] = max(coef[0], 0)
            chi = np.sum((A @ coef - y[sel] * w[sel]) ** 2)
            if chi < best[0]:
                best = (chi, (coef[0], h, coef[1]))
        return best[1]

    I0, h, sky = disc_fit(np.ones_like(y, bool))
    if late and not prior:
        return I0, h, 0.0, 1.0, 1.0, qb
    if prior and not low.any():
        # A bulge that dominates (its size and profile known): fit both together.
        bn = sersic_b(prior[1])
        best = (np.inf, None)
        for hv in hs:
            D = shape(rd, hv) * w
            for qv, (rb, _) in rbs.items():
                A = np.stack([D, np.exp(-bn * (rb / prior[0]) ** (1 / prior[1])) * w, w], axis=1)
                coef, *_ = np.linalg.lstsq(A, y * w, rcond=None)
                coef[:2] = np.maximum(coef[:2], 0)
                chi = np.sum((A @ coef - y * w) ** 2)
                if chi < best[0]:
                    best = (chi, (coef[0], hv, coef[1], prior[0], prior[1], qv))
        return best[1]
    # The disc from outside the bulge, carried in; the bulge is what the middle holds above it.
    rin = 0.2 * r25_px
    # Outside both the disc's and a bulge's ellipse (above an inclined disc the bulge rules).
    outer = (rd > rin) & (rbs[round(qb, 3)][0] > rin)
    if outer.sum() > 50:
        I0, h, sky = disc_fit(outer)
    resid = y - I0 * shape(rd, h) - sky
    inner = ~outer
    low_resid = low_y - I0 * shape(low_rd, h) - sky
    low_w = 1 / (0.1 * np.abs(low_y) + 2 * noise / f)
    chi0 = np.sum((resid * w)[inner] ** 2) + np.sum((np.maximum(low_resid, 0) * low_w) ** 2)
    best = (np.inf, None)
    res = [prior[0]] if prior else np.geomspace(max(0.7, f / 2), 0.25 * r25_px, 20)
    if low.any() and not prior:
        # A saturated core hides the bulge's cusp, so only bounds it from below: keep to
        # the shallower profiles.
        ns = tuple(v for v in ns if v <= 2.5)
    for sn in ns:
        bn = sersic_b(sn)
        for re in res:
            for qv, (rb, rb_low) in rbs.items():
                prof = np.exp(-bn * (rb[inner] / re) ** (1 / sn)) * w[inner]
                lp = np.exp(-bn * (rb_low / re) ** (1 / sn)) * low_w
                lr = low_resid * low_w
                # Least squares, holding the bulge up to the saturated pixels where it falls short.
                act = np.zeros(len(lp), bool)
                for _ in range(4):
                    P = np.concatenate([prof, lp[act]])
                    Ib = max(float(np.dot(P, np.concatenate([resid[inner] * w[inner], lr[act]])) / max(np.dot(P, P), 1e-30)), 0.0)
                    nxt = Ib * lp < lr
                    if (nxt == act).all():
                        break
                    act = nxt
                chi = np.sum((resid[inner] * w[inner] - Ib * prof) ** 2) + np.sum(np.maximum(lr - Ib * lp, 0) ** 2)
                if chi < best[0]:
                    best = (chi, (I0, h, Ib, re, sn, qv))
    # The bulge must make the middle clearly better.
    return best[1] if prior or best[0] < 0.8 * chi0 else (I0, h, 0.0, 1.0, 1.0, qb)


def process(job: dict, geo: dict, cache: str, out_dir: str, bright: np.ndarray, gal: dict,
            companions: list) -> tuple[dict, dict, list]:
    name, s, w, fov = job["name"], slug(job["name"]), job["width"], job["fov"]
    print(f"{name}: {fov:.2f} deg at {w} px", flush=True)
    lin, survey, saturated = survey_image(job, cache)
    pix = fov / w * 3600  # arcsec per pixel
    # Foreground stars: Gaia to a depth that shows at this scale, field split into cones.
    glim = min(19.0, 19.5 - 3.75 * math.log10(max(pix, 1.0)))
    if fov > 6:
        # The Magellanic Clouds: their own stars crowd Gaia's servers past their time limit,
        # and at this scale fainter foreground stars are lost in the clouds' light.
        glim = min(glim, 13.0)
    radius = fov * 0.72
    tile = 0.5 if fov < 6 else 1.0
    stars = []
    k = max(1, math.ceil(radius / (tile * 0.7)))
    for a in range(-k + 1, k):
        for b in range(-k + 1, k):
            dec = job["dec"] + (a * 2 * tile * 0.7 if k > 1 else 0)
            ra = (job["ra"] + (b * 2 * tile * 0.7 if k > 1 else 0) / max(math.cos(math.radians(dec)), 0.05)) % 360
            rr = tile if k > 1 else radius
            if k > 1 and (abs(dec) > 89 or separation(job["ra"], job["dec"], ra, dec) > radius + rr):
                continue
            stars.append(gaia_cone(ra, dec, rr, glim, os.path.join(cache, f"{s}-gaia-{glim:.1f}-{a}-{b}")))
    stars = np.concatenate(stars) if stars else np.zeros((0, 3))
    near = separation(job["ra"], job["dec"], bright[:, 0], bright[:, 1]) < radius
    stars = np.concatenate([stars, bright[near]]) if near.any() else stars
    # Other catalogue galaxies in the frame (drawn in their own places), but not the
    # galaxy's own core (Gaia lists some nuclei and knots).
    others = []
    x, y = tangent(job["ra"], job["dec"], gal["ra"], gal["dec"])
    inside = (np.abs(x) < fov / 2) & (np.abs(y) < fov / 2) & (np.arange(len(x)) != job["index"]) & (gal["r25"] * 3600 > 20)
    inside &= ~np.isin(np.arange(len(x)), job.get("skip", []))
    for i in np.nonzero(inside)[0]:
        others.append((gal["ra"][i], gal["dec"][i], gal["r25"][i] * 3600 * 1.1))
    core = gal["r25"][job["index"]] * 3600 * 0.04
    if len(stars):
        sep = np.hypot(*tangent(job["ra"], job["dec"], stars[:, 0], stars[:, 1])) * 3600
        stars = stars[sep > core]
    img = clean_linear(lin, fov, job["ra"], job["dec"], stars, others, star_scale=1.0 if survey == "DSS2" else 0.8)
    plate = None
    if name in PLATE_ONLY:
        plate_lin, plate_sat = PLATE_ONLY.pop(name)
        plate = clean_linear(plate_lin, fov, job["ra"], job["dec"], stars, others, star_scale=1.0)
    lum = luminance(img)
    n = w
    hp = (lum - ndimage.median_filter(lum, 5))[n // 8:-n // 8, n // 8:-n // 8]
    # (With PS1's detail added, its resolved stars are not noise: the plates' own.)
    noise = PLATE_NOISE.get(name, 1.4826 * np.median(np.abs(hp))) + 1e-12
    extra = []
    for cname, cgeo in companions:
        img, centry = fit_companion(img, cname, cgeo, job, pix, noise, saturated)
        centry["with"] = name
        centry["survey"] = survey
        extra.append(centry)
        if plate is not None:
            plate, _ = fit_companion(plate, cname, cgeo, job, pix, noise, plate_sat)
    lum = luminance(img)
    lum_fit, sat_fit, noise_fit = lum, saturated, noise
    if plate is not None:
        lum_fit, sat_fit = luminance(plate), plate_sat
        noise_fit = 1.4826 * np.median(np.abs((lum_fit - ndimage.median_filter(lum_fit, 5))[n // 8:-n // 8, n // 8:-n // 8])) + 1e-12

    # Geometry: centre (the light's peak near the catalogue position), axes on the image.
    pa, q, spheroid = geo["pa"], GEOMETRY.get(name, {}).get("q", geo["q"]), geo["spheroid"]
    cosi = 0.0 if spheroid else math.sqrt(min(1.0, max(0.0, (q * q - 0.04) / 0.96)))
    kpc_per_px = geo["dist"] * 1e3 * math.radians(pix / 3600)
    r25_px = geo["r25"] * 3600 / pix
    sm = ndimage.gaussian_filter(lum, max(1.0, 0.01 * r25_px))
    cx0, cy0 = n / 2 - 0.5, n / 2 - 0.5
    win = int(max(3, 0.03 * r25_px))
    sub = sm[int(cy0) - win:int(cy0) + win + 1, int(cx0) - win:int(cx0) + win + 1]
    py, px = np.unravel_index(np.argmax(sub), sub.shape)
    cx, cy = int(cx0) - win + px, int(cy0) - win + py
    # The nucleus on the sky, where the model is centred.
    east, north = -(cx - cx0) * pix / 3600, -(cy - cy0) * pix / 3600
    dec_c = job["dec"] + north
    ra_c = job["ra"] + east / math.cos(math.radians(dec_c))
    major = np.array([-math.sin(pa), -math.cos(pa)])  # (col, row)
    minor = np.array([-math.cos(pa), math.sin(pa)])

    # Bulge and disc along the major axis.
    rmax = 0.75 * r25_px
    radii = np.geomspace(0.7, rmax, 80)
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    a_ = (xx - cx) * major[0] + (yy - cy) * major[1]
    b_ = (xx - cx) * minor[0] + (yy - cy) * minor[1]
    prof, sat = ellipse_profile(lum, np.hypot(a_, b_ / max(q, 0.15)), radii, ndimage.binary_dilation(saturated, iterations=2))
    ok = ~sat & (prof > 2 * noise)
    if survey == "DSS2" and sat[0]:
        # Plates saturate gradually: leave out a saturated core out to 1.5 times its radius.
        core = radii[np.argmin(sat)] if not sat.all() else radii[-1]
        ok &= radii > 1.5 * core
    if ok.sum() < 6:
        # Saturated nearly throughout: the plate's shape is all there is.
        ok = np.isfinite(prof) & (prof > 2 * noise)
    prior = (PRIORS[name][0] / kpc_per_px, PRIORS[name][1]) if name in PRIORS else None
    q0 = max(q, 0.1) if spheroid else BULGE_Q0
    qb = q0 if spheroid else math.sqrt(cosi ** 2 + q0 ** 2 * (1 - cosi ** 2))
    if spheroid:
        I_d, h_px, I_b, re_px, sn = fit_profile(radii[ok], prof[ok], noise, spheroid, rmax, prior, geo["h"] / kpc_per_px)
    else:
        # Edge-on, the catalogue's axis ratio is the bulge's and the disc's outline together;
        # the disc itself is far thinner.
        q_disc = 0.06 if cosi < EDGE_ON else q
        I_d, h_px, I_b, re_px, sn, qb = fit_2d(lum_fit, (cx, cy), major, minor, q_disc, qb, r25_px, geo["h"] / kpc_per_px, noise_fit,
                                           ndimage.binary_dilation(sat_fit, iterations=2), name in BULGELESS, prior)
        # The intrinsic axis ratio that looks this flat at this inclination.
        q0 = math.sqrt(max(qb ** 2 - cosi ** 2, 0.0) / max(1 - cosi ** 2, 1e-6)) if cosi < 0.999 else BULGE_Q0
        q0 = min(max(q0, 0.3), 1.0)
    bn = sersic_b(sn)
    m = np.hypot(a_, b_ / qb) / re_px
    if plate is not None and prior:
        # PS1's core is not saturated: the bulge's size, profile and amplitude are what it
        # shows above the plate's disc (a lower bound on the plates, so the prior there).
        disc_px = I_d * np.exp(-np.hypot(a_, b_ / max(q, 0.06)) / h_px)
        rb = np.hypot(a_, b_ / qb)
        inside = (rb < 4 * re_px) & ~ndimage.binary_dilation(saturated, iterations=2)
        y_b = (lum - disc_px)[inside]
        wt = 1 / (0.05 * np.abs(lum[inside]) + noise)
        best = (np.inf, None)
        for sv in (0.6, 0.8, 1.0, 1.25, 1.5, 1.75, 2.0, 2.2, 2.5, 3.0, 4.0):
            for rv in np.geomspace(0.5 * re_px, 3 * re_px, 15):
                prof_b = np.exp(-sersic_b(sv) * (rb[inside] / rv) ** (1 / sv)) * wt
                Iv = max(float(np.dot(prof_b, y_b * wt) / np.dot(prof_b, prof_b)), 0.0)
                chi = float(np.sum((y_b * wt - Iv * prof_b) ** 2))
                if chi < best[0]:
                    best = (chi, (Iv, rv, sv))
        I_b, re_px, sn = best[1]
        bn = sersic_b(sn)
        m = rb / re_px
    # The bulge as the survey saw it: blurred by the seeing (FWHM about 1.4" for SDSS, 3" for the plates).
    psf = (1.4 if survey == "SDSS" else 1.2 if name in PS1_DETAIL else 3.0) / 2.355 / pix
    bulge_map = ndimage.gaussian_filter(I_b * np.exp(-bn * m ** (1 / sn)), psf) if psf > 0.3 else I_b * np.exp(-bn * m ** (1 / sn))
    # Its colour: the image's at the centre (dust-free in front of the bulge, mostly).
    rc = max(2.0, 0.3 * re_px)
    centre = np.hypot(xx - cx, yy - cy) < rc
    centre &= ~ndimage.binary_dilation(saturated, iterations=1) if (~saturated[centre]).sum() > 4 else centre
    colour = img[centre].mean(axis=0)
    colour = colour / max(luminance(colour), 1e-12)
    unit = 2 * math.pi * qb * re_px ** 2 * sn * bn ** (-2 * sn) * special.gamma(2 * sn)
    Lb = I_b * unit
    disc_img = np.clip(img - bulge_map[..., None] * colour, 0, None)
    disc_model = I_d * np.exp(-np.hypot(a_, b_ / max(q if cosi >= EDGE_ON else 0.06, 0.06)) / h_px)
    lab, _ = ndimage.label(ndimage.binary_dilation(saturated, iterations=3))
    core = (lab == lab[int(cy), int(cx)]) & (lab > 0)
    # The sky as it is: where the plate is saturated, the bulge and disc that were fitted.
    sky_true = np.where(core, np.maximum(bulge_map + disc_model, lum), lum) if not spheroid else lum
    if core.any() and not spheroid and I_b > 0:
        # Where the plate is saturated, and on the shoulder around it where it is nearly so,
        # what is left after taking the bulge away is not the disc: it goes to the bulge,
        # and the disc goes on smoothly underneath, carried in from around.
        plateau = float(np.median(lum[core]))
        core |= ndimage.gaussian_filter(lum, 2) > 0.5 * plateau
        lab, _ = ndimage.label(core)
        core = ndimage.binary_fill_holes(ndimage.binary_closing(lab == lab[int(cy), int(cx)], iterations=4))
        size = math.sqrt(core.sum() / math.pi)
        core = ndimage.gaussian_filter(core.astype(float), 0.15 * size) > 0.3
        fill = inpaint(disc_img, core, size)
        Lb += max(float(luminance(disc_img[core]).sum() - luminance(fill[core]).sum()), 0.0)
        disc_img[core] = fill[core]
    if I_b > 0 and not spheroid:
        # Where the bulge's model overshoots a little at its peak the disc would have a hole.
        dip = (np.hypot(xx - cx, yy - cy) < 2 * re_px) & (luminance(disc_img) < 0.3 * disc_model)
        if dip.any():
            dip = ndimage.binary_dilation(dip, iterations=2)
            disc_img = inpaint(disc_img, dip, math.sqrt(dip.sum() / math.pi) + 2)
    # The galaxy's light: what is left of the image, plus the bulge.
    total = float(luminance(disc_img).sum()) + Lb
    if spheroid:
        total = Lb = float(lum.sum())
    # Only the galaxy: faint stars and background galaxies around it would otherwise be
    # spread through the disc's thickness.
    body = blur(lum, max(2.0, 0.03 * r25_px))
    disc_img *= np.clip((body / (6 * noise / max(1.0, 0.03 * r25_px)) - 1) / 3, 0, 1)[..., None]
    print(f"  {survey}; bulge n={sn:.1f} re={re_px * kpc_per_px:.2f} kpc q0={q0:.2f} B/T={Lb / total:.2f}; "
          f"disc h={h_px * kpc_per_px:.2f} kpc; i={math.degrees(math.acos(cosi)):.0f} deg", flush=True)

    h_kpc = float(h_px * kpc_per_px) if np.isfinite(h_px) else float(geo["h"])
    h_kpc = min(max(h_kpc, 0.5 * geo["h"]), 2.0 * geo["h"])
    z0 = THICK.get(name, DISC_Z0) * h_kpc
    R = n / 2 * kpc_per_px
    entry = {"name": name, "survey": "DSS2+PS1" if name in PS1_DETAIL else survey, "kind": "spheroid" if spheroid else "disc", "ra": round(ra_c, 6),
             "dec": round(dec_c, 6), "pa": round(math.degrees(pa), 2), "q": round(q, 4), "R": round(R, 4),
             "total": total, "bulge": {"L": Lb / total, "re": float(re_px * kpc_per_px), "n": sn, "q0": q0,
                                       "colour": [round(float(v), 4) for v in colour]}}
    fixture = {}
    if spheroid:
        entry["H"] = round(max(R * q0, 0.05 * R), 4)
        fixture = {"sky": lum, "centre": [cx - cx0, cy - cy0]}
        return (*finish(entry, fixture, kpc_per_px, n), extra)

    # Dust lanes: light that is both redder and fainter than its surroundings (the bulge
    # plus the disc smoothed over a lane's width). Either alone is not dust: arms are
    # bluer and brighter than the gaps between them, which are redder and fainter but smooth.
    k = REDDENING[survey]
    scale = max(3.0, 0.02 * r25_px)
    smooth = [blur(disc_img[..., c], scale) for c in range(3)]
    eps = 3 * noise
    ref_rgb = [bulge_map * colour[c] + smooth[c] for c in range(3)]
    fine = [ndimage.gaussian_filter(img[..., c], 1) for c in range(3)]
    redder = np.log((fine[0] + eps) / (fine[2] + eps)) - np.log((ref_rgb[0] + eps) / (ref_rgb[2] + eps))
    fainter = np.log((luminance(np.stack(ref_rgb, -1)) + eps) / (luminance(np.stack(fine, -1)) + eps))
    tau_col = MIXING * np.clip(redder, 0, None) / k
    tau_dim = MIXING * np.clip(fainter, 0, None)
    tau_slant = np.sqrt(tau_col * tau_dim) * (ndimage.gaussian_filter(luminance(np.stack(ref_rgb, -1)), 2) > 25 * noise)
    # Near side: the lanes in front of the bulge redden it.
    zone = (np.hypot(a_, b_) < max(3 * re_px, 0.12 * r25_px)) & (np.hypot(a_, b_) > max(0.5 * re_px, 2))
    plus, minus = tau_slant[zone & (b_ > 0)].mean() if (zone & (b_ > 0)).any() else 0, tau_slant[zone & (b_ < 0)].mean() if (zone & (b_ < 0)).any() else 0
    near = 1 if plus > minus * 1.1 else -1 if minus > plus * 1.1 else 0
    edge_on = cosi < EDGE_ON

    # Deproject onto the disc plane: X along the major axis, Y in the plane, seen from
    # Earth along +minor. Face-on light per kpc^2.
    nx = n
    ny = n if edge_on else int(round(n * max(cosi, 0.25) / 8)) * 8
    X = (np.arange(nx) + 0.5) / nx * 2 * R - R
    Y = R - (np.arange(ny) + 0.5) / ny * 2 * R
    XX, YY = np.meshgrid(X, Y)
    cols = cx + (XX * major[0] + YY * cosi * minor[0]) / kpc_per_px
    rows = cy + (XX * major[1] + YY * cosi * minor[1]) / kpc_per_px
    rr = np.hypot(XX, YY)
    # Dust clears out of a bulge (M31, M81, the Sombrero): the smooth layer has a hole
    # the bulge's size.
    hole = 1.5 * re_px * kpc_per_px if Lb > 0.05 * total else 0.0
    tau_smooth = DUST_TAU0 * np.exp(-rr / (DUST_SCALE * h_kpc))
    if hole > 0:
        tau_smooth *= 1 - np.exp(-(rr / hole) ** 2)
    thin_z, thin_frac = None, None
    if edge_on:
        # The face can't be seen: a smooth exponential disc with the disc's light and colour.
        dl = disc_img.sum(axis=(0, 1))
        face = np.exp(-rr / h_kpc)[..., None] * (dl / luminance(dl))
        tau_lane = np.zeros_like(rr)
        disc_light = float(luminance(dl))
        face *= disc_light / (luminance(face).sum() * (2 * R / nx) * (2 * R / ny))
        # Its thickness from the light's spread across the plane, away from the bulge.
        # Measured from the disc's own ridge at each place along it (the catalogue's position
        # angle is a degree or two off, which would smear the profile).
        zprof = []
        sm = ndimage.gaussian_filter(luminance(disc_img), 1)
        off = np.linspace(0, 0.15 * r25_px, 40)
        span = np.linspace(-0.15 * r25_px, 0.15 * r25_px, 121)
        for sgn in (1, -1):
            for along in np.linspace(0.3, 1.2, 10) * min(h_px, 0.4 * r25_px):
                c0 = np.array([cx, cy]) + sgn * along * major
                cut = ndimage.map_coordinates(sm, [c0[1] + span * minor[1], c0[0] + span * minor[0]], order=1)
                if cut.max() <= 0:
                    continue
                top = span[np.argmax(cut)]
                c1 = c0 + top * minor
                zprof.append((ndimage.map_coordinates(sm, [c1[1] + off * minor[1], c1[0] + off * minor[0]], order=1)
                              + ndimage.map_coordinates(sm, [c1[1] - off * minor[1], c1[0] - off * minor[0]], order=1))
                             / max(cut.max(), 1e-30))
        zp = np.mean(zprof, axis=0)
        # A thin disc and a thick one (each sech^2), fitted to the profile across the plane.
        zk = off * kpc_per_px
        ok = zp > 0.01 * zp.max()
        sech2 = lambda x: 1 / np.cosh(np.minimum(x, 40)) ** 2
        best = (np.inf, None)
        for z1 in np.geomspace(0.03 * h_kpc, 0.3 * h_kpc, 24):
            for z2 in np.geomspace(z1 * 1.5, 0.5 * h_kpc, 16):
                A = np.stack([sech2(zk / z1), sech2(zk / z2)], axis=1)[ok]
                wz = 1 / zp[ok]  # relative errors: the faint wings count
                coef, *_ = np.linalg.lstsq(A * wz[:, None], zp[ok] * wz, rcond=None)
                if (coef < 0).any():
                    continue
                chi = np.sum((A @ coef - zp[ok]) ** 2 * wz ** 2)
                if chi < best[0]:
                    best = (chi, (z1, z2, coef))
        if best[1] is not None:
            z1, z2, (a1, a2) = best[1]
            z0, thin_z = float(z2), float(z1)
            thin_frac = float(a1 * z1 / (a1 * z1 + a2 * z2))
    else:
        sample = lambda a: ndimage.map_coordinates(a, [rows, cols], order=1, mode="constant", cval=0)
        face = np.stack([sample(disc_img[..., c]) for c in range(3)], axis=-1) * cosi / kpc_per_px ** 2
        tau_lane = ndimage.gaussian_filter(sample(tau_slant), 0.7) * cosi
        tau_lane = np.clip(tau_lane, 0, 4)
        # Undo the dust's dimming as seen from Earth (stars and dust mixed, the dust thinner).
        x_ = (tau_lane + tau_smooth) / max(cosi, 0.25)
        inner = DUST_Z0
        trans = (1 - inner) * (0.5 + 0.5 * np.exp(-x_)) + inner * (1 - np.exp(-x_)) / np.maximum(x_, 1e-6)
        face /= np.maximum(trans, 1 / 3)[..., None]
    # A round galaxy, not a square picture: fade out before the box's edge.
    win = np.clip((0.95 * R - rr) / (0.2 * R), 0, 1) ** 2
    face *= win[..., None]
    tau_lane = tau_lane * win
    # What Earth sees is after the galaxy's own dust: the light that is put in is that much
    # more, worked out along the same sight lines the renderer takes.
    view = view_dir(cosi, near)
    zd = DUST_Z0 * (thin_z or z0)
    H = max(5 * z0, (6 if sn >= 3 else 4) * re_px * kpc_per_px * q0, 0.02 * R)
    disc_seen = luminance(disc_img).sum()
    face0 = face

    def corrected(tau0: float, kb: float = 1.0, lane=None):
        # kb: the bulge's share of the image's light scaled by this, the disc's the rest.
        dust_map = (tau_lane if lane is None else lane) + tau_smooth * (tau0 / DUST_TAU0)
        out = face0
        disc_model = luminance(face0).sum() * (2 * R / face0.shape[1]) * (2 * R / face0.shape[0])
        if disc_model > 0:
            f_d = seen_fraction(*disc_points(luminance(face0), R, z0), dust_map, R, H, zd, view)
            if thin_z:
                f_d = (1 - thin_frac) * f_d + thin_frac * seen_fraction(*disc_points(luminance(face0), R, thin_z), dust_map,
                                                                        R, H, zd, view)
            out = face0 * (disc_seen - (kb - 1) * Lb) / (disc_model * f_d)
        lb = kb * Lb / seen_fraction(*bulge_points(re_px * kpc_per_px, sn, q0), dust_map, R, H, zd, view) if Lb > 0 else 0.0
        return out, lb, dust_map

    tau0, kb = DUST_TAU0, 1.0
    if edge_on:
        # Neither the lanes nor the bulge can be told apart from the disc face-on: the smooth
        # dust's depth and the bulge's share are those whose picture from Earth looks most
        # like the image.
        best = (-np.inf, tau0, kb, None)
        # A dust ring: its radius (fraction of the disc's scale length) and face-on depth.
        rings = [None]
        if GEOMETRY.get(name, {}).get("ring"):
            rings = [(r0, tr) for r0 in (0.6, 0.75, 0.9, 1.05, 1.2) for tr in (0.5, 1.0, 2.0, 4.0)]
        for ring in rings:
            lane = tau_lane if ring is None else ring[1] * np.exp(-(((rr - ring[0] * h_kpc) / (0.12 * ring[0] * h_kpc)) ** 2))
            for k_ in ((1.0, 1.5, 2.0, 3.0, 4.0, 6.0) if Lb > 0 else (1.0,)):
                if (k_ - 1) * Lb >= 0.8 * disc_seen:
                    continue
                for t0 in ((0.0, 0.05, 0.1, 0.2, 0.35, 0.7) if ring is None else (0.0, 0.05)):
                    f_, lb, dm = corrected(t0, k_, lane)
                    c = edge_on_match(sky_true, (cx, cy), major, minor, kpc_per_px, R, H, sky_axes(cosi, near), f_, dm,
                                      z0, thin_z, thin_frac, zd, lb, re_px * kpc_per_px, sn, q0, n=48 if ring is None else 96)
                    if c > best[0]:
                        best = (c, t0, k_, ring)
        _, tau0, kb, ring = best
        if ring is not None:
            tau_lane = ring[1] * np.exp(-(((rr - ring[0] * h_kpc) / (0.12 * ring[0] * h_kpc)) ** 2)) * win
            print(f"  edge-on: dust ring at {ring[0] * h_kpc:.2f} kpc, tau {ring[1]}", flush=True)
        print(f"  edge-on: smooth dust tau0 = {tau0}, bulge x{kb} (match {best[0]:.3f})", flush=True)
    face, Lb_int, _ = corrected(tau0, kb)
    if Lb > 0:
        entry["bulge"]["L"] = Lb_int / total
    entry.update({"z0": round(z0, 4), "zd": round(zd, 4), "tau0": tau0, "hd": round(DUST_SCALE * h_kpc, 4),
                  "dh": round(hole, 4),
                  **({"zy": round(thin_z, 4)} if thin_z else {}),
                  "h": round(h_kpc, 4), "near": near, "edgeOn": bool(edge_on), "cosi": round(cosi, 4),
                  "H": round(H, 4)})
    fixture = {"sky": sky_true, "face": luminance(face), "tau": tau_lane, "centre": [cx - cx0, cy - cy0]}
    return (*finish(entry, fixture, kpc_per_px, n, face, tau_lane, out_dir, s, thin_frac), extra)


def edge_on_match(sky, c, major, minor, kpc_per_px, R, H, axes, face, dust, z0, zy, frac, zd, Lb, re, sn, q0, n=48) -> float:
    """How much a model, ray-traced toward Earth on an n x n grid, looks like the image:
    correlation of square-root brightness (as the gate test measures it)."""
    half = 0.9 * R
    g = (np.arange(n) + 0.5) / n * 2 * half - half
    A, B = np.meshgrid(g, g)
    px = 2 * half / n / kpc_per_px
    sm = ndimage.gaussian_filter(sky, max(px / 2.355, 0.5))
    obs = ndimage.map_coordinates(sm, [c[1] + (A * major[1] + B * minor[1]) / kpc_per_px,
                                       c[0] + (A * major[0] + B * minor[0]) / kpc_per_px], order=1)
    # In view_dir's sky frame the major axis is north (y), the minor axis east (x), z away
    # from Earth; the same vectors in the model's frame:
    E, N, view = (np.array([a[k] for a in axes]) for k in range(3))
    p0 = B.ravel()[:, None] * E + A.ravel()[:, None] * N - 3 * R * view
    steps = 200
    t = np.linspace(0, 6 * R, steps + 1)
    dt = t[1] - t[0]
    hh, ww = face.shape[:2]
    lum = luminance(face)
    bn = sersic_b(sn)
    p = 1 - 0.6097 / sn + 0.05463 / sn ** 2
    rho0 = Lb / (4 * math.pi * q0 * re ** 3 * sn * bn ** (-sn * (3 - p)) * special.gamma(sn * (3 - p))) if Lb > 0 else 0.0
    light = np.zeros(len(p0))
    trans = np.ones(len(p0))
    sech2 = lambda x: 1 / np.cosh(np.minimum(np.abs(x), 40)) ** 2
    for k in range(steps):
        q = p0 + (t[k] + dt / 2) * view
        inside = (np.abs(q[:, 0]) < R) & (np.abs(q[:, 1]) < R) & (np.abs(q[:, 2]) < H)
        u = np.clip((q[:, 0] / R * 0.5 + 0.5) * ww - 0.5, 0, ww - 1)
        v = np.clip((-q[:, 1] / R * 0.5 + 0.5) * hh - 0.5, 0, hh - 1)
        f = ndimage.map_coordinates(lum, [v, u], order=1) * inside
        tau = ndimage.map_coordinates(dust, [v, u], order=1) * inside
        j = f * ((1 - (frac or 0)) * sech2(q[:, 2] / z0) / (2 * z0) + ((frac or 0) * sech2(q[:, 2] / zy) / (2 * zy) if zy else 0))
        if rho0 > 0:
            m = np.maximum(np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2 + (q[:, 2] / q0) ** 2) / re, 1e-3)
            # Faded out inside the box as the renderer does (core/galaxymodel.ts bulgeTaper).
            e = np.sqrt((q[:, 0] / R) ** 2 + (q[:, 1] / R) ** 2 + (q[:, 2] / H) ** 2)
            tt = np.clip((e - 0.7) / 0.3, 0, 1)
            j = j + rho0 * m ** -p * np.exp(-bn * m ** (1 / sn)) * inside * (1 - tt * tt * (3 - 2 * tt))
        a = tau * sech2(q[:, 2] / zd) / (2 * zd) * dt
        light += trans * j * dt * np.where(a > 1e-4, (1 - np.exp(-a)) / np.maximum(a, 1e-12), 1.0)
        trans *= np.exp(-a)
    sa, sb = np.sqrt(np.clip(obs.ravel(), 0, None)), np.sqrt(np.clip(light, 0, None))
    return float(np.corrcoef(sa, sb)[0, 1])


def inpaint(img: np.ndarray, hole: np.ndarray, size: float) -> np.ndarray:
    """Fill `hole` smoothly from the pixels around it (diffusion on a coarse grid)."""
    f = max(1, int(size // 24))
    pad = int(2 * size)
    ys, xs = np.nonzero(hole)
    y0, y1 = max(ys.min() - pad, 0), min(ys.max() + pad, img.shape[0])
    x0, x1 = max(xs.min() - pad, 0), min(xs.max() + pad, img.shape[1])
    y1, x1 = y0 + (y1 - y0) // f * f, x0 + (x1 - x0) // f * f
    sub, hs = img[y0:y1, x0:x1], hole[y0:y1, x0:x1]
    h, w = sub.shape[0] // f, sub.shape[1] // f
    known = ~hs.reshape(h, f, w, f).any(axis=(1, 3))
    small = sub.reshape(h, f, w, f, 3).mean(axis=(1, 3))
    cur = small.copy()
    cur[~known] = small[known].mean(axis=0)
    for _ in range(400):
        cur = ndimage.uniform_filter(cur, size=(3, 3, 1), mode="nearest")
        cur[known] = small[known]
    out = img.copy()
    big = ndimage.zoom(cur, (f, f, 1), order=1, grid_mode=True, mode="nearest")
    region = out[y0:y1, x0:x1]
    region[hs] = big[: y1 - y0, : x1 - x0][hs]
    return out


def sky_axes(cosi: float, near: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The model's axes (core/galaxymodel.ts modelAxes) in a sky frame with the major axis
    north (y), the minor axis east (x) and z away from Earth."""
    sini = math.sqrt(max(1 - cosi * cosi, 0.0))
    X = np.array([0.0, 1.0, 0.0])
    Y = cosi * np.array([1.0, 0.0, 0.0]) + (-1 if near == 1 else 1) * sini * np.array([0.0, 0.0, 1.0])
    return X, Y, np.cross(X, Y)


def view_dir(cosi: float, near: int) -> np.ndarray:
    """The direction away from Earth in the model's frame; it does not depend on the
    position angle."""
    return np.array([a[2] for a in sky_axes(cosi, near)])


def seen_fraction(p: np.ndarray, w: np.ndarray, tau: np.ndarray, R: float, H: float, zd: float, d: np.ndarray) -> float:
    """Fraction of the light of sources at points `p` (N x 3, model frame, kpc) with weights
    `w` that gets through the dust on its way to Earth: optical depth `tau` face-on over
    [-R, R]^2 in a sech^2 layer of scale height zd, integrated along each sight line out of
    the box, as the renderer does."""
    hgt, wd = tau.shape
    toward = -d
    # Where each sight line leaves the box.
    with np.errstate(divide="ignore"):
        lim = np.stack([np.where(toward[k] > 0, (b - p[:, k]) / toward[k], np.where(toward[k] < 0, (-b - p[:, k]) / toward[k], np.inf))
                        for k, b in enumerate((R, R, H))], axis=1)
    t_exit = np.maximum(lim.min(axis=1), 0)
    steps = 160
    col = np.zeros(len(p))
    for k in range(steps):
        t = (k + 0.5) / steps * t_exit
        q = p + t[:, None] * toward
        u = np.clip((q[:, 0] / R * 0.5 + 0.5) * wd - 0.5, 0, wd - 1)
        v = np.clip((-q[:, 1] / R * 0.5 + 0.5) * hgt - 0.5, 0, hgt - 1)
        tt = ndimage.map_coordinates(tau, [v, u], order=1)
        c = np.cosh(np.minimum(np.abs(q[:, 2] / zd), 40))
        col += tt / (c * c) / (2 * zd) * t_exit / steps
    return float(np.sum(w * np.exp(-col)) / np.sum(w))


def bulge_points(re: float, sn: float, q0: float) -> tuple[np.ndarray, np.ndarray]:
    """A Prugniel-Simien bulge as weighted points (kpc)."""
    bn = sersic_b(sn)
    p = 1 - 0.6097 / sn + 0.05463 / sn ** 2
    m = np.geomspace(1e-3, 12, 60)
    mu = np.linspace(-1, 1, 21)[:-1] + 1 / 20
    ph = np.linspace(0, 2 * np.pi, 12, endpoint=False)
    M, MU, PH = np.meshgrid(m, mu, ph, indexing="ij")
    w = M ** -p * np.exp(-bn * M ** (1 / sn)) * M ** 3  # rho m^2 dm, dm ~ m on a log grid
    st = np.sqrt(1 - MU ** 2)
    pts = np.stack([M * re * st * np.cos(PH), M * re * st * np.sin(PH), M * re * q0 * MU], axis=-1)
    return pts.reshape(-1, 3), w.ravel()


def disc_points(light: np.ndarray, R: float, z0: float, n: int = 20000) -> tuple[np.ndarray, np.ndarray]:
    """The disc as points drawn from its face-on light, sech^2 in height."""
    rng = np.random.default_rng(1)
    hgt, wd = light.shape
    prob = np.clip(light, 0, None).ravel()
    idx = rng.choice(prob.size, n, p=prob / prob.sum())
    x = ((idx % wd + rng.random(n)) / wd * 2 - 1) * R
    y = -((idx // wd + rng.random(n)) / hgt * 2 - 1) * R
    z = z0 * np.arctanh(np.clip(2 * rng.random(n) - 1, -0.999999, 0.999999))
    return np.stack([x, y, z], axis=1), np.ones(n)


def fit_companion(img: np.ndarray, name: str, geo: dict, job: dict, pix: float, noise: float, saturated: np.ndarray):
    """Fit a companion galaxy in the frame as a Sersic spheroid, on its side away from the
    main galaxy, and subtract it. Returns the image without it and its model entry."""
    n = img.shape[0]
    cx0 = cy0 = n / 2 - 0.5
    x, y = tangent(job["ra"], job["dec"], geo["ra"], geo["dec"])
    cx, cy = cx0 - x * 3600 / pix, cy0 - y * 3600 / pix
    lum = luminance(img)
    r25_px = geo["r25"] * 3600 / pix
    win = int(max(3, 0.1 * r25_px))
    sm = ndimage.gaussian_filter(lum, 1.5)
    sub = sm[int(cy) - win:int(cy) + win + 1, int(cx) - win:int(cx) + win + 1]
    py, px = np.unravel_index(np.argmax(sub), sub.shape)
    cx, cy = int(cx) - win + px, int(cy) - win + py
    pa, q = geo["pa"], max(geo["q"], 0.3)
    major = np.array([-math.sin(pa), -math.cos(pa)])
    minor = np.array([-math.cos(pa), math.sin(pa)])
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    a_ = (xx - cx) * major[0] + (yy - cy) * major[1]
    b_ = (xx - cx) * minor[0] + (yy - cy) * minor[1]
    r_ell = np.hypot(a_, b_ / q)
    # Only the half away from the main galaxy's nucleus (the image centre).
    away = (xx - cx) * (cx0 - cx) + (yy - cy) * (cy0 - cy) < 0
    radii = np.geomspace(0.7, 1.0 * r25_px, 60)
    prof, sat = ellipse_profile(np.where(away, lum, np.nan), np.where(away, r_ell, 1e9), radii,
                                ndimage.binary_dilation(saturated, iterations=2))
    ok = ~sat & np.isfinite(prof) & (prof > 2 * noise)
    _, _, I_b, re_px, sn = fit_profile(radii[ok & (radii < 0.6 * r25_px)], prof[ok & (radii < 0.6 * r25_px)], noise, True,
                                       0.25 * r25_px)
    centre = np.hypot(xx - cx, yy - cy) < max(2.0, 0.3 * re_px)
    colour = img[centre].mean(axis=0)
    colour = colour / max(luminance(colour), 1e-12)
    # Cut it out (its outskirts and tidal light stay with the partner) and fill the hole
    # from around: the partner's light continues underneath.
    from fetch_images import blur as _blur
    rest = img.copy()
    known = np.hypot(xx - cx, yy - cy) > 0.4 * r25_px
    for sigma in (2, 6, 18, 54, 162):
        wgt = _blur(known.astype(float), sigma)
        todo = ~known & (wgt > 0.05)
        for c in range(3):
            v = _blur(rest[..., c] * known, sigma) / np.maximum(wgt, 1e-6)
            rest[..., c][todo] = v[todo]
        known |= todo
    kpc_per_px = geo["dist"] * 1e3 * math.radians(pix / 3600)
    east, north = -(cx - cx0) * pix / 3600, -(cy - cy0) * pix / 3600
    dec = job["dec"] + north
    ra = job["ra"] + east / math.cos(math.radians(dec))
    print(f"  {name}: Sersic n={sn:.1f} re={re_px * kpc_per_px:.2f} kpc, subtracted", flush=True)
    R = max(6 * re_px, r25_px) * kpc_per_px
    entry = {"name": name, "kind": "spheroid", "ra": round(ra, 6), "dec": round(dec, 6), "pa": round(math.degrees(pa), 2),
             "q": round(q, 4), "R": round(R, 4), "H": round(R * q, 4), "total": 1.0,
             "bulge": {"L": 1.0, "re": float(re_px * kpc_per_px), "n": sn, "q0": q, "colour": [round(float(v), 4) for v in colour]}}
    entry, _ = finish(entry, {"sky": lum}, kpc_per_px, n)
    return rest, entry


def finish(entry, fixture, kpc_per_px, n, face=None, tau=None, out_dir=None, s=None, thin_frac=None):
    """Write the maps; light in units of the image's total."""
    total = entry.pop("total")
    b = entry["bulge"]
    sn, re, q0 = b["n"], b["re"], b["q0"]
    # Prugniel and Simien (1997): the 3D profile whose projection is the Sersic profile.
    p = 1 - 0.6097 / sn + 0.05463 / sn ** 2
    bn = sersic_b(sn)
    b["p"], b["b"] = round(p, 5), round(bn, 5)
    b["rho0"] = b["L"] / (4 * math.pi * q0 * re ** 3 * sn * bn ** (-sn * (3 - p)) * special.gamma(sn * (3 - p)))
    if face is not None:
        face = face / total
        peak = float(np.percentile(face.max(axis=2), 99.99)) or 1.0
        Image.fromarray(np.round(np.sqrt(np.clip(face / peak, 0, 1)) * 255).astype(np.uint8)).save(
            os.path.join(out_dir, f"{s}.jpg"), quality=92)
        stored = (np.asarray(Image.open(os.path.join(out_dir, f"{s}.jpg")), float) / 255) ** 2 * peak
        entry["file"], entry["light"] = f"{s}.jpg", peak
        entry["size"] = [face.shape[1], face.shape[0]]
        cell = (2 * entry["R"] / face.shape[1]) * (2 * entry["R"] / face.shape[0])
        entry["discL"] = float(luminance(stored).sum() * cell)
        # Star-forming knots and arms' fine structure lie in the thin layer with the dust; the
        # smooth light of older stars in the thick one. Their split: the light above its
        # surroundings (0.4 kpc across).
        lum_f = luminance(stored)
        px = 2 * entry["R"] / face.shape[1]
        young = np.clip(1 - blur(lum_f, max(1.0, 0.4 / px)) / np.maximum(lum_f, 1e-30), 0, 1)
        young[lum_f <= 0] = 0
        if thin_frac is not None:
            # Edge-on: the thin disc's share, measured across the plane.
            young[:] = thin_frac
        fixture["young"] = young
        tmax = float(max(tau.max(), 1e-3))
        shrink = (lambda a: a) if tau.shape[1] <= 2048 else (lambda a: ndimage.zoom(a, 2048 / tau.shape[1], order=1))
        rgb = np.stack([np.sqrt(np.clip(shrink(tau) / tmax, 0, 1)), np.clip(shrink(young), 0, 1),
                        np.zeros_like(shrink(tau))], axis=-1)
        # Full chroma resolution: the channels are separate maps.
        Image.fromarray(np.round(rgb * 255).astype(np.uint8)).save(os.path.join(out_dir, f"{s}-dust.jpg"), quality=90,
                                                                    subsampling=0)
        entry["dust"], entry["tauMax"] = f"{s}-dust.jpg", tmax
        fixture["face"] = fixture["face"] / total
    fixture["sky"] = fixture["sky"] / total / kpc_per_px ** 2
    fixture["kpcPerPx"] = kpc_per_px
    for key in ("rho0", "L"):
        b[key] = float(f"{b[key]:.6g}")
    b["re"] = round(re, 5)
    return entry, fixture


def downsample(a: np.ndarray, size: int) -> list:
    f = max(1, a.shape[1] // size)
    h, w = a.shape[0] // f * f, a.shape[1] // f * f
    return np.round(a[:h, :w].reshape(h // f, f, w // f, f).mean(axis=(1, 3)), 9).tolist()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("data")
    parser.add_argument("out")
    parser.add_argument("--only", help="comma-separated names")
    args = parser.parse_args()
    cache = os.path.join(args.data, "models")
    os.makedirs(cache, exist_ok=True)
    out_dir = os.path.join(args.out, "galaxies", "models")
    os.makedirs(out_dir, exist_ok=True)
    index = json.load(open(os.path.join(args.out, "galaxies", "index.json")))
    blob = open(os.path.join(args.out, "galaxies", "local.bin"), "rb").read()
    n = index["local"]
    pos = np.frombuffer(blob, "<f4", n * 3).reshape(-1, 3).astype(float)
    code = lambda k: np.frombuffer(blob, np.uint8, n, 12 * n + k * n)
    radius_code, axis_code, angle_code, flags = code(1), code(2), code(3), code(6)
    d = np.linalg.norm(pos, axis=1)
    h = 0.05 * 10 ** (radius_code / 60)  # kpc
    spheroid = (flags & 16) != 0
    r25 = h * np.where(spheroid, 3.0, 3.2)
    gal = {"ra": np.degrees(np.arctan2(pos[:, 1], pos[:, 0])) % 360, "dec": np.degrees(np.arcsin(pos[:, 2] / np.maximum(d, 1e-12))),
           "r25": np.degrees(r25 * 1e-3 / np.maximum(d, 1e-9))}
    named = {g["name"]: g for g in index["named"]}
    path = os.path.join(out_dir, "..", "models.json")
    entries = {e["name"]: e for e in json.load(open(path))["models"]} if os.path.exists(path) else {}
    fx_path = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "galaxy-models-reference.json")
    fixtures = json.load(open(fx_path)) if os.path.exists(fx_path) else {}
    only = set(args.only.split(",")) if args.only else None
    bright = app_stars(args.out)
    for name, width in GALAXIES.items():
        g = named.get(name)
        if g is None or (only and name not in only):
            continue
        i = g["i"]
        fov = float(min(16, max(0.05, 2.4 * gal["r25"][i])))
        w = WIDTH.get(name, 2048 if name in SHOWCASE or width >= 768 else min(2 * width, 1536))
        ra, dec = CENTRES.get(name, (float(gal["ra"][i]), float(gal["dec"][i])))
        job = dict(name=name, ra=ra, dec=dec, fov=fov, width=w, index=i)
        geo = {"pa": angle_code[i] * math.pi / 256, "q": axis_code[i] / 255, "spheroid": bool(spheroid[i]),
               "dist": float(d[i]), "h": float(h[i]), "r25": float(gal["r25"][i])}
        companions = []
        for c in COMPANIONS.get(name, []):
            k = named[c]["i"]
            job.setdefault("skip", []).append(k)
            companions.append((c, {"pa": angle_code[k] * math.pi / 256, "q": axis_code[k] / 255, "ra": float(gal["ra"][k]),
                                   "dec": float(gal["dec"][k]), "r25": float(gal["r25"][k]), "dist": float(d[i])}))
        try:
            entry, fixture, extra = process(job, geo, cache, out_dir, bright, gal, companions)
        except OSError as err:
            print(f"  failed: {err}", flush=True)
            continue
        entries[name] = entry
        for e in extra:
            entries[e["name"]] = e
        if name in FIXTURE:
            f = fixture["sky"].shape[1] // 64
            fixtures[name] = {"sky": downsample(fixture["sky"], 64), "kpcPerPx": fixture["kpcPerPx"] * f,
                              "centre": [round(float(c) / f, 3) for c in fixture["centre"]]}
            if "face" in fixture:
                fixtures[name]["face"] = downsample(fixture["face"], 64)
                fixtures[name]["tau"] = downsample(fixture["tau"], 64)
                fixtures[name]["young"] = downsample(fixture["young"] * fixture["face"], 64)
        with open(path, "w") as f:
            json.dump({"source": "SDSS DR9 g, r, i, DSS2 colour and Pan-STARRS DR1 g, r via CDS hips2fits; foreground stars removed with Gaia DR3",
                       "models": list(entries.values())}, f, indent=1)
        with open(fx_path, "w") as f:
            json.dump(fixtures, f, separators=(",", ":"))


if __name__ == "__main__":
    main()
