"""Build the Mars tiles and the two landing-site showcases from what fetch_surfaces.py
downloads, in the tiling scheme of build_tiles.py (same packs, same manifest).

Usage (from the repository root):
    python pipeline/build_surfaces.py DATA_DIR public/data/tiles src/generated/tiles.json

Mars
    Heights: MOLA planetary radius less 3396 km (MOLA's reference sphere), levels 0-5,
    in 1 m steps (Mars spans -23 to +21 km about that sphere, beyond int16 at 0.5 m).
    Colour: the Viking MDIM 2.1 mosaic, levels 0-4. Viking's violet and red filters
    turn the dark basaltic regions blue, so only two things are kept from it: brightness,
    and how red a place is against its surroundings (the red/green ratio), which
    separates bright dust from dark rock. Colour is then a blend of a dust colour and a
    basalt colour by that ratio. The mosaic's brightness is stretched for display (its
    darkest and brightest 5% differ ninefold, where Mars's albedo spans 0.12 to 0.3), so
    it is compressed by a power of 0.4 and scaled to a mean normal albedo of 0.22.
    Tiles store twice the albedo.

Landing sites
    Each site has a wide layer and a small core layer with deeper levels. Heights come
    from the site's DTM; colour is pan-sharpened: the global map's colour at its own
    scale, times the high-resolution image's detail (the image divided by itself
    smoothed to that scale). So the site keeps the global colour and brightness and
    gains the image's texture, shadows of boulders included. Near the edge of each
    layer's tiles the site data fades into the coarser data underneath.

    Tranquility Base: LRO NAC DTM (2 m posts) and 0.5 m orthophoto, on the global LROC
    and LOLA tiles already built (decoded from their packs).
    Jezero crater: the Mars 2020 CTX DTM (20 m) and 6 m orthomosaic for the crater, and
    the HiRISE 1 m DTM and 25 cm orthomosaic around Perseverance's landing site; their
    heights are above the MOLA areoid, so the areoid (MOLA radius less topography) is
    added back.
"""

import argparse
import io
import json
import math
import os
import struct
import sys
import zlib

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from build_tiles import (  # noqa: E402
    GRID, IMAGE, JPEG_QUALITY, PackWriter, Pyramid, Raster, box_reduce, chunk_key, encode_jpeg,
    grid_points, pixel_centres, tile_bounds, tile_size, tiles_in_box,
)

Image.MAX_IMAGE_PIXELS = None
MARS_R = 3396.0  # km, reference sphere for heights

APOLLO11 = {"site": (0.67416, 23.47314), "body": 301, "R": 1737.4,
            "wide": {"half": 0.05, "levels": [6, 15]}, "core": {"half": 0.012, "levels": [16, 16]}}
JEZERO = {"site": (18.4447, 77.4508), "body": 499, "R": MARS_R,
          "crater": {"bbox": [77.12, 18.02, 77.96, 18.80], "levels": [6, 11]},
          "wide": {"half": 0.03, "levels": [12, 15]}, "core": {"half": 0.0045, "levels": [16, 17]}}


def srgb_to_linear(v):
    v = np.asarray(v, dtype=np.float32) / 255.0
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(v):
    v = np.clip(v, 0, 1)
    return 255.0 * np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055)


def hex_linear(h):
    return srgb_to_linear([int(h[i:i + 2], 16) for i in (1, 3, 5)])


def encode_heights(metres, unit, offset):
    q = np.clip(np.round((metres - offset) / unit), -32768, 32767).astype(np.int32) & ~1
    return zlib.compress(q.astype("<i2").tobytes(), 9)


def height_scale(lo, hi):
    """Step and offset that fit [lo, hi] metres into int16 (even steps only)."""
    offset = round((lo + hi) / 2)
    unit = max(0.05, (hi - lo) / 60000)
    return round(unit, 3), offset


class OnePack(PackWriter):
    """All of a small layer's tiles in one pack (chunk roots [0]), so a site is one file."""

    def add(self, level, x, y, blob):
        self.chunks.setdefault(f"0-{x >> level}-{y >> level}", []).append((level, x, y, blob))


