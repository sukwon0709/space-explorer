"""Build terrain tiles for the solid worlds beyond Earth, the Moon and Mars, so every one
of them can be landed on and walked: Mercury, Ceres, Vesta, Phobos, the Galilean moons,
Saturn's large icy moons, Triton, Pluto and Charon. Same tiling and packs as
build_tiles.py; the layers are added to the same manifest.

Usage (from the repository root):
    python pipeline/fetch_worlds.py DATA_DIR
    python pipeline/build_worlds.py DATA_DIR public/data/tiles src/generated/tiles.json [--only mercury,pluto]

Colour
    The USGS global mosaic each body's distant map (build_maps.py) comes from, at full
    resolution, processed the same way: monochrome mosaics (and false-colour ones) keep
    their brightness and take the body's colour; mosaics in natural colour keep it.
    Brightness is normalised to a mean linear value of 0.25, and the app scales it to
    the body's geometric albedo from the layer's measured mean (planets.ts albedoScale),
    so the close-up ground matches the body seen from afar. Areas never imaged (Pluto's
    and Charon's far sides) are each row's mean, as on the distant maps.

Heights
    Where a global elevation model exists, heights come from it: MESSENGER MDIS stereo
    (Mercury), Dawn FC HAMO stereo (Ceres, Vesta), Mars Express HRSC (Phobos), Cassini
    ISS stereo-photoclinometry (Enceladus), New Horizons LORRI stereo (Pluto, Charon,
    encounter hemispheres only). Elsewhere a body is its IAU triaxial ellipsoid, without
    relief. Every body uses one reference sphere (`radius` in the manifest's `worlds`);
    heights are the surface's distance from the centre less that radius, so an elevation
    model given above an ellipsoid (Ceres, Vesta) has the ellipsoid added back. Where a
    partial model ends, it fades into the ellipsoid over FEATHER_KM.
"""

import argparse
import json
import math
import os
import re
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from build_maps import blend_seam, fill_gaps, hex_rgb, linear_to_srgb, srgb_to_linear  # noqa: E402
from build_surfaces import encode_heights, height_scale, write_layer  # noqa: E402
from build_tiles import GRID, IMAGE, Pyramid, encode_jpeg, grid_points, pixel_centres, tile_size  # noqa: E402

Image.MAX_IMAGE_PIXELS = None
FEATHER_KM = 40.0
ROTATION = os.path.join(os.path.dirname(__file__), "..", "src", "generated", "rotation.json")

