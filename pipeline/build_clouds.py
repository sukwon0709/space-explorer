"""Turn one hour of NOAA's GMGSI longwave-infrared mosaic into a cloud cover map.

GMGSI blends GOES, Himawari and Meteosat 10.3-11 micron images into one global grid
(about 8 km, 72.7 S to 72.7 N, hourly, on a Mercator-spaced grid). Clouds are colder than the ground beneath
them, so they are brighter in this scaled brightness temperature. Cover is estimated
per pixel from how much colder than the clear-sky background of its latitude band it
is. Infrared misses warm, low cloud and fog; that limitation is part of the data.

Usage:
    python pipeline/build_clouds.py DATA_DIR/gmgsi_lw_2026-10-05T04.nc public/data/clouds.png src/generated/clouds.json
"""

import argparse
import json
import os
from datetime import datetime, timezone

import netCDF4
import numpy as np
from PIL import Image

WIDTH, HEIGHT = 4096, 2048


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source")
    parser.add_argument("out")
    parser.add_argument("meta")
    args = parser.parse_args()

    d = netCDF4.Dataset(args.source)
    v = np.asarray(d["data"][0], dtype=np.float32)
    lat = np.asarray(d["lat"][:, 0], dtype=np.float64)
    lons = np.asarray(d["lon"][0, :], dtype=np.float64)
    lon_step = 360.0 / lons.size
    lon0 = lons[1] - lon_step  # column 0 sits at +180, the date line
    t = datetime.fromtimestamp(int(d["time"][0]), tz=timezone.utc)
    missing = (v < 0) | (v >= 254)  # fill value and saturated no-data patches

    # Clear-sky background per row: a low percentile of that latitude's values.
    masked = np.where(missing, np.nan, v)
    background = np.nanpercentile(masked, 20, axis=1)[:, None]
    cover = np.clip((masked - background - 18) / 70, 0, 1)
    cover = np.nan_to_num(cover, nan=0.0)

    # Resample onto the global equirectangular grid (pixel centres), nearest neighbour.
    # GMGSI rows are on a Mercator-like latitude spacing, so rows are looked up from `lat`.
    out_lat = 90 - (np.arange(HEIGHT) + 0.5) * 180 / HEIGHT
    out_lon = -180 + (np.arange(WIDTH) + 0.5) * 360 / WIDTH
    inside = (out_lat <= lat[0]) & (out_lat >= lat[-1])
    rows = np.round(np.interp(-out_lat[inside], -lat, np.arange(lat.size))).astype(int)
    cols = np.round(((out_lon - lon0) % 360) / lon_step).astype(int) % v.shape[1]
    img = np.zeros((HEIGHT, WIDTH), np.float32)
    img[inside] = cover[rows][:, cols]
    # Fade out toward the mosaic's latitude limits.
    fade = np.clip((72.5 - np.abs(out_lat)) / 4, 0, 1)[:, None]
    img *= fade

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    Image.fromarray((img * 255 + 0.5).astype(np.uint8), "L").save(args.out, optimize=True)
    with open(args.meta, "w") as f:
        json.dump({"time": t.strftime("%Y-%m-%dT%H:%MZ"), "source": "NOAA GMGSI longwave infrared (GOES, Himawari, Meteosat)"}, f)
    print(f"wrote {args.out} ({os.path.getsize(args.out) / 1e6:.1f} MB) for {t}")


if __name__ == "__main__":
    main()
