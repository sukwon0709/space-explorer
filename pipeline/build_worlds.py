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
import zlib

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
    # The two worlds whose ground no camera in orbit can see. Their maps are radar
    # (Venus) and near-infrared through the haze (Titan); see VENUS and TITAN below.
    ("venus", 299, "Venus_Magellan_C3-MDIR_Global_Mosaic_2025m", "#6f655c", 5,
     ("Venus_Magellan_Topography_Global_4641m_v02", "sphere", 5),
     "Magellan SAR C3-MDIR mosaic 2 km (NASA/JPL, USGS), as surface texture",
     "Magellan altimetry 4.6 km (NASA/JPL, USGS)"),
    ("titan", 606, "Titan_ISS_P19658_Mosaic_Global_4km", "#8a6a48", 3,
     ("topo_4PPD_interp", "sphere", 4),
     "Cassini ISS 938 nm mosaic 4 km (NASA/JPL/SSI, USGS)",
     "Cassini radar topography, interpolated (Corlies et al. 2017)"),
]

# Surfaces seen through thick atmospheres. The maps are not pictures in visible light:
# Magellan's radar brightness says how rough the ground is at 12 cm, and Cassini's
# 938 nm images see through Titan's haze in a narrow window. So their contrast is
# reduced (`contrast`, a power on brightness about the mean) and the colour and albedo
# come from the landers: Venera 13/14 colour images corrected for the orange light under
# the clouds (Pieters et al. 1986: a dark surface, reflectance about 0.1, rising to the
# red), and Huygens DISR spectra of the ground at its landing site (Tomasko et al.
# 2005: reflectance about 0.1 in green rising to 0.2 in the near infrared).
# Magellan missed about 8% of Venus in strips; they are filled from the ground around
# them (`fill`: inpaint), not left as flat bands.
# `relief` maps (public/data/relief/NAME.png) steer the detail the app computes below
# the resolution of the elevation models: red is roughness, green is where dunes are.
EXTRA = {
    "venus": {"albedo": 0.1, "color": "#6f655c", "contrast": 0.45, "atmosphere": "venus", "fill": "inpaint",
              "roughness": "Venus_Magellan_MeterScaleSlope_Global_4641m"},
    "titan": {"albedo": 0.13, "color": "#80705c", "contrast": 0.4, "atmosphere": "titan", "seas": True},
}

# Mosaics whose left and right edges do not match in brightness (build_maps.SEAMED).
SEAMED = {"phobos"}
# Elevation models without a label of their own: their longitudes run east.
POSITIVE_EAST = {"enceladus_2019pm_radius", "topo_4PPD_interp"}


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