# name, NAIF id, colour mosaic, tint (None: natural colour), colour levels,
# elevation model (file, reference, height levels) or None, credits.
# Reference: "sphere" (heights above the model's projection sphere), "radius" (values are
# radii, metres), or "ellipsoid" (heights above the IAU triaxial ellipsoid). Stored values
# are scaled by the GeoTIFF's scale and offset (Mercury: 0.5 m steps; Ceres: radius less
# 470 km).
WORLDS = [
    ("mercury", 199, "Mercury_MESSENGER_mosaic_global_250m_2013", "#a19a92", 5,
     ("Mercury_Messenger_USGS_DEM_Global_665m_v2", "sphere", 5),
     "MESSENGER MDIS global mosaic 250 m (NASA/JHUAPL/CIW, USGS)", "MESSENGER MDIS stereo DEM 665 m (USGS)"),
    ("ceres", 2000001, "Ceres_Dawn_FC_DLR_global_20ppd_Oct2015", "#8c8780", 4,
     ("Ceres_Dawn_FC_HAMO_DTM_DLR_Global_60ppd_Oct2016", "radius", 5),
     "Dawn FC global mosaic 20 px/deg (NASA/JPL, DLR, USGS)", "Dawn FC HAMO DTM 60 px/deg (DLR)"),
    ("vesta", 2000004, "Vesta_Dawn_FC_HAMO_Mosaic_Global_74ppd", "#a8a39b", 4,
     ("Vesta_Dawn_HAMO_DTM_DLR_Global_48ppd", "radius", 5),
     "Dawn FC HAMO mosaic 74 px/deg (NASA/JPL, USGS)", "Dawn FC HAMO DTM 48 px/deg (DLR)"),
    ("phobos", 401, "Phobos_ME_SRC_Mosaic_Global_16ppd", "#6e655c", 3,
     ("Phobos_ME_HRSC_DEM_Global_2ppd", "sphere", 3),
     "Mars Express SRC mosaic 16 px/deg (ESA/DLR/FU Berlin, USGS)", "Mars Express HRSC DEM 2 px/deg (ESA/DLR/FU Berlin)"),
    ("io", 501, "Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km", None, 4, None,
     "Galileo SSI and Voyager colour mosaic 1 km (NASA, USGS)", None),
    ("europa", 502, "Europa_Voyager_GalileoSSI_global_mosaic_500m", "#d9cdb4", 5, None,
     "Voyager and Galileo SSI mosaic 500 m (NASA, USGS)", None),
    ("ganymede", 503, "Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m", None, 4, None,
     "Voyager and Galileo SSI colour mosaic 1.4 km (NASA, USGS)", None),
    ("callisto", 504, "Callisto_Voyager_GalileoSSI_global_mosaic_1km", "#8f8270", 4, None,
     "Voyager and Galileo SSI mosaic 1 km (NASA, USGS)", None),
    ("enceladus", 602, "Enceladus_Cassini_mosaic_global_110m", "#f2f2ef", 4,
     ("enceladus_2019pm_radius", "sphere", 2),
     "Cassini ISS mosaic 110 m (NASA/JPL, USGS)", "Cassini ISS shape model (Bland et al. 2019, USGS)"),
    ("tethys", 603, "Tethys_Cassini_mosaic_global_293m", "#e6e2db", 4, None,
     "Cassini ISS mosaic 293 m (NASA/JPL, USGS)", None),
    ("dione", 604, "Dione_Cassini_Voyager_mosaic_global_154m", "#dcd8d0", 4, None,
     "Cassini ISS and Voyager mosaic 154 m (NASA/JPL, USGS)", None),
    ("rhea", 605, "Rhea_Cassini_Voyager_mosaic_global_417m", "#d9d4ca", 4, None,
     "Cassini ISS and Voyager mosaic 417 m (NASA/JPL, USGS)", None),
    ("iapetus", 608, "Iapetus_Cassini_Voyager_mosaic_global_783m", "#d6c9b0", 3, None,
     "Cassini ISS and Voyager mosaic 783 m (NASA/JPL, USGS)", None),
    ("triton", 801, "Triton_Voyager2_ClrMosaic_GlobalFill_600m", None, 4, None,
     "Voyager 2 colour mosaic 600 m (NASA, USGS)", None),
    ("pluto", 999, "Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit", "#d2b394", 4,
     ("Pluto_NewHorizons_Global_DEM_300m_Jul2017_16bit", "sphere", 5),
     "New Horizons LORRI mosaic 300 m (NASA/JHUAPL/SwRI, USGS)", "New Horizons LORRI stereo DEM 300 m (NASA/JHUAPL/SwRI, USGS)"),
    ("charon", 901, "Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit", "#b1a79e", 4,
     ("Charon_NewHorizons_Global_DEM_300m_Jul2017_16bit", "sphere", 4),
     "New Horizons LORRI mosaic 300 m (NASA/JHUAPL/SwRI, USGS)", "New Horizons LORRI stereo DEM 300 m (NASA/JHUAPL/SwRI, USGS)"),
]

# Mosaics whose left and right edges do not match in brightness (build_maps.SEAMED).
SEAMED = {"phobos"}
# Elevation models without a label of their own: their longitudes run east.
POSITIVE_EAST = {"enceladus_2019pm_radius"}


def iau_radii(body):
    """IAU triaxial radii (km), as the app uses them (pck00011 via rotation.json)."""
    table = json.load(open(ROTATION))["bodies"]
    return table[str(body)]["radii"]


def ellipsoid_radius(radii, lons, lats):
    """Distance (km) from the centre to a triaxial ellipsoid along planetocentric lon/lat."""
    a, b, c = radii
    lo, la = np.radians(lons), np.radians(lats)
    x, y, z = np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)
    return 1.0 / np.sqrt((x / a) ** 2 + (y / b) ** 2 + (z / c) ** 2)