def write_layer(out_dir, layer, tiles, make, one_pack=False):
    writer = (OnePack if one_pack else PackWriter)(os.path.join(out_dir, layer["id"]))
    if one_pack:
        layer["chunkRoots"] = [0]
    for level, x, y in tiles:
        writer.add(level, x, y, make(level, x, y))
    layer["chunks"] = writer.write()
    size = sum(os.path.getsize(os.path.join(out_dir, layer["id"], f"{k}.bin")) for k in layer["chunks"])
    print(f"{layer['id']}: {len(tiles)} tiles in {len(layer['chunks'])} chunks, {size / 1e6:.1f} MB")
    return layer


# ---- projected rasters with a box-filtered pyramid --------------------------------

class Projected:
    """A raster in a projection (x, y metres from lon/lat), pixel-is-area, with nodata,
    and box-filtered versions so it can be sampled smoothed to any scale."""

    def __init__(self, data, transform, project, valid=None):
        self.levels = []
        a, b, c, d, e, f = transform
        valid = np.isfinite(data) if valid is None else valid
        data = np.where(valid, data, 0).astype(np.float32)
        w = valid.astype(np.float32)
        step = 1
        while True:
            self.levels.append((data, w, (a * step, c, e * step, f)))
            if min(data.shape[:2]) < 64:
                break
            data, w = box_reduce(data * w[..., None] if data.ndim == 3 else data * w, 2), box_reduce(w, 2)
            data = np.where(w[..., None] > 0, data / np.maximum(w[..., None], 1e-6), 0) if data.ndim == 3 else np.where(w > 0, data / np.maximum(w, 1e-6), 0)
            step *= 2
        self.project = project
        self.pixel = abs(a)

    def sample(self, lons, lats, scale=0.0):
        """Value and valid fraction at lon/lat (degrees), smoothed to about `scale` metres."""
        k = 0
        while k + 1 < len(self.levels) and self.levels[k + 1][2][0] <= scale:
            k += 1
        data, w, (px, c, py, f) = self.levels[k]
        x, y = self.project(lons, lats)
        fx = (x - c) / px - 0.5
        fy = (y - f) / py - 0.5
        h, wd = data.shape[:2]
        x0 = np.floor(fx).astype(np.int64)
        y0 = np.floor(fy).astype(np.int64)
        tx, ty = fx - x0, fy - y0
        inside = (x0 >= 0) & (x0 < wd - 1) & (y0 >= 0) & (y0 < h - 1)
        xa, ya = np.clip(x0, 0, wd - 2), np.clip(y0, 0, h - 2)

        def bil(arr):
            t, u = (tx[..., None], ty[..., None]) if arr.ndim == 3 else (tx, ty)
            top = arr[ya, xa] * (1 - t) + arr[ya, xa + 1] * t
            bottom = arr[ya + 1, xa] * (1 - t) + arr[ya + 1, xa + 1] * t
            return top * (1 - u) + bottom * u

        weight = np.where(inside, bil(w), 0)
        value = bil(data * (w[..., None] if data.ndim == 3 else w))
        value = value / np.maximum(weight[..., None] if data.ndim == 3 else weight, 1e-6)
        return value, weight


def eqc(radius_m, lat_ts=0.0, lon0=0.0):
    k = math.cos(math.radians(lat_ts))

    def project(lons, lats):
        dl = (np.asarray(lons) - lon0 + 180) % 360 - 180
        return radius_m * k * np.radians(dl), radius_m * np.radians(lats)
    return project


