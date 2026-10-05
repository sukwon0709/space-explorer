"""Download the raw datasets the surface tiles are built from.

Usage:
    python pipeline/fetch_sources.py DATA_DIR [--clouds 2026-10-05T04]

Everything here is public-domain or open-licence observational data:

Earth
  NASA Blue Marble: Next Generation (MODIS, 500 m source), via NASA GIBS WMS at 2.4 km per pixel
  NASA Black Marble 2016 (VIIRS day/night band, city lights), via NASA GIBS WMS
  NOAA ETOPO 2022, 60 arc-second surface elevation (land and sea floor)
  MODIS land/water mask (MOD44W), via NASA GIBS, to put oceans at sea level
  EGM96 geoid (NGA), via PROJ's data CDN, to turn sea-level heights into ellipsoidal ones
  NOAA GMGSI global geostationary longwave infrared mosaic (GOES, Himawari, Meteosat)
    for the clouds of one hour
  Grand Canyon showcase: Copernicus Sentinel-2 L2A true colour (10 m, 18 Oct 2025) and
    Copernicus DEM GLO-30 (30 m)
Moon
  LRO LROC WAC colour mosaic and LOLA elevation, from NASA SVS's CGI Moon Kit (SVS 4720)
"""

import argparse
import json
import os
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/"
ETOPO = "https://www.ngdc.noaa.gov/thredds/fileServer/global/ETOPO2022/60s/60s_surface_elev_netcdf/ETOPO_2022_v1_60s_N90W180_surface.nc"
COP_DEM = "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{tile}_00_DEM/Copernicus_DSM_COG_10_{tile}_00_DEM.tif"
STAC_ITEM = "https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/{item}"
GMGSI = "https://noaa-gmgsi-pds.s3.amazonaws.com/"

SENTINEL_ITEM = "S2B_12SUF_20251018_0_L2A"
COP_TILES = ["N36_00_W113", "N36_00_W112"]


def download(url: str, path: str) -> str:
    if os.path.exists(path):
        return path
    print(f"downloading {url}")
    tmp = path + ".part"
    with urllib.request.urlopen(url, timeout=600) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(tmp, path)
    return path


def gibs_mosaic(layer: str, path: str, width: int = 16384, time: str | None = None, block: int = 4096) -> str:
    """Assemble a global equirectangular image from GIBS WMS in blocks."""
    if os.path.exists(path):
        return path
    height = width // 2
    out = Image.new("RGB", (width, height))
    deg = 360 / width
    for y0 in range(0, height, block):
        for x0 in range(0, width, block):
            lon0, lat1 = -180 + x0 * deg, 90 - y0 * deg
            lon1, lat0 = lon0 + block * deg, lat1 - block * deg
            params = {
                "SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": "1.3.0", "LAYERS": layer, "CRS": "EPSG:4326",
                "BBOX": f"{lat0},{lon0},{lat1},{lon1}", "WIDTH": block, "HEIGHT": block, "FORMAT": "image/png",
            }
            if time:
                params["TIME"] = time
            url = GIBS_WMS + "?" + urllib.parse.urlencode(params)
            tmp = path + f".{x0}_{y0}.png"
            download(url, tmp)
            out.paste(Image.open(tmp).convert("RGB"), (x0, y0))
            os.remove(tmp)
    out.save(path, **({"quality": 95} if path.endswith(".jpg") else {}))
    print(f"wrote {path}")
    return path


def gmgsi(hour: str, path: str) -> str:
    """Download the GMGSI longwave-IR mosaic for an hour given as YYYY-MM-DDTHH."""
    if os.path.exists(path):
        return path
    day, hh = hour.split("T")
    prefix = f"GMGSI_LW/{day.replace('-', '/')}/{hh}/"
    with urllib.request.urlopen(GMGSI + "?list-type=2&prefix=" + prefix, timeout=60) as r:
        listing = r.read().decode()
    keys = [k.split("</Key>")[0] for k in listing.split("<Key>")[1:]]
    if not keys:
        raise RuntimeError(f"no GMGSI file for {hour}")
    return download(GMGSI + keys[0], path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    parser.add_argument("--clouds", default="2026-10-05T04", help="UTC hour of the cloud map, YYYY-MM-DDTHH")
    args = parser.parse_args()
    d = args.data
    os.makedirs(d, exist_ok=True)

    gibs_mosaic("BlueMarble_NextGeneration", os.path.join(d, "bmng_16k.jpg"))
    gibs_mosaic("MODIS_Terra_L3_Land_Water_Mask", os.path.join(d, "water_16k.png"))
    gibs_mosaic("VIIRS_Black_Marble", os.path.join(d, "blackmarble2016_16k.jpg"), time="2016-01-01")
    download(ETOPO, os.path.join(d, "etopo60.nc"))
    download("https://cdn.proj.org/us_nga_egm96_15.tif", os.path.join(d, "us_nga_egm96_15.tif"))
    gmgsi(args.clouds, os.path.join(d, f"gmgsi_lw_{args.clouds}.nc"))

    item = json.load(urllib.request.urlopen(STAC_ITEM.format(item=SENTINEL_ITEM), timeout=60))
    download(item["assets"]["visual"]["href"], os.path.join(d, f"{SENTINEL_ITEM}_TCI.tif"))
    for tile in COP_TILES:
        download(COP_DEM.format(tile=tile), os.path.join(d, f"cop30_{tile}.tif"))

    download(SVS + "lroc_color_poles_16k.tif", os.path.join(d, "lroc_color_poles_16k.tif"))
    download(SVS + "ldem_16.tif", os.path.join(d, "ldem_16.tif"))


if __name__ == "__main__":
    main()
