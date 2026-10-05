"""Global surface and cloud maps for the planets and moons.

Usage:
    python pipeline/build_maps.py DATA_DIR public/data/maps src/generated/maps.json [--only io,europa]

Every map is written as an equirectangular JPEG in planetocentric latitude and east
longitude, -180 at the left edge, north up. `maps.json` records each map's source,
what it shows and its mean linear value, so the renderer can scale it to the body's
measured geometric albedo (the maps themselves are relative brightness).

Sources
  USGS Astrogeology global mosaics (public domain), read over HTTP range requests:
    only the image rows needed for the output size are fetched.
      Mercury  MESSENGER MDIS 250 m mosaic (monochrome, tinted to Mercury's colour)
      Mars     Viking colour mosaic, 925 m
      Io       Galileo SSI / Voyager colour merge, 1 km
      Europa   Voyager / Galileo SSI, 500 m (monochrome)
      Ganymede Voyager / Galileo SSI colour, 1.4 km
      Callisto Voyager / Galileo SSI, 1 km (monochrome)
      Enceladus, Tethys, Dione, Rhea, Iapetus  Cassini ISS / Voyager
      Triton   Voyager 2 colour, gaps filled
      Pluto, Charon  New Horizons LORRI, 300 m (monochrome)
      Phobos   Mars Express SRC
  Hubble OPAL (Outer Planet Atmospheres Legacy), 2025 global maps:
      Jupiter and Saturn in 395/502/631 nm colour; Uranus and Neptune as latitude
      profiles (their visible-light features are faint), coloured to the true-colour
      reconstruction of Irwin et al. (2024).
"""

import argparse
import concurrent.futures as cf
import http.client
import json
import os
import re
import urllib.request

import numpy as np
import tifffile
from PIL import Image

from http_file import HttpFile

Image.MAX_IMAGE_PIXELS = None
USGS = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/"
OPAL = "https://archive.stsci.edu/missions/hlsp/opal/"

# name, source file, output width, tint (sRGB, for monochrome maps), credit
USGS_MAPS = [
    ("mercury", "Mercury_MESSENGER_mosaic_global_250m_2013", 4096, "#a19a92", "NASA/JHUAPL/CIW MESSENGER MDIS, USGS mosaic"),
    ("mars", "Mars_Viking_ClrMosaic_global_925m", 4096, "#c1673f", "NASA Viking Orbiter mosaic, USGS"),
    ("io", "Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km", 4096, None, "NASA Galileo SSI and Voyager, USGS"),
    ("europa", "Europa_Voyager_GalileoSSI_global_mosaic_500m", 4096, "#d9cdb4", "NASA Voyager and Galileo SSI, USGS"),
    ("ganymede", "Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m", 4096, None, "NASA Voyager and Galileo SSI colour, USGS"),
    ("callisto", "Callisto_Voyager_GalileoSSI_global_mosaic_1km", 4096, "#8f8270", "NASA Voyager and Galileo SSI, USGS"),
    ("enceladus", "Enceladus_Cassini_mosaic_global_110m", 2048, "#f2f2ef", "NASA/JPL Cassini ISS, USGS"),
    ("tethys", "Tethys_Cassini_mosaic_global_293m", 2048, "#e6e2db", "NASA/JPL Cassini ISS, USGS"),
    ("dione", "Dione_Cassini_Voyager_mosaic_global_154m", 2048, "#dcd8d0", "NASA/JPL Cassini ISS and Voyager, USGS"),
    ("rhea", "Rhea_Cassini_Voyager_mosaic_global_417m", 2048, "#d9d4ca", "NASA/JPL Cassini ISS and Voyager, USGS"),
    ("iapetus", "Iapetus_Cassini_Voyager_mosaic_global_783m", 2048, "#d6c9b0", "NASA/JPL Cassini ISS and Voyager, USGS"),
    ("triton", "Triton_Voyager2_ClrMosaic_GlobalFill_600m", 2048, None, "NASA Voyager 2 colour mosaic, USGS"),
    ("pluto", "Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit", 4096, "#d2b394", "NASA/JHUAPL/SwRI New Horizons LORRI, USGS"),
    ("charon", "Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit", 2048, "#b1a79e", "NASA/JHUAPL/SwRI New Horizons LORRI, USGS"),
    ("phobos", "Phobos_ME_SRC_Mosaic_Global_16ppd", 2048, "#6e655c", "ESA/DLR/FU Berlin Mars Express SRC, USGS"),
    ("ceres", "Ceres_Dawn_FC_DLR_global_20ppd_Oct2015", 2048, "#8c8780", "NASA/JPL Dawn FC, DLR, USGS"),
    ("vesta", "Vesta_Dawn_FC_HAMO_Mosaic_Global_74ppd", 2048, "#a8a39b", "NASA/JPL Dawn FC, USGS"),
]