def pull_push(img, valid):
    """Fill invalid cells smoothly from the valid ones around them: average down a
    pyramid counting only valid cells, then fill each level's holes from the coarser one."""
    img = img.astype(np.float32)
    w = valid.astype(np.float32)
    if img.ndim == 2:
        img = img[..., None]
    levels = [(img * w[..., None], w)]
    while min(levels[-1][1].shape) > 2:
        a, b = levels[-1]
        H, W = (b.shape[0] // 2) * 2, (b.shape[1] // 2) * 2
        a, b = a[:H, :W], b[:H, :W]
        levels.append((a.reshape(H // 2, 2, W // 2, 2, -1).sum((1, 3)), b.reshape(H // 2, 2, W // 2, 2).sum((1, 3))))
    filled = levels[-1][0] / np.maximum(levels[-1][1], 1e-6)[..., None]
    for a, b in reversed(levels[:-1]):
        from scipy.ndimage import zoom

        up = zoom(filled, (b.shape[0] / filled.shape[0], b.shape[1] / filled.shape[1], 1), order=1, mode="nearest", grid_mode=True)
        k = np.clip(b, 0, 1)[..., None]
        filled = np.where(b[..., None] > 0, a / np.maximum(b, 1e-6)[..., None], up) * k + up * (1 - k)
    return filled


def inpaint(img, valid):
    """Fill gaps in a mosaic with something that looks like its surroundings: the smooth
    fill of pull_push plus fine detail copied from nearby valid ground (displaced
    sideways, since Magellan's gaps are north-south strips)."""
    from scipy.ndimage import gaussian_filter

    from scipy.ndimage import binary_erosion

    img = img.astype(np.float32)
    squeeze = img.ndim == 2
    if squeeze:
        img = img[..., None]
    # Pixels at the edge of a gap are often part-filled: treat them as missing too.
    valid = binary_erosion(valid, iterations=2, border_value=1)
    base = pull_push(img, valid)
    smooth = np.stack([gaussian_filter(np.where(valid, img[..., c], base[..., c]), 3, mode="wrap") for c in range(img.shape[2])], -1)
    detail = np.where(valid[..., None], img - smooth, 0)
    fill = np.zeros_like(img)
    have = np.zeros(valid.shape, bool)
    for dx in (41, -53, 97, -131, 197, -263):
        moved = np.roll(detail, dx, axis=1)
        ok = np.roll(valid, dx, axis=1) & ~have
        fill[ok] = moved[ok]
        have |= ok
    out = np.where(valid[..., None], img, base + fill)
    return out[..., 0] if squeeze else out


def colour_map(path, width, tint, seamed, contrast=1.0, fill="rows"):
    img, valid = read_global(path, width)
    valid &= img.max(axis=2) > (6 if fill == "inpaint" else 0.5)
    if fill == "inpaint":
        # Magellan's mosaic also has thin dark lines where orbit strips meet: pixels far
        # darker than the ground around them are treated as gaps.
        from scipy.ndimage import median_filter

        grey = img.mean(axis=2)
        valid &= grey > 0.6 * median_filter(grey, size=9, mode="wrap")
    if seamed:
        img = blend_seam(img, width // 32)
    img = inpaint(img, valid) if fill == "inpaint" else fill_gaps(img, valid)
    if img.shape[2] == 1 or tint:
        grey = img[..., 0] if img.shape[2] == 1 else img[..., :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        lin = srgb_to_linear(grey).astype(np.float32)
        lin = lin / lin[valid].mean()
        if contrast != 1.0:
            lin = np.power(np.maximum(lin, 1e-4), contrast)
            lin = lin / lin[valid].mean()
        lin = lin * 0.25
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


def height_map(path, width, reference, R_ref_km, radii, fill="feather"):
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
    if fill == "inpaint":
        return inpaint(np.where(valid, rel, 0), valid) + ell, float(valid.mean())
    return feathered(rel, valid, cells_per_km) + ell, float(valid.mean())


def raster_path(data, name):
    """A product's file: the GeoTIFF, or the ISIS cube some come as."""
    tif = os.path.join(data, name + ".tif")
    return tif if os.path.exists(tif) else os.path.join(data, name + ".cub")


def seas(heights, body, data):
    """Titan's seas and large lakes: inside each named mare or lacus (IAU Gazetteer
    extents), ground below its level is liquid, and lies flat at that level. The level
    is the 30th percentile of the ground in the feature's box: the interpolated
    elevation model smooths the shores, so the sea fills the lower part of its basin."""
    from build_features import read_dbf

    h = heights.copy()
    water = np.zeros(h.shape, bool)
    rows = [r for r in read_dbf(os.path.join(data, "names", "TITAN_nomenclature_center_pts.dbf"))
            if r["approval"] == "Adopted by IAU" and r["type"].split(",")[0] in ("Mare", "Lacus")]
    H, W = h.shape
    n = 0
    for r in rows:
        try:
            la0, la1 = sorted((float(r["min_lat"]), float(r["max_lat"])))
            lo0, lo1 = float(r["min_lon"]), float(r["max_lon"])
        except ValueError:
            continue
        if float(r["diameter"] or 0) < 20:
            continue
        j0, j1 = int((90 - la1) / 180 * H), int(np.ceil((90 - la0) / 180 * H))
        lo0, lo1 = (lo0 + 180) % 360 - 180, (lo1 + 180) % 360 - 180
        i0, i1 = int((lo0 + 180) / 360 * W), int(np.ceil((lo1 + 180) / 360 * W))
        cols = np.arange(i0, i1 if i1 >= i0 else i1 + W) % W
        box = h[j0:j1 + 1][:, cols]
        if box.size == 0:
            continue
        level = np.percentile(box, 30)
        wet = box <= level
        sub = h[j0:j1 + 1]
        part = sub[:, cols]
        part[wet] = level
        sub[:, cols] = part
        wsub = water[j0:j1 + 1]
        wpart = wsub[:, cols]
        wpart |= wet
        wsub[:, cols] = wpart
        n += 1
    print(f"titan: {n} seas and lakes, {water.mean() * 100:.2f}% of the surface")
    return h, water


def relief_map(name, rgb_path, extra, data, out_dir):
    """A 1024 x 512 map steering the detail the app computes: red is roughness (0-1),
    green is dune cover (0-1)."""
    W, H = 1024, 512
    lats = 90 - (np.arange(H) + 0.5) * 180 / H
    rough = np.full((H, W), 0.5, np.float32)
    dunes = np.zeros((H, W), np.float32)
    if "roughness" in extra:
        # Magellan's RMS slope at metre scales (degrees): plains about 3, the roughest
        # lava flows and tesserae 10 and more.
        s, valid = read_global(raster_path(data, extra["roughness"]), W)
        s = s[..., 0]
        valid &= (s > 0) & (s < 60)
        s = fill_gaps(s[..., None], valid)[..., 0]
        rough = np.clip((s - 1.5) / 10.0, 0, 1)
    if name == "titan":
        # The dark equatorial belts in the 938 nm mosaic are the dune seas (Lorenz et
        # al. 2006; Rodriguez et al. 2014): between 30 S and 30 N, where the ground is
        # well below the mean brightness. Bright highlands (Xanadu) are rougher.
        img, valid = read_global(rgb_path, W)
        g = srgb_to_linear(img[..., 0])
        g = g / g[valid & (np.abs(lats)[:, None] < 30)].mean()
        from scipy.ndimage import gaussian_filter

        band = (np.abs(lats) < 30)[:, None] * np.clip((np.abs(lats)[:, None] - 30) / -5, 0, 1)
        dunes = np.clip((0.85 - gaussian_filter(g, 1.5)) / 0.3, 0, 1) * band
        rough = np.clip(0.25 + 0.5 * (gaussian_filter(g, 2) - 0.8), 0.1, 0.9).astype(np.float32)
    os.makedirs(out_dir, exist_ok=True)
    img = np.zeros((H, W, 3), np.uint8)
    img[..., 0] = np.round(rough * 255)
    img[..., 1] = np.round(dunes * 255)
    path = os.path.join(out_dir, f"{name}.png")
    Image.fromarray(img).save(path, optimize=True)
    print(f"{path}: dunes cover {dunes.mean() * 100:.1f}%")


def build_world(data, out, layers, world):
    name, body, mosaic, tint, clevel, dem, csource, hsource = world
    extra = EXTRA.get(name, {})
    radii = iau_radii(body)
    R = round(float(np.cbrt(radii[0] * radii[1] * radii[2])), 3) if dem is None or dem[1] == "ellipsoid" else None
    if R is None:
        import rasterio
        with rasterio.open(raster_path(data, dem[0])) as d:
            R = round(float(re.search(r"\+R=([\d.]+)", d.crs.to_proj4()).group(1)) / 1000, 3)
    all_tiles = lambda top: [(l, x, y) for l in range(top + 1) for y in range(2**l) for x in range(2 ** (l + 1))]

    width = IMAGE * 2 ** (clevel + 1)
    rgb, coverage = colour_map(raster_path(data, mosaic), width, tint, name in SEAMED, extra.get("contrast", 1.0), extra.get("fill", "rows"))
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

    water = None
    if dem is not None:
        hfile, reference, hlevel = dem
        heights, hcov = height_map(raster_path(data, hfile), (GRID - 1) * 2 ** (hlevel + 2), reference, R, radii, "inpaint" if extra.get("fill") == "inpaint" else "feather")
        if extra.get("seas"):
            heights, water = seas(heights, body, data)
    else:
        hlevel, hcov = 2, 0.0
        lats = 90 - (np.arange(512) + 0.5) * 360 / 1024
        lons = -180 + (np.arange(1024) + 0.5) * 360 / 1024
        LON, LAT = np.meshgrid(lons, lats)
        heights = ((ellipsoid_radius(radii, LON, LAT) - R) * 1000).astype(np.float32)
        hsource = "IAU triaxial ellipsoid (pck00011); no global elevation model"
    hpyr = Pyramid(heights)
    wpyr = Pyramid(water.astype(np.float32)) if water is not None else None
    unit, offset = height_scale(float(heights.min()) - 100, float(heights.max()) + 100)

    def make_h(level, x, y):
        lons, lats = grid_points(level, x, y)
        h = hpyr.raster(tile_size(level) / (GRID - 1)).sample(lons, lats)
        if wpyr is None:
            return encode_heights(h, unit, offset)
        wet = wpyr.raster(tile_size(level) / (GRID - 1)).sample(lons, lats) > 0.5
        q = np.clip(np.round((h - offset) / unit), -32768, 32767).astype(np.int32) & ~1
        return zlib.compress((q | wet.astype(np.int32)).astype("<i2").tobytes(), 9)

    layers[f"{name}-height"] = write_layer(out, {
        "id": f"{name}-height", "body": body, "kind": "height", "bbox": [-180, -90, 180, 90], "levels": [0, hlevel],
        "source": hsource, "heightUnit": unit, "heightOffset": offset,
    }, all_tiles(hlevel), make_h)
    info = {"body": body, "name": name, "radius": R, "mean": mean, "colourCoverage": round(coverage, 3), "heightCoverage": round(hcov, 3)}
    for key in ("albedo", "color", "atmosphere"):
        if key in extra:
            info[key] = extra[key]
    if extra:
        relief_map(name, raster_path(data, mosaic), extra, data, os.path.join(out, "..", "relief"))
        info["relief"] = True
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