def label_direction(path):
    """(longitude direction, centre longitude) from a mosaic's ISIS label."""
    name = os.path.basename(path)[:-4]
    if name in POSITIVE_EAST or not os.path.exists(path[:-4] + ".lbl"):
        return "PositiveEast", None
    text = open(path[:-4] + ".lbl", encoding="latin-1").read()
    direction = re.search(r"LongitudeDirection\s*=\s*(\w+)", text).group(1)
    clon = float(re.search(r"CenterLongitude\s*=\s*([-\d.]+)", text).group(1))
    return direction, clon


def read_global(path, width, resampling="average"):
    """A whole-body raster as (width/2, width, bands) float32, columns from 180 W, rows
    from 90 N, box-averaged from the source; and its valid mask."""
    import rasterio
    from rasterio.enums import Resampling

    with rasterio.open(path) as d:
        h = width // 2
        data = d.read(out_shape=(d.count, h, width), resampling=getattr(Resampling, resampling), masked=True)
        x0, scale = d.transform.c, d.transform.a
        top = d.transform.f
        radius = d.width * scale / (2 * math.pi)
        crs_lon0 = float(re.search(r"\+lon_0=([-\d.]+)", d.crs.to_proj4()).group(1))
    direction, clon = label_direction(path)
    clon = crs_lon0 if clon is None else clon
    assert abs(math.degrees(top / radius) - 90) < 0.5, f"{path}: does not start at the north pole"
    # As in build_maps.usgs_map: east is to the right in both conventions; they differ in
    # the longitude the left edge is labelled with.
    left = math.degrees(x0 / radius) + clon if direction == "PositiveEast" else math.degrees(x0 / radius) - clon
    valid = ~np.ma.getmaskarray(data).any(axis=0)
    img = np.moveaxis(np.ma.filled(data.astype(np.float32), 0), 0, -1)
    shift = int(round((left + 180) / 360 * width)) % width
    return np.roll(img, shift, axis=1), np.roll(valid, shift, axis=1)