def read_window(path, bbox, project, margin_m):
    """Read the part of a GeoTIFF/PDS raster covering bbox (degrees) plus a margin."""
    import rasterio
    from rasterio.windows import Window
    w, s, e, n = bbox
    xs, ys = project(np.array([w, e, w, e]), np.array([s, s, n, n]))
    with rasterio.open(path) as d:
        inv = ~d.transform
        cols, rows = zip(*[inv * (x, y) for x, y in zip(xs, ys)])
        pad = margin_m / abs(d.transform.a)
        c0, c1 = int(max(0, min(cols) - pad)), int(min(d.width, max(cols) + pad))
        r0, r1 = int(max(0, min(rows) - pad)), int(min(d.height, max(rows) + pad))
        win = Window(c0, r0, c1 - c0, r1 - r0)
        data = d.read(1, window=win).astype(np.float32)
        t = d.window_transform(win)
        valid = data != d.nodata if d.nodata is not None else np.ones(data.shape, bool)
        valid &= data > -1e30
    return data, (t.a, t.b, t.c, t.d, t.e, t.f), valid


# ---- reading tiles already built (for a site's base layer) -------------------------

def read_pack_tiles(out_dir, layer_id, level, bbox):
    tiles = {}
    for x, y in tiles_in_box(level, bbox):
        key = chunk_key(level, x, y) if layer_id.startswith(("moon", "earth", "mars")) else f"0-{x >> level}-{y >> level}"
        path = os.path.join(out_dir, layer_id, f"{key}.bin")
        blob = open(path, "rb").read()
        count = struct.unpack_from("<I", blob, 8)[0]
        for i in range(count):
            lv, _, _, tx, ty, off, ln = struct.unpack_from("<BBHIIII", blob, 16 + 20 * i)
            if (lv, tx, ty) == (level, x, y):
                tiles[(x, y)] = blob[off:off + ln]
    return tiles


def mosaic_from_tiles(out_dir, layer_id, level, bbox, kind, unit=0.5):
    """A lon/lat Raster assembled from a built layer's tiles at `level` over bbox."""
    tiles = read_pack_tiles(out_dir, layer_id, level, bbox)
    xs, ys = [k[0] for k in tiles], [k[1] for k in tiles]
    x0, y0 = min(xs), min(ys)
    nx, ny = max(xs) - x0 + 1, max(ys) - y0 + 1
    size = tile_size(level)
    west, _, _, north = tile_bounds(level, x0, y0)
    if kind == "colour":
        img = np.zeros((ny * IMAGE, nx * IMAGE, 3), np.float32)
        for (x, y), blob in tiles.items():
            img[(y - y0) * IMAGE:(y - y0 + 1) * IMAGE, (x - x0) * IMAGE:(x - x0 + 1) * IMAGE] = np.asarray(Image.open(io.BytesIO(blob)).convert("RGB"))
        step = size / IMAGE
        return Raster(img, west + step / 2, north - step / 2, step, wrap=False)
    g = GRID - 1
    h = np.zeros((ny * g + 1, nx * g + 1), np.float32)
    for (x, y), blob in tiles.items():
        q = np.frombuffer(zlib.decompress(blob), "<i2").reshape(GRID, GRID).astype(np.int32) & ~1
        h[(y - y0) * g:(y - y0) * g + GRID, (x - x0) * g:(x - x0) * g + GRID] = q * unit
    step = size / g
    return Raster(h, west, north, step, wrap=False)


# ---- Mars, global ------------------------------------------------------------------

DUST = "#c1673f"     # the planet's colour seen from afar (bodies.ts)
BASALT = "#5f5248"   # dark basaltic sand and rock: grey-brown
ALBEDO_POWER = 0.4


def mars_true_colour(rgb_srgb, stats=None):
    """Viking DN (display-encoded) to linear albedo x 2, as described above."""
    lin = srgb_to_linear(rgb_srgb)
    lum = lin @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    redness = np.log(np.maximum(lin[..., 0], 1e-4) / np.maximum(lin[..., 1], 1e-4))
    if stats is None:
        ok = lum > 0.01
        mean = float(lum[ok].mean())
        stats = {"lum": mean, "red": [float(v) for v in np.percentile(redness[ok], [10, 90])],
                 "norm": float(((lum[ok] / mean) ** ALBEDO_POWER).mean())}
    t = np.clip((redness - stats["red"][0]) / (stats["red"][1] - stats["red"][0]), 0, 1)
    dust, basalt = hex_linear(DUST), hex_linear(BASALT)
    lum_of = lambda c: float(c @ np.array([0.2126, 0.7152, 0.0722]))
    chroma = basalt / lum_of(basalt) * (1 - t[..., None]) + dust / lum_of(dust) * t[..., None]
    albedo = (np.maximum(lum, 0) / stats["lum"]) ** ALBEDO_POWER / stats["norm"] * 0.22
    return chroma * albedo[..., None] * 2.0, stats


