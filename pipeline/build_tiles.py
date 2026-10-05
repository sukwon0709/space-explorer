"""Build the Earth and Moon surface tiles from the datasets fetch_sources.py downloads.

Usage:
    python pipeline/build_tiles.py DATA_DIR public/data/tiles src/generated/tiles.json

Tiling scheme (geographic, the same for every body)
    Level L has 2^(L+1) x 2^L tiles, each 180/2^L degrees square; x runs east from
    180 W, y runs south from 90 N. Colour tiles are 256 x 256 JPEG pixels (pixel
    centres inset half a pixel). Height tiles are 65 x 65 vertex samples including both
    edges, little-endian int16 in units of 0.5 m above the reference ellipsoid (WGS84
    for Earth) or sphere (1737.4 km for the Moon), zlib-compressed. The lowest bit is a
    water flag (oceans and lakes), so heights are effectively stored to 1 m.

Packing
    Tiles are grouped into chunk files so a view loads a few files rather than
    thousands. A chunk is rooted at a tile on one of CHUNK_ROOTS and holds that tile's
    descendants down to the level before the next root. File layout (little-endian):
        b"TPAK", u32 version, u32 count, u32 reserved,
        count x (u8 level, u8 0, u16 0, u32 x, u32 y, u32 offset, u32 length), blobs.

Layers
    Global layers cover the whole body to GLOBAL_MAX_LEVEL. The Grand Canyon showcase
    adds levels 6 to 13 inside its box, with the global data composited underneath so
    every tile is complete. The manifest lists every layer, its box and its chunks.
"""

import argparse
import io
import json
import os
import struct
import zlib

import netCDF4
import numpy as np
import tifffile
from PIL import Image
from pyproj import Transformer

Image.MAX_IMAGE_PIXELS = None

CHUNK_ROOTS = [0, 2, 6, 10, 14, 18]
GLOBAL_MAX_LEVEL = 5
IMAGE = 256
GRID = 65
HEIGHT_UNIT = 0.5  # metres per int16 step
JPEG_QUALITY = 84

GRAND_CANYON = {"id": "grand-canyon", "bbox": [-112.30, 36.04, -112.02, 36.30], "levels": [6, 13]}


# ---- tiling -------------------------------------------------------------------------

def tile_size(level: int) -> float:
    return 180.0 / 2**level


def tile_bounds(level: int, x: int, y: int):
    s = tile_size(level)
    lon0, lat1 = -180 + x * s, 90 - y * s
    return lon0, lat1 - s, lon0 + s, lat1  # west, south, east, north