def colour_map(path, width, tint, seamed):
    img, valid = read_global(path, width)
    valid &= img.max(axis=2) > 0.5
    if seamed:
        img = blend_seam(img, width // 32)
    img = fill_gaps(img, valid)
    if img.shape[2] == 1 or tint:
        grey = img[..., 0] if img.shape[2] == 1 else img[..., :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        lin = srgb_to_linear(grey).astype(np.float32)
        lin = lin / lin[valid].mean() * 0.25
        t = srgb_to_linear(hex_rgb(tint))
        rgb = linear_to_srgb(lin[..., None] * (t / t.max())[None, None, :].astype(np.float32))
    else:
        rgb = img[..., :3]
    return rgb.astype(np.float32), float(valid.mean())


def feathered(h, valid, cells_per_km):
    """Heights where the model is valid, fading over FEATHER_KM into 0 (the ellipsoid)."""
    from scipy.ndimage import distance_transform_edt

    if valid.all():
        return h
    alpha = np.clip(distance_transform_edt(valid) / (FEATHER_KM * cells_per_km), 0, 1)
    alpha = alpha * alpha * (3 - 2 * alpha)
    return np.where(valid, h, 0) * alpha


def height_map(path, width, reference, R_ref_km, radii):
    """Heights (m) above the sphere of radius R_ref_km on the global grid."""
    import rasterio

    with rasterio.open(path) as d:
        width = min(width, 1 << int(math.log2(d.width) + 0.5))
        R_model = float(re.search(r"\+R=([\d.]+)", d.crs.to_proj4()).group(1)) / 1000
        scale, offset = d.scales[0], d.offsets[0]
    h, valid = read_global(path, width)
    h = h[..., 0] * scale + offset
    valid &= np.abs(h) < 1e7
    lats = 90 - (np.arange(width // 2) + 0.5) * 360 / width
    lons = -180 + (np.arange(width) + 0.5) * 360 / width
    LON, LAT = np.meshgrid(lons, lats)
    ell = (ellipsoid_radius(radii, LON, LAT) - R_ref_km) * 1000
    if reference == "radius":
        rel = h - R_ref_km * 1000 - ell
    elif reference == "sphere":
        rel = h + (R_model - R_ref_km) * 1000 - ell
    else:  # above the ellipsoid
        rel = h
    cells_per_km = width / (2 * math.pi * R_ref_km)
    return feathered(rel, valid, cells_per_km) + ell, float(valid.mean())


def build_world(data, out, layers, world):
    name, body, mosaic, tint, clevel, dem, csource, hsource = world
    radii = iau_radii(body)
    R = round(float(np.cbrt(radii[0] * radii[1] * radii[2])), 3) if dem is None or dem[1] == "ellipsoid" else None
    if R is None:
        import rasterio
        with rasterio.open(os.path.join(data, dem[0] + ".tif")) as d:
            R = round(float(re.search(r"\+R=([\d.]+)", d.crs.to_proj4()).group(1)) / 1000, 3)
    all_tiles = lambda top: [(l, x, y) for l in range(top + 1) for y in range(2**l) for x in range(2 ** (l + 1))]

    width = IMAGE * 2 ** (clevel + 1)
    rgb, coverage = colour_map(os.path.join(data, mosaic + ".tif"), width, tint, name in SEAMED)
    cpyr = Pyramid(rgb)

    def make_c(level, x, y):
        lons, lats = pixel_centres(level, x, y)
        return encode_jpeg(cpyr.raster(tile_size(level) / IMAGE).sample(lons, lats))

    layers[f"{name}-color"] = write_layer(out, {
        "id": f"{name}-color", "body": body, "kind": "color", "bbox": [-180, -90, 180, 90], "levels": [0, clevel],
        "source": csource,
    }, all_tiles(clevel), make_c)
    # Mean linear colour as stored (JPEG round trip of a level-2 sample is close enough).
    sample = cpyr.raster(tile_size(2) / IMAGE).data
    mean = [round(float(v), 5) for v in srgb_to_linear(np.clip(sample, 0, 255)).reshape(-1, 3).mean(axis=0)]

    if dem is not None:
        hfile, reference, hlevel = dem
        heights, hcov = height_map(os.path.join(data, hfile + ".tif"), (GRID - 1) * 2 ** (hlevel + 2), reference, R, radii)
    else:
        hlevel, hcov = 2, 0.0
        lats = 90 - (np.arange(512) + 0.5) * 360 / 1024
        lons = -180 + (np.arange(1024) + 0.5) * 360 / 1024
        LON, LAT = np.meshgrid(lons, lats)
        heights = ((ellipsoid_radius(radii, LON, LAT) - R) * 1000).astype(np.float32)
        hsource = "IAU triaxial ellipsoid (pck00011); no global elevation model"
    hpyr = Pyramid(heights)
    unit, offset = height_scale(float(heights.min()) - 100, float(heights.max()) + 100)

    def make_h(level, x, y):
        lons, lats = grid_points(level, x, y)
        return encode_heights(hpyr.raster(tile_size(level) / (GRID - 1)).sample(lons, lats), unit, offset)

    layers[f"{name}-height"] = write_layer(out, {
        "id": f"{name}-height", "body": body, "kind": "height", "bbox": [-180, -90, 180, 90], "levels": [0, hlevel],
        "source": hsource, "heightUnit": unit, "heightOffset": offset,
    }, all_tiles(hlevel), make_h)
    info = {"body": body, "name": name, "radius": R, "mean": mean, "colourCoverage": round(coverage, 3), "heightCoverage": round(hcov, 3)}
    print(info)
    return info


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    parser.add_argument("out")
    parser.add_argument("manifest")
    parser.add_argument("--only", help="comma-separated world names")
    args = parser.parse_args()
    only = set(args.only.split(",")) if args.only else None
    manifest = json.load(open(args.manifest))
    layers = {l["id"]: l for l in manifest["layers"]}
    worlds = {w["body"]: w for w in manifest.get("worlds", [])}
    for world in WORLDS:
        if only and world[0] not in only:
            continue
        info = build_world(args.data, args.out, layers, world)
        worlds[info["body"]] = info
    manifest["layers"] = list(layers.values())
    order = [w[1] for w in WORLDS]
    manifest["worlds"] = sorted(worlds.values(), key=lambda w: order.index(w["body"]))
    with open(args.manifest, "w") as f:
        json.dump(manifest, f, indent=1)
    print(f"wrote {args.manifest}")


if __name__ == "__main__":
    main()