# Maps whose left and right edges do not match in brightness.
SEAMED = {"phobos"}

OPAL_MAPS = [
    # name, path, (equatorial, polar radius) used for the planetographic grid, channel order
    ("jupiter", "cycle32/jupiter/hlsp_opal_hst_wfc3-uvis_jupiter-2025a_f395n-f502n-f631n_v1_globalmap.tif", (71492, 66854), "rgb"),
    ("saturn", "cycle32/saturn/hlsp_opal_hst_wfc3-uvis_saturn-2025a_f395n-f502n-f631n_v1_globalmap.tif", (60268, 54364), "rgb"),
]
OPAL_PROFILES = [
    # name, path, radii, true colour (Irwin et al. 2024, sRGB)
    ("uranus", "cycle33/uranus/hlsp_opal_hst_wfc3-uvis_uranus-2025a_f547m_v1_globalmap.fits", (25559, 24973), "#b3d6dc"),
    ("neptune", "cycle32/neptune/hlsp_opal_hst_wfc3-uvis_neptune-2025b_f547m_v1_globalmap.fits", (24764, 24341), "#a6c5da"),
]


def srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055) * 255.0


def hex_rgb(h):
    return [int(h[i:i + 2], 16) for i in (1, 3, 5)]


def label(name):
    with urllib.request.urlopen(USGS + name + ".lbl", timeout=120) as r:
        text = r.read().decode("latin-1")
    direction = re.search(r"LongitudeDirection\s*=\s*(\w+)", text).group(1)
    clon = float(re.search(r"CenterLongitude\s*=\s*([-\d.]+)", text).group(1))
    return direction, clon


def read_rows(url, offsets, nbytes):
    """Fetch byte ranges in parallel; returns a list of bytes."""

    def get(off):
        req = urllib.request.Request(url, headers={"Range": f"bytes={off}-{off + nbytes - 1}"})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    return r.read()
            except (OSError, http.client.HTTPException):
                if attempt == 4:
                    raise

    with cf.ThreadPoolExecutor(24) as pool:
        return list(pool.map(get, offsets))