def mars_global(d, out, layers):
    radius = np.fromfile(os.path.join(d, "megr90n000fb.img"), ">i2").reshape(5760, 11520)
    radius = np.roll(radius, 5760, axis=1).astype(np.float32)  # columns from 180 W, like the tiles
    lo, hi = float(radius.min()), float(radius.max())
    unit, offset = 1.0, 0
    assert hi - offset < 32767 * unit and lo - offset > -32768 * unit
    pyr = Pyramid(radius)

    def make_h(level, x, y):
        lons, lats = grid_points(level, x, y)
        return encode_heights(pyr.raster(tile_size(level) / (GRID - 1)).sample(lons, lats), unit, offset)

    all_tiles = lambda top: [(l, x, y) for l in range(top + 1) for y in range(2**l) for x in range(2 ** (l + 1))]
    layers["mars-height"] = write_layer(out, {
        "id": "mars-height", "body": 499, "kind": "height", "bbox": [-180, -90, 180, 90], "levels": [0, 5],
        "source": "MGS MOLA MEGDR 32 px/deg radius (NASA/GSFC, PDS Geosciences), 3396 km sphere",
        "heightUnit": unit, "heightOffset": offset,
    }, all_tiles(5), make_h)

    viking = np.asarray(Image.open(os.path.join(d, "viking_mdim21_l5.jpg")).convert("RGB"), np.float32)
    viking = box_reduce(viking, 2)  # level 4: 256 px per 11.25 degrees
    rgb, stats = mars_true_colour(viking)
    srgb = linear_to_srgb(rgb)
    cpyr = Pyramid(srgb)

    def make_c(level, x, y):
        lons, lats = pixel_centres(level, x, y)
        return encode_jpeg(cpyr.raster(tile_size(level) / IMAGE).sample(lons, lats))

    layers["mars-color"] = write_layer(out, {
        "id": "mars-color", "body": 499, "kind": "color", "bbox": [-180, -90, 180, 90], "levels": [0, 4],
        "source": "Viking MDIM 2.1 colour mosaic (USGS), via NASA Trek; brightness and dust/basalt colour",
    }, all_tiles(4), make_c)
    return stats


# ---- landing sites -----------------------------------------------------------------

def box_around(site, half):
    lat, lon = site
    return [lon - half / math.cos(math.radians(lat)), lat - half, lon + half / math.cos(math.radians(lat)), lat + half]


def tiles_of(levels, bbox):
    return [(l, x, y) for l in range(levels[0], levels[1] + 1) for x, y in tiles_in_box(l, bbox)]


def edge_fade(levels, bbox, lons, lats, R_km, width_frac=0.25):
    """1 inside the layer's finest tiles, falling to 0 at their outer edge."""
    tiles = tiles_in_box(levels[1], bbox)
    w0 = min(tile_bounds(levels[1], x, y)[0] for x, y in tiles)
    e0 = max(tile_bounds(levels[1], x, y)[2] for x, y in tiles)
    s0 = min(tile_bounds(levels[1], x, y)[1] for x, y in tiles)
    n0 = max(tile_bounds(levels[1], x, y)[3] for x, y in tiles)
    width = (n0 - s0) * width_frac
    d = np.minimum.reduce([lons - w0, e0 - lons, lats - s0, n0 - lats])
    return np.clip(d / width, 0, 1)


FADE_M = 250.0


def inner(valid_fine, valid_smooth):
    """Weight of a site's data: 1 well inside where it is valid, fading to 0 over about
    FADE_M / 2 towards the edge of the data (a DTM's ragged nodata border), so the site
    meets the global data in a gentle slope rather than a cliff."""
    return np.clip(valid_fine, 0, 1) ** 4 * np.clip((valid_smooth - 0.5) / 0.45, 0, 1)