def tiles_in_box(level: int, bbox):
    w, s, e, n = bbox
    size = tile_size(level)
    x0, x1 = int((w + 180) // size), int(np.ceil((e + 180) / size)) - 1
    y0, y1 = int((90 - n) // size), int(np.ceil((90 - s) / size)) - 1
    return [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]


def chunk_root(level: int) -> int:
    return max(r for r in CHUNK_ROOTS if r <= level)


def chunk_key(level: int, x: int, y: int) -> str:
    r = chunk_root(level)
    return f"{r}-{x >> (level - r)}-{y >> (level - r)}"


def pixel_centres(level: int, x: int, y: int):
    w, s, e, n = tile_bounds(level, x, y)
    step = (e - w) / IMAGE
    lons = w + (np.arange(IMAGE) + 0.5) * step
    lats = n - (np.arange(IMAGE) + 0.5) * step
    return np.meshgrid(lons, lats)


def grid_points(level: int, x: int, y: int):
    w, s, e, n = tile_bounds(level, x, y)
    return np.meshgrid(np.linspace(w, e, GRID), np.linspace(n, s, GRID))


# ---- sampling -----------------------------------------------------------------------

class Raster:
    """A lat/lon grid with bilinear sampling. `lon0`/`lat0` locate the centre of pixel
    (0, 0); `step` is degrees per pixel (rows run south). Longitude wraps if global."""

    def __init__(self, data: np.ndarray, lon0: float, lat0: float, step: float, wrap: bool):
        self.data, self.lon0, self.lat0, self.step, self.wrap = data, lon0, lat0, step, wrap

    def sample(self, lons: np.ndarray, lats: np.ndarray) -> np.ndarray:
        h, w = self.data.shape[:2]
        fx = (lons - self.lon0) / self.step
        fy = (self.lat0 - lats) / self.step
        x0 = np.floor(fx).astype(np.int64)
        y0 = np.floor(fy).astype(np.int64)
        tx, ty = fx - x0, fy - y0
        if self.wrap:
            xa, xb = x0 % w, (x0 + 1) % w
        else:
            xa, xb = np.clip(x0, 0, w - 1), np.clip(x0 + 1, 0, w - 1)
        ya, yb = np.clip(y0, 0, h - 1), np.clip(y0 + 1, 0, h - 1)
        d = self.data
        if d.ndim == 3:
            tx, ty = tx[..., None], ty[..., None]
        top = d[ya, xa] * (1 - tx) + d[ya, xb] * tx
        bottom = d[yb, xa] * (1 - tx) + d[yb, xb] * tx
        return top * (1 - ty) + bottom * ty

    def inside(self, lons, lats) -> np.ndarray:
        h, w = self.data.shape[:2]
        fx = (lons - self.lon0) / self.step
        fy = (self.lat0 - lats) / self.step
        return (fx >= 0) & (fx <= w - 1) & (fy >= 0) & (fy <= h - 1)


def box_reduce(a: np.ndarray, f: int) -> np.ndarray:
    h, w = a.shape[0] // f * f, a.shape[1] // f * f
    a = a[:h, :w]
    return a.reshape(h // f, f, w // f, f, *a.shape[2:]).mean(axis=(1, 3))


class Pyramid:
    """Box-filtered levels of a global equirectangular raster (pixel-is-area), so each
    tile level samples a version no finer than about one source pixel per output pixel."""

    def __init__(self, data: np.ndarray):
        self.levels = [data.astype(np.float32)]
        while self.levels[-1].shape[1] > 512:
            self.levels.append(box_reduce(self.levels[-1], 2))

    def raster(self, degrees_per_sample: float) -> Raster:
        for a in reversed(self.levels):
            step = 360.0 / a.shape[1]
            if step <= degrees_per_sample * 1.01 or a is self.levels[0]:
                return Raster(a, -180 + step / 2, 90 - step / 2, step, wrap=True)
        raise AssertionError


# ---- encoding -----------------------------------------------------------------------

def encode_jpeg(rgb: np.ndarray) -> bytes:
    img = Image.fromarray(np.clip(rgb + 0.5, 0, 255).astype(np.uint8))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=JPEG_QUALITY, optimize=True)
    return buf.getvalue()


def encode_heights(metres: np.ndarray, water: np.ndarray | None = None) -> bytes:
    q = np.clip(np.round(metres / HEIGHT_UNIT), -32768, 32767).astype(np.int32)
    q = (q & ~1) | (water.astype(np.int32) if water is not None else 0)
    return zlib.compress(q.astype("<i2").tobytes(), 9)


class PackWriter:
    def __init__(self, directory: str):
        self.directory = directory
        self.chunks: dict[str, list] = {}

    def add(self, level: int, x: int, y: int, blob: bytes):
        self.chunks.setdefault(chunk_key(level, x, y), []).append((level, x, y, blob))

    def write(self) -> dict:
        os.makedirs(self.directory, exist_ok=True)
        summary = {}
        for key, tiles in self.chunks.items():
            tiles.sort()
            offset = 16 + 20 * len(tiles)
            header = [struct.pack("<4sIII", b"TPAK", 1, len(tiles), 0)]
            for level, x, y, blob in tiles:
                header.append(struct.pack("<BBHIIII", level, 0, 0, x, y, offset, len(blob)))
                offset += len(blob)
            with open(os.path.join(self.directory, f"{key}.bin"), "wb") as f:
                f.write(b"".join(header))
                for *_, blob in tiles:
                    f.write(blob)
            summary[key] = max(t[0] for t in tiles)
        return summary


# ---- layers -------------------------------------------------------------------------

def build_layer(out_dir: str, layer: dict, levels, tiles_for_level, make_tile) -> dict:
    writer = PackWriter(os.path.join(out_dir, layer["id"]))
    count = 0
    for level in levels:
        for x, y in tiles_for_level(level):
            writer.add(level, x, y, make_tile(level, x, y))
            count += 1
    layer["chunks"] = writer.write()
    size = sum(os.path.getsize(os.path.join(out_dir, layer["id"], f"{k}.bin")) for k in layer["chunks"])
    print(f"{layer['id']}: {count} tiles in {len(layer['chunks'])} chunks, {size / 1e6:.1f} MB")
    return layer


def all_tiles(level: int):
    return [(x, y) for y in range(2**level) for x in range(2 ** (level + 1))]


def global_colour(out_dir, layer, pyramid: Pyramid, transform=None):
    def make(level, x, y):
        lons, lats = pixel_centres(level, x, y)
        rgb = pyramid.raster(tile_size(level) / IMAGE).sample(lons, lats)
        return encode_jpeg(transform(rgb) if transform else rgb)

    return build_layer(out_dir, layer, range(GLOBAL_MAX_LEVEL + 1), all_tiles, make)


def global_heights(out_dir, layer, pyramid: Pyramid, offset=None, water=None):
    def make(level, x, y):
        lons, lats = grid_points(level, x, y)
        h = pyramid.raster(tile_size(level) / (GRID - 1)).sample(lons, lats)
        wet = None
        if water is not None:
            # ETOPO's "surface" includes the sea floor; water is drawn at its surface.
            wet = water.sample(lons, lats) > 0.5
            h = np.where(wet, np.maximum(h, 0), h)
        return encode_heights(h + (offset(lons, lats) if offset else 0), wet)

    return build_layer(out_dir, layer, range(GLOBAL_MAX_LEVEL + 1), all_tiles, make)


def feather(region: Raster, lons, lats, width_px: float = 40) -> np.ndarray:
    """1 well inside the region raster, falling to 0 over `width_px` pixels at its edge."""
    h, w = region.data.shape[:2]
    fx = (lons - region.lon0) / region.step
    fy = (region.lat0 - lats) / region.step
    d = np.minimum.reduce([fx, w - 1 - fx, fy, h - 1 - fy])
    return np.clip(d / width_px, 0, 1)


def region_layer(out_dir, layer, base: Pyramid, detail: np.ndarray, detail_raster: Raster, kind: str, offset=None, water=None):
    """Levels above the global maximum inside a box: detail composited over the base."""
    lo, hi = layer["levels"]
    pyramid = [detail]
    while len(pyramid) <= hi - lo:
        pyramid.append(box_reduce(pyramid[-1], 2))

    def detail_at(level):
        f = 2 ** (hi - level)
        r = detail_raster
        # A box-reduced pixel's centre sits (f-1)/2 source pixels in from the corner.
        return Raster(pyramid[hi - level], r.lon0 + (f - 1) / 2 * r.step, r.lat0 - (f - 1) / 2 * r.step, r.step * f, wrap=False)

    def make(level, x, y):
        if kind == "colour":
            lons, lats = pixel_centres(level, x, y)
            per = tile_size(level) / IMAGE
        else:
            lons, lats = grid_points(level, x, y)
            per = tile_size(level) / (GRID - 1)
        base_values = base.raster(per).sample(lons, lats)
        r = detail_at(level)
        alpha = feather(r, lons, lats)
        values = r.sample(lons, lats)
        if kind == "colour":
            # Channel 3 is the fraction of valid pixels; keep only fully covered ones.
            alpha = alpha * (values[..., 3] > 0.999)
            out = base_values * (1 - alpha[..., None]) + values[..., :3] * alpha[..., None]
            return encode_jpeg(out)
        wet = water.sample(lons, lats) > 0.5 if water is not None else None
        if wet is not None:
            base_values = np.where(wet, np.maximum(base_values, 0), base_values)
        out = base_values + (offset(lons, lats) if offset else 0)
        out = out * (1 - alpha) + values * alpha
        return encode_heights(out, wet)

    return build_layer(out_dir, layer, range(lo, hi + 1), lambda level: tiles_in_box(level, layer["bbox"]), make)


# ---- sources ------------------------------------------------------------------------

def load_image(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)


def geoid(data_dir: str):
    """EGM96 geoid height (m) above WGS84, to turn sea-level heights into ellipsoidal ones."""
    g = tifffile.imread(os.path.join(data_dir, "us_nga_egm96_15.tif")).astype(np.float64)
    r = Raster(g, -180.0, 90.0, 0.25, wrap=True)
    return r.sample


def water_mask(data_dir: str) -> Raster:
    """MODIS land/water mask from GIBS: water is drawn cyan, land is transparent (black)."""
    m = (np.asarray(Image.open(os.path.join(data_dir, "water_16k.png")).convert("RGB"))[..., 0] > 100).astype(np.float32)
    step = 360.0 / m.shape[1]
    return Raster(m, -180 + step / 2, 90 - step / 2, step, wrap=True)


def etopo(data_dir: str) -> np.ndarray:
    d = netCDF4.Dataset(os.path.join(data_dir, "etopo60.nc"))
    z = np.asarray(d["z"][:], dtype=np.float32)
    assert d["lat"][0] < 0 and abs(d["lon"][0] + 179.99166667) < 1e-6
    return z[::-1]  # rows south-to-north in the file; the pyramid wants north first


def night_lights(rgb: np.ndarray) -> np.ndarray:
    """Black Marble shows moonlit ground in blue as well as city lights; keep the lights.
    Artificial light is warm or white; moonlit snow and land are blue and dim, so
    brightness is kept and any excess of blue over red/green is taken off twice."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    warm = (r + g) / 2
    lights = np.clip((warm - 2 * np.maximum(b - warm, 0) - 18) * 255 / 237, 0, 255)
    return np.repeat(lights[..., None], 3, axis=2)


def grand_canyon_colour(data_dir: str, layer: dict):
    """Sentinel-2 true colour reprojected from UTM 12N onto the level-13 pixel grid."""
    hi = layer["levels"][1]
    tiles = tiles_in_box(hi, layer["bbox"])
    xs, ys = [t[0] for t in tiles], [t[1] for t in tiles]
    w, _, _, n = tile_bounds(hi, min(xs), min(ys))
    step = tile_size(hi) / IMAGE
    width, height = (max(xs) - min(xs) + 1) * IMAGE, (max(ys) - min(ys) + 1) * IMAGE
    lons, lats = np.meshgrid(w + (np.arange(width) + 0.5) * step, n - (np.arange(height) + 0.5) * step)
    tci = tifffile.imread(os.path.join(data_dir, "S2B_12SUF_20251018_0_L2A_TCI.tif"))
    east, north = Transformer.from_crs("EPSG:4326", "EPSG:32612", always_xy=True).transform(lons, lats)
    utm = Raster(tci.astype(np.float32), 300000 + 5, 4100040 - 5, 10.0, wrap=False)
    # Raster works in "lon/lat" units; here they are easting/northing metres.
    # TCI is reflectance stretched for display (255 at about 0.3); scale it to match the
    # Blue Marble brightness around the canyon (linear means 0.41 vs 0.10 in red).
    rgb = utm.sample(east, north) * 0.58
    # A fourth channel marks real Sentinel-2 pixels (TCI nodata is 0), so the
    # composite falls back to the global map wherever the scene has no data.
    valid = utm.inside(east, north) & (rgb.sum(axis=2) > 0)
    rgb = np.concatenate([np.where(valid[..., None], rgb, 0), valid[..., None].astype(np.float32)], axis=2)
    return rgb, Raster(rgb, w + step / 2, n - step / 2, step, wrap=False)


def grand_canyon_heights(data_dir: str, layer: dict, geoid_at):
    hi = layer["levels"][1]
    tiles = tiles_in_box(hi, layer["bbox"])
    xs, ys = [t[0] for t in tiles], [t[1] for t in tiles]
    w, _, _, n = tile_bounds(hi, min(xs), min(ys))
    step = tile_size(hi) / (GRID - 1)
    cols, rows = (max(xs) - min(xs) + 1) * (GRID - 1) + 1, (max(ys) - min(ys) + 1) * (GRID - 1) + 1
    lons, lats = np.meshgrid(w + np.arange(cols) * step, n - np.arange(rows) * step)
    # Copernicus GLO-30: pixel-is-point, pixel (0,0) centred on the tile's NW integer corner,
    # 1 arc-second spacing at this latitude; heights above the EGM2008 geoid.
    west = Raster(tifffile.imread(os.path.join(data_dir, "cop30_N36_00_W113.tif")), -113.0, 37.0, 1 / 3600, wrap=False)
    east = Raster(tifffile.imread(os.path.join(data_dir, "cop30_N36_00_W112.tif")), -112.0, 37.0, 1 / 3600, wrap=False)
    h = np.where(lons < -112.0, west.sample(lons, lats), east.sample(lons, lats))
    h = h + geoid_at(lons, lats)
    return h.astype(np.float32), Raster(h, w, n, step, wrap=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    parser.add_argument("out")
    parser.add_argument("manifest")
    parser.add_argument("--only", help="comma-separated layer ids to rebuild")
    args = parser.parse_args()
    d = args.data
    only = set(args.only.split(",")) if args.only else None
    manifest = json.load(open(args.manifest)) if only and os.path.exists(args.manifest) else {"layers": []}
    layers = {l["id"]: l for l in manifest["layers"]}

    def want(layer_id):
        return only is None or layer_id in only

    geoid_at = geoid(d)
    global_box = [-180, -90, 180, 90]

    if want("earth-color"):
        bmng = Pyramid(load_image(os.path.join(d, "bmng_16k.jpg")))
        layers["earth-color"] = global_colour(args.out, {
            "id": "earth-color", "body": 399, "kind": "color", "bbox": global_box, "levels": [0, GLOBAL_MAX_LEVEL],
            "source": "NASA Blue Marble: Next Generation (MODIS), via NASA GIBS",
        }, bmng)
    if want("earth-night"):
        layers["earth-night"] = global_colour(args.out, {
            "id": "earth-night", "body": 399, "kind": "night", "bbox": global_box, "levels": [0, GLOBAL_MAX_LEVEL],
            "source": "NASA Black Marble 2016 (VIIRS day/night band), via NASA GIBS",
        }, Pyramid(load_image(os.path.join(d, "blackmarble2016_16k.jpg"))), night_lights)
    if want("earth-height"):
        layers["earth-height"] = global_heights(args.out, {
            "id": "earth-height", "body": 399, "kind": "height", "bbox": global_box, "levels": [0, GLOBAL_MAX_LEVEL],
            "source": "NOAA ETOPO 2022 (60 arc-second), EGM96 geoid, MODIS water mask",
        }, Pyramid(etopo(d)), offset=geoid_at, water=water_mask(d))
    if want("grand-canyon-color"):
        bmng = Pyramid(load_image(os.path.join(d, "bmng_16k.jpg")))
        layer = {**GRAND_CANYON, "id": "grand-canyon-color", "body": 399, "kind": "color",
                 "source": "Copernicus Sentinel-2B true colour, 18 Oct 2025 (ESA)"}
        rgb, raster = grand_canyon_colour(d, layer)
        layers[layer["id"]] = region_layer(args.out, layer, bmng, rgb, raster, "colour")
    if want("grand-canyon-height"):
        layer = {**GRAND_CANYON, "id": "grand-canyon-height", "body": 399, "kind": "height",
                 "source": "Copernicus DEM GLO-30 (ESA), EGM2008 heights"}
        h, raster = grand_canyon_heights(d, layer, geoid_at)
        layers[layer["id"]] = region_layer(args.out, layer, Pyramid(etopo(d)), h, raster, "height", offset=geoid_at, water=water_mask(d))
    if want("moon-color"):
        lroc = tifffile.imread(os.path.join(d, "lroc_color_poles_16k.tif")).astype(np.float32)
        layers["moon-color"] = global_colour(args.out, {
            "id": "moon-color", "body": 301, "kind": "color", "bbox": global_box, "levels": [0, GLOBAL_MAX_LEVEL],
            "source": "LRO LROC WAC colour mosaic (NASA/GSFC/ASU), NASA SVS CGI Moon Kit",
        }, Pyramid(lroc))
    if want("moon-height"):
        ldem = tifffile.imread(os.path.join(d, "ldem_16.tif")).astype(np.float32) * 1000.0  # km -> m
        layers["moon-height"] = global_heights(args.out, {
            "id": "moon-height", "body": 301, "kind": "height", "bbox": global_box, "levels": [0, GLOBAL_MAX_LEVEL],
            "source": "LRO LOLA elevation (NASA/GSFC), 1737.4 km reference sphere",
        }, Pyramid(ldem))

    order = ["earth-color", "grand-canyon-color", "earth-night", "earth-height", "grand-canyon-height", "moon-color", "moon-height"]
    manifest = {
        "scheme": {"image": IMAGE, "grid": GRID, "heightUnit": HEIGHT_UNIT, "chunkRoots": CHUNK_ROOTS},
        "layers": [layers[k] for k in order if k in layers],
    }
    os.makedirs(os.path.dirname(args.manifest), exist_ok=True)
    with open(args.manifest, "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"wrote {args.manifest}")


if __name__ == "__main__":
    main()