def usgs_map(cache, name, width):
    """Downsampled (H, W, bands) float image in east longitude starting at -180."""
    path = os.path.join(cache, name + f"_{width}.npy")
    if os.path.exists(path):
        return np.load(path)
    url = USGS + name + ".tif"
    tif = tifffile.TiffFile(HttpFile(url))
    page = tif.pages[0]
    if page.compression != 1 or page.is_tiled:
        raise ValueError(f"{name}: expected an uncompressed striped TIFF")
    bands = page.samplesperpixel
    h, w = page.imagelength, page.imagewidth
    rows_per_strip = page.rowsperstrip
    x0, y0 = page.tags[33922].value[3:5]
    scale = page.tags[33550].value[0]
    radius = w * scale / (2 * np.pi)
    direction, clon = label(name)
    # Both conventions put east to the right of the image; they differ in the
    # longitude the left edge is labelled with.
    left = np.degrees(x0 / radius) + clon if direction == "PositiveEast" else np.degrees(x0 / radius) - clon
    top = np.degrees(y0 / radius)
    assert abs(top - 90) < 0.5, f"{name}: map does not start at the north pole ({top})"

    out_h = width // 2
    # Two source rows per output row (out of 5 to 20), averaged.
    src_rows = np.clip(((np.arange(out_h)[:, None] + np.array([0.3, 0.7])) / out_h * h).astype(int), 0, h - 1)
    offsets, keys = [], []
    for b in range(bands):
        for r in src_rows.ravel():
            strip = b * ((h + rows_per_strip - 1) // rows_per_strip) + r // rows_per_strip if page.planarconfig == 2 else r // rows_per_strip
            row_bytes = w * (1 if page.planarconfig == 2 else bands)
            offsets.append(page.dataoffsets[strip] + (r % rows_per_strip) * row_bytes)
            keys.append((b, r))
    row_bytes = w * (1 if page.planarconfig == 2 else bands)
    print(f"{name}: {w}x{h}x{bands}, fetching {len(offsets)} rows ({len(offsets) * row_bytes / 1e6:.0f} MB)")
    data = read_rows(url, offsets, row_bytes)
    rows = {k: np.frombuffer(d, dtype=np.uint8) for k, d in zip(keys, data)}
    img = np.zeros((out_h, w, bands), dtype=np.float32)
    for b in range(bands):
        for j in range(out_h):
            acc = 0
            for r in src_rows[j]:
                row = rows[(b, r)]
                acc = acc + (row if page.planarconfig == 2 else row[b::bands]).astype(np.float32)
            img[j, :, b] = acc / len(src_rows[j])
    # Horizontal box filter down to the output width.
    f = w / width
    edges = (np.arange(width + 1) * f).astype(int)
    csum = np.concatenate([np.zeros((out_h, 1, bands), np.float32), np.cumsum(img, axis=1)], axis=1)
    small = (csum[:, edges[1:]] - csum[:, edges[:-1]]) / np.maximum(1, edges[1:] - edges[:-1])[None, :, None]
    # Roll so the left edge is -180 east.
    shift = int(round((left + 180) / 360 * width)) % width
    small = np.roll(small, shift, axis=1)
    np.save(path, small)
    return small


def fill_gaps(img, valid, min_cover=0.05):
    """Fill invalid pixels with the mean of valid pixels on the same row. Rows with less
    than `min_cover` valid (polar caps never seen, Saturn's ring shadow) are replaced by
    interpolating between the means of the nearest well-covered rows above and below."""
    out = img.copy()
    good = [j for j in range(img.shape[0]) if valid[j].sum() > img.shape[1] * min_cover]
    if not good:
        return out
    means = np.array([img[j, valid[j]].mean(axis=0) for j in good])
    for j in good:
        out[j, ~valid[j]] = img[j, valid[j]].mean(axis=0)
    rows = np.arange(img.shape[0])
    bad = np.setdiff1d(rows, good)
    for c in range(img.shape[2]):
        out[bad, :, c] = np.interp(bad, good, means[:, c])[:, None]
    return out


def blend_seam(img, columns):
    """Mend mosaics whose left and right edges do not meet (Phobos's is lit differently
    on either side of 180 degrees, and its last columns are partly empty). Empty columns at
    either edge are redrawn by interpolating across the edge, then each row's remaining
    step is cross-faded over `columns` on both sides."""
    out = img.copy()
    w = img.shape[1]
    # Columns partly outside the mosaic (box-filtered against its empty border).
    dim = (img.max(axis=2) <= 0.5).mean(axis=0) > 0.02
    dim |= img.mean(axis=(0, 2)) < 0.5 * np.median(img.mean(axis=(0, 2)))
    lo = 0
    while lo < w // 64 and dim[lo]:
        lo += 1
    hi = w
    while hi > w - w // 64 and dim[hi - 1]:
        hi -= 1
    gap = (w - hi) + lo
    if gap:
        a, b = img[:, hi - 1], img[:, lo]
        for k in range(gap):
            t = (k + 1) / (gap + 1)
            out[:, (hi + k) % w] = a * (1 - t) + b * t
    step = out[:, :4].mean(axis=1) - out[:, -4:].mean(axis=1)
    for k in range(columns):
        f = 0.5 * (1 - k / columns)
        out[:, k] -= f * step
        out[:, -1 - k] += f * step
    return out


def planetographic_to_centric(img, radii, lat_top=90.0, lat_bottom=-90.0):
    """Resample rows from planetographic latitude to planetocentric (-90..90)."""
    a, b = radii
    h = img.shape[0]
    centric = np.linspace(90, -90, h, endpoint=False) - 90 / h
    graphic = np.degrees(np.arctan(np.tan(np.radians(centric)) * (a / b) ** 2))
    src = (lat_top - graphic) / (lat_top - lat_bottom) * img.shape[0] - 0.5
    i0 = np.clip(np.floor(src).astype(int), 0, img.shape[0] - 1)
    i1 = np.clip(i0 + 1, 0, img.shape[0] - 1)
    t = np.clip(src - i0, 0, 1)[:, None, None]
    return img[i0] * (1 - t) + img[i1] * t


def save(img_srgb, out_dir, name):
    path = os.path.join(out_dir, f"{name}.jpg")
    Image.fromarray(np.clip(img_srgb + 0.5, 0, 255).astype(np.uint8)).save(path, quality=88, optimize=True)
    stored = srgb_to_linear(np.asarray(Image.open(path).convert("RGB")))
    return path, [round(float(v), 5) for v in stored.reshape(-1, 3).mean(axis=0)]


def build_usgs(cache, out_dir, name, src, width, tint, credit):
    img = usgs_map(cache, src, width)
    if name in SEAMED:
        img = blend_seam(img, width // 32)
    valid = img.max(axis=2) > 0.5
    img = fill_gaps(img, valid)
    if img.shape[2] == 1 or tint:
        # Monochrome maps, and colour maps whose colours are not true colour (Viking's
        # violet and red filters make Mars's dark areas blue): brightness, tinted.
        grey = img[..., 0] if img.shape[2] == 1 else img[..., :3] @ np.array([0.2126, 0.7152, 0.0722])
        lin = srgb_to_linear(grey)  # treat stored DN as display-encoded brightness
        lin = lin / lin[valid].mean() * 0.25
        rgb = linear_to_srgb(lin[..., None] * srgb_to_linear(hex_rgb(tint)) / srgb_to_linear(hex_rgb(tint)).max())
    else:
        rgb = img[..., :3]
    _, mean = save(rgb, out_dir, name)
    return {"source": credit, "kind": "surface", "coverage": round(float(valid.mean()), 3), "mean": mean}


def build_opal(cache, out_dir, name, path, radii):
    local = os.path.join(cache, os.path.basename(path))
    if not os.path.exists(local):
        urllib.request.urlretrieve(OPAL + path, local)
    img = tifffile.imread(local).astype(np.float32)
    if img.shape[0] == 3:
        img = np.moveaxis(img, 0, -1)
    # Valid: well above the row's typical brightness floor. Rejects unobserved pixels and
    # the smeared, dark fringes at the poles and along Saturn's ring shadow.
    bright = img.max(axis=2)
    row_median = np.array([np.median(r[r > 8]) if (r > 8).any() else np.inf for r in bright])
    valid = (bright > 0.6 * row_median[:, None]) & (bright > 0.4 * np.median(bright[bright > 8]))
    # OPAL's left edge is 0 System III west longitude, decreasing to the right, i.e. east
    # longitude increasing from 0; roll so the left edge is -180 east.
    w = img.shape[1]
    img = np.roll(fill_gaps(img, valid, min_cover=0.95), w // 2, axis=1)
    img = planetographic_to_centric(img, radii)
    _, mean = save(img, out_dir, name)
    return {"source": "NASA/ESA Hubble OPAL 2025 (PI A. Simon), 395/502/631 nm", "kind": "clouds", "coverage": round(float(valid.mean()), 3), "mean": mean}


def build_profile(cache, out_dir, name, path, radii, colour):
    local = os.path.join(cache, os.path.basename(path))
    if not os.path.exists(local):
        urllib.request.urlretrieve(OPAL + path, local)
    from astropy.io import fits  # noqa: PLC0415

    data = np.nan_to_num(fits.getdata(local).astype(np.float64))
    if data.ndim == 3:
        data = data[0]
    valid = data > np.percentile(data[data > 0], 5) * 0.5
    profile = np.array([data[j][valid[j]].mean() if valid[j].sum() > data.shape[1] * 0.2 else np.nan for j in range(data.shape[0])])
    good = np.where(~np.isnan(profile))[0]
    profile = np.interp(np.arange(len(profile)), good, profile[good])  # hold the edge values
    profile /= profile[good].mean()
    h = 1024
    rows = np.interp(np.linspace(0, len(profile) - 1, h), np.arange(len(profile)), profile)
    lin = np.clip(rows[:, None, None] * srgb_to_linear(hex_rgb(colour))[None, None, :], 0, 1)
    img = np.repeat(lin, 2 * h, axis=1)
    img = planetographic_to_centric(linear_to_srgb(img), radii)
    _, mean = save(img, out_dir, name)
    return {"source": "NASA/ESA Hubble OPAL 2025 latitude profile (547 nm), true colour from Irwin et al. 2024", "kind": "clouds", "coverage": round(float(valid.mean()), 3), "mean": mean}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    parser.add_argument("out_dir")
    parser.add_argument("manifest")
    parser.add_argument("--only")
    args = parser.parse_args()
    only = set(args.only.split(",")) if args.only else None
    cache = os.path.join(args.data, "maps")
    os.makedirs(cache, exist_ok=True)
    os.makedirs(args.out_dir, exist_ok=True)
    manifest = json.load(open(args.manifest)) if os.path.exists(args.manifest) else {}

    for name, src, width, tint, credit in USGS_MAPS:
        if only and name not in only:
            continue
        manifest[name] = build_usgs(cache, args.out_dir, name, src, width, tint, credit)
        print(name, manifest[name])
    for name, path, radii, _ in OPAL_MAPS:
        if only and name not in only:
            continue
        manifest[name] = build_opal(cache, args.out_dir, name, path, radii)
        print(name, manifest[name])
    for name, path, radii, colour in OPAL_PROFILES:
        if only and name not in only:
            continue
        manifest[name] = build_profile(cache, args.out_dir, name, path, radii, colour)
        print(name, manifest[name])
    with open(args.manifest, "w") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