class Site:
    """Height and colour functions for one layer of a site: detail where it is valid,
    faded into `base` near the edges."""

    def __init__(self, name, body, levels, bbox, R_km, heights, base_height, colour, base_colour, fade=True):
        self.name, self.body, self.levels, self.bbox, self.R, self.fade = name, body, levels, bbox, R_km, fade
        self.heights, self.base_height, self.colour, self.base_colour = heights, base_height, colour, base_colour

    def edge(self, lons, lats):
        # A core layer sits inside a wide one made from the same data: no fade needed.
        return edge_fade(self.levels, self.bbox, lons, lats, self.R) if self.fade else 1.0

    def build(self, out, layers, source_h, source_c, unit_offset):
        unit, offset = unit_offset

        # Where the data is valid is decided at full resolution, so every level fades into
        # the base at the same place and neighbouring levels agree (no cracks between them).
        def make_h(level, x, y):
            lons, lats = grid_points(level, x, y)
            per_m = tile_size(level) / (GRID - 1) * math.pi / 180 * self.R * 1000
            h, valid = self.heights(lons, lats, per_m)
            h_fine, valid_fine = self.heights(lons, lats, 0.0)
            h = np.where(valid > 0.5, h, h_fine)
            alpha = inner(valid_fine, self.heights(lons, lats, FADE_M)[1]) * self.edge(lons, lats)
            base = self.base_height(lons, lats, per_m)
            return encode_heights(base * (1 - alpha) + h * alpha, unit, offset)

        def make_c(level, x, y):
            lons, lats = pixel_centres(level, x, y)
            per_m = tile_size(level) / IMAGE * math.pi / 180 * self.R * 1000
            c, valid = self.colour(lons, lats, per_m)
            c_fine, valid_fine = self.colour(lons, lats, 0.0)
            c = np.where((valid > 0.5)[..., None], c, c_fine)
            alpha = (inner(valid_fine, self.colour(lons, lats, FADE_M)[1]) * self.edge(lons, lats))[..., None]
            base = self.base_colour(lons, lats, per_m)
            return encode_jpeg(linear_to_srgb(base * (1 - alpha) + c * alpha))

        tiles = tiles_of(self.levels, self.bbox)
        common = {"body": self.body, "bbox": [round(v, 6) for v in self.bbox], "levels": self.levels}
        layers[f"{self.name}-height"] = write_layer(out, {"id": f"{self.name}-height", **common, "kind": "height", "source": source_h, "heightUnit": unit, "heightOffset": offset}, tiles, make_h, one_pack=True)
        layers[f"{self.name}-color"] = write_layer(out, {"id": f"{self.name}-color", **common, "kind": "color", "source": source_c}, tiles, make_c, one_pack=True)


def sharpen(pan: Projected, base_colour, base_scale_m, max_ratio=4.0):
    """Colour at a point: base colour times the pan image's detail relative to base_scale_m."""
    def colour(lons, lats, scale):
        p, w = pan.sample(lons, lats, scale)
        p_low, w_low = pan.sample(lons, lats, base_scale_m)
        ratio = np.where(w_low > 0, p / np.maximum(p_low, 1e-3), 1.0)
        ratio = np.clip(ratio, 0, max_ratio)
        return base_colour(lons, lats, base_scale_m) * ratio[..., None], np.minimum(w, w_low)
    return colour


