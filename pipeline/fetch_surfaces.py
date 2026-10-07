"""Download the Mars and landing-site datasets build_surfaces.py turns into tiles.

Usage:
    python pipeline/fetch_surfaces.py DATA_DIR

Mars (global)
    MGS MOLA MEGDR at 32 pixels per degree (PDS Geosciences Node): planetary radius
    (megr) and topography above the areoid (megt), so radius - topography is the areoid.
    Viking MDIM 2.1 colour mosaic (USGS), as NASA Trek serves it in the same geographic
    tiling the app uses; level 5 (16384 x 8192) is assembled into one image.

Tranquility Base (Apollo 11)
    LRO NAC DTM NAC_DTM_APOLLO11 (2 m posts) and its 0.5 m orthophoto M150361817
    (LROC, Arizona State University).

Jezero crater (Perseverance, Octavia E. Butler Landing)
    Mars 2020 Terrain Relative Navigation maps (USGS, Fergason et al. 2020): the CTX
    20 m DTM and 6 m orthomosaic of the crater, and windows of the HiRISE 1 m DTM and
    25 cm orthomosaic around the landing site, read with HTTP range requests (the full
    files are 1.8 and 7.4 GB).
"""

import argparse
import concurrent.futures as cf
import io
import os
import subprocess
import urllib.request

import numpy as np
from PIL import Image

MOLA = "https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg032/"
TREK = "https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm"
LROC = "https://pds.lroc.asu.edu/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/DATA/SDP/NAC_DTM/APOLLO11/"
TRN = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/"

# Perseverance's landing site (NASA/JPL), planetocentric, and the HiRISE window around it.
JEZERO_SITE = (18.4447, 77.4508)
HIRISE_HALF_M = 2200
MARS_SPHERE_M = 3396190.0  # the TRN maps' equirectangular projection sphere


def download(url: str, path: str):
    if os.path.exists(path):
        return
    print(f"downloading {url}")
    subprocess.run(["curl", "-sSfL", "--retry", "5", "-o", path + ".part", url], check=True)
    os.replace(path + ".part", path)


def viking_mosaic(path: str, level: int = 5):
    if os.path.exists(path):
        return
    out = np.zeros((256 * 2**level, 256 * 2 ** (level + 1), 3), np.uint8)

    def get(xy):
        x, y = xy
        for attempt in range(5):
            try:
                data = urllib.request.urlopen(f"{TREK}/{level}/{y}/{x}.jpg", timeout=60).read()
                return x, y, np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))
            except Exception as err:  # retried
                last = err
        raise last

    with cf.ThreadPoolExecutor(24) as ex:
        for x, y, img in ex.map(get, [(x, y) for y in range(2**level) for x in range(2 ** (level + 1))]):
            out[y * 256:(y + 1) * 256, x * 256:(x + 1) * 256] = img
    Image.fromarray(out).save(path, quality=95)


def hirise_window(url: str, path: str, pixel_m: float):
    """A square window of a TRN map centred on the landing site, saved as .npy."""
    if os.path.exists(path):
        return
    import rasterio
    from rasterio.windows import Window

    lat, lon = JEZERO_SITE
    x = MARS_SPHERE_M * np.radians(lon)
    y = MARS_SPHERE_M * np.radians(lat)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MULTIRANGE="YES", GDAL_HTTP_MAX_RETRY=5):
        with rasterio.open("/vsicurl/" + url) as d:
            col, row = ~d.transform * (x, y)
            half = int(HIRISE_HALF_M / pixel_m)
            win = Window(int(col) - half, int(row) - half, 2 * half, 2 * half)
            data = d.read(1, window=win)
            t = d.window_transform(win)
            nodata = d.nodata
    np.save(path, data)
    with open(path + ".json", "w") as f:
        import json
        json.dump({"transform": list(t)[:6], "nodata": nodata, "sphere_m": MARS_SPHERE_M}, f)
    print(f"{path}: {data.shape}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    d = parser.parse_args().data
    os.makedirs(d, exist_ok=True)
    for name in ["megr90n000fb.img", "megt90n000fb.img"]:
        download(MOLA + name, os.path.join(d, name))
    viking_mosaic(os.path.join(d, "viking_mdim21_l5.jpg"))
    for name in ["NAC_DTM_APOLLO11.TIF", "NAC_DTM_APOLLO11_M150361817_50CM.IMG"]:
        download(LROC + name, os.path.join(d, name))
    for name in ["JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0.tif", "JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0.tif"]:
        download(TRN + "CTX/" + name, os.path.join(d, name))
    hirise_window(TRN + "HiRISE/JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif", os.path.join(d, "jezero_hirise_dtm.npy"), 1.0)
    hirise_window(TRN + "HiRISE/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif", os.path.join(d, "jezero_hirise_ortho.npy"), 0.25)


if __name__ == "__main__":
    main()