def apollo11(d, out, layers):
    s = APOLLO11
    R = s["R"] * 1000
    project = eqc(R, lat_ts=1.0, lon0=180.0)
    wide_box = box_around(s["site"], s["wide"]["half"])
    margin = 400
    dtm, t, dtm_ok = read_window(os.path.join(d, "NAC_DTM_APOLLO11.TIF"), wide_box, project, margin)
    dtm_p = Projected(dtm, t, project, dtm_ok)
    img, t, valid = read_window(os.path.join(d, "NAC_DTM_APOLLO11_M150361817_50CM.IMG"), wide_box, project, margin)
    img_p = Projected(img, t, project, valid & (img > 0))
    # The global layers underneath, as built (level 5).
    big = box_around(s["site"], 3.5)
    base_c = mosaic_from_tiles(out, "moon-color", 5, big, "colour")
    base_h = mosaic_from_tiles(out, "moon-height", 5, big, "height")
    base_lin = Raster(srgb_to_linear(base_c.data), base_c.lon0, base_c.lat0, base_c.step, wrap=False)
    base_colour = lambda lons, lats, scale: base_lin.sample(lons, lats)
    base_height = lambda lons, lats, scale: base_h.sample(lons, lats)
    heights = lambda lons, lats, scale: dtm_p.sample(lons, lats, scale)
    # Global LROC pixels are ~670 m: the NAC image's detail is taken relative to that.
    colour = sharpen(img_p, base_colour, 700.0)
    lo, hi = float(dtm[dtm_ok].min()), float(dtm[dtm_ok].max())
    for part in ("wide", "core"):
        box = box_around(s["site"], s[part]["half"])
        Site(f"apollo11-{part}", 301, s[part]["levels"], box, s["R"], heights, base_height, colour, base_colour, fade=part == "wide").build(
            out, layers,
            "LRO NAC DTM NAC_DTM_APOLLO11, 2 m (NASA/GSFC/ASU)",
            "LRO NAC orthophoto M150361817, 0.5 m (NASA/GSFC/ASU), colour from LROC WAC",
            height_scale(lo - 50, hi + 50))


def jezero(d, out, layers, mars_stats):
    s = JEZERO
    R_trn = 3396190.0
    project = eqc(R_trn)
    # The areoid (MOLA radius less topography, 32 px/deg), to put TRN heights on the sphere.
    radius = np.fromfile(os.path.join(d, "megr90n000fb.img"), ">i2").reshape(5760, 11520).astype(np.float32)
    topo = np.fromfile(os.path.join(d, "megt90n000fb.img"), ">i2").reshape(5760, 11520).astype(np.float32)
    areoid = Raster(radius - topo, 1 / 64, 90 - 1 / 64, 1 / 32, wrap=True)  # columns from 0 E
    mola = Raster(radius, 1 / 64, 90 - 1 / 64, 1 / 32, wrap=True)
    to_sphere = lambda lons, lats: areoid.sample(np.mod(lons, 360), lats)

    viking = np.asarray(Image.open(os.path.join(d, "viking_mdim21_l5.jpg")).convert("RGB"), np.float32)
    crater_box = s["crater"]["bbox"]
    step = 360 / viking.shape[1]
    c0, c1 = int((crater_box[0] - 2 + 180) / step), int((crater_box[2] + 2 + 180) / step)
    r0, r1 = int((90 - crater_box[3] - 2) / step), int((90 - crater_box[1] + 2) / step)
    lin, _ = mars_true_colour(viking[r0:r1, c0:c1], mars_stats)
    vraster = Raster(lin, -180 + (c0 + 0.5) * step, 90 - (r0 + 0.5) * step, step, wrap=False)
    base_colour = lambda lons, lats, scale: vraster.sample(lons, lats)
    base_height = lambda lons, lats, scale: mola.sample(np.mod(lons, 360), lats)

    ctx_dtm, t, ctx_ok = read_window(os.path.join(d, "JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif"), crater_box, project, 2000)
    ctx_h = Projected(ctx_dtm, t, project, ctx_ok)
    ctx_img, t, v = read_window(os.path.join(d, "JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif"), crater_box, project, 2000)
    ctx_p = Projected(srgb_to_linear(ctx_img), t, project, v & (ctx_img > 0))
    ctx_colour = sharpen(ctx_p, base_colour, 1300.0, max_ratio=2.0)

    def ctx_heights(lons, lats, scale):
        h, w = ctx_h.sample(lons, lats, scale)
        return h + to_sphere(lons, lats), w

    hi_meta = json.load(open(os.path.join(d, "jezero_hirise_dtm.npy.json")))
    hi_dtm = np.load(os.path.join(d, "jezero_hirise_dtm.npy")).astype(np.float32)
    hi_h = Projected(hi_dtm, hi_meta["transform"], project, hi_dtm > -1e30)
    ortho_meta = json.load(open(os.path.join(d, "jezero_hirise_ortho.npy.json")))
    ortho = np.load(os.path.join(d, "jezero_hirise_ortho.npy"))
    hi_p = Projected(srgb_to_linear(ortho), ortho_meta["transform"], project, ortho > 0)
    del ortho

    def hi_colour(lons, lats, scale):
        # HiRISE detail relative to 40 m, on the CTX-sharpened colour at 40 m.
        c_ctx, w_ctx = ctx_colour(lons, lats, 40.0)
        p, w = hi_p.sample(lons, lats, scale)
        p_low, w_low = hi_p.sample(lons, lats, 40.0)
        ratio = np.clip(np.where(w_low > 0, p / np.maximum(p_low, 1e-3), 1.0), 0, 4)
        return c_ctx * ratio[..., None], np.minimum(w, w_low) * (w_ctx > 0.5)

    def hi_heights(lons, lats, scale):
        h, w = hi_h.sample(lons, lats, scale)
        return h + to_sphere(lons, lats), w

    def ctx_colour_or_base(lons, lats, scale):
        c, w = ctx_colour(lons, lats, max(scale, 1300.0))
        a = np.clip(w, 0, 1)[..., None]
        return c * a + base_colour(lons, lats, scale) * (1 - a)

    def ctx_height_or_base(lons, lats, scale):
        h, w = ctx_heights(lons, lats, scale)
        a = np.clip(w, 0, 1) ** 4
        return h * a + base_height(lons, lats, scale) * (1 - a)

    lat0, lon0 = s["site"]
    shift = float(to_sphere(np.array([lon0]), np.array([lat0]))[0])
    lo = float(ctx_dtm[ctx_ok].min()) + shift - 500
    hi = float(ctx_dtm[ctx_ok].max()) + shift + 500
    scale = height_scale(lo, hi)
    ctx_src = ("Mars 2020 TRN CTX DTM, 20 m (USGS), on the MOLA areoid", "Mars 2020 TRN CTX orthomosaic, 6 m (USGS); colour from Viking")
    hi_src = ("Mars 2020 TRN HiRISE DTM, 1 m (USGS), on the MOLA areoid", "Mars 2020 TRN HiRISE orthomosaic, 25 cm (USGS); colour from Viking")
    Site("jezero-crater", 499, s["crater"]["levels"], crater_box, MARS_R, ctx_heights, base_height, ctx_colour, base_colour).build(out, layers, *ctx_src, scale)
    for part in ("wide", "core"):
        box = box_around(s["site"], s[part]["half"])
        Site(f"jezero-{part}", 499, s[part]["levels"], box, MARS_R, hi_heights, ctx_height_or_base, hi_colour, ctx_colour_or_base, fade=part == "wide").build(out, layers, *hi_src, scale)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    parser.add_argument("out")
    parser.add_argument("manifest")
    parser.add_argument("--only", help="comma-separated: mars, apollo11, jezero")
    args = parser.parse_args()
    only = set(args.only.split(",")) if args.only else {"mars", "apollo11", "jezero"}
    manifest = json.load(open(args.manifest))
    layers = {l["id"]: l for l in manifest["layers"]}
    stats_path = os.path.join(args.data, "mars_colour_stats.json")
    if "mars" in only:
        stats = mars_global(args.data, args.out, layers)
        json.dump(stats, open(stats_path, "w"))
    if "apollo11" in only:
        apollo11(args.data, args.out, layers)
    if "jezero" in only:
        jezero(args.data, args.out, layers, json.load(open(stats_path)))
    manifest["layers"] = list(layers.values())
    with open(args.manifest, "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"wrote {args.manifest}")


if __name__ == "__main__":
    main()
