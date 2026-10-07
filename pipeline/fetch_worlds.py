"""Download the global mosaics and elevation models build_worlds.py turns into tiles.

Usage:
    python pipeline/fetch_worlds.py DATA_DIR

Every file is a USGS Astrogeology global product (about 6.6 GB in all; Mercury's
250 m mosaic alone is 1.9 GB), with its ISIS label where one exists, which says
which way longitude runs.
"""

import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from build_worlds import EXTRA, WORLDS  # noqa: E402

USGS = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/"
# Titan's elevation model (Corlies et al. 2017) is not a USGS product: the Hayes
# Research Group's archive at Cornell, unzipped next to the others.
TITAN_TOPO = "https://data.astro.cornell.edu/titan_topo_corlies/titan_topo_corlies.zip"
# Files not at the top of the mosaic directory.
SUBDIRS = {"enceladus_2019pm_radius": "Enceladus/enceladus_cassini_iss_shapemodel_bland_2019/"}


def download(url, path, optional=False):
    if os.path.exists(path):
        return
    print(f"downloading {url}")
    result = subprocess.run(["curl", "-sSfL", "--retry", "5", "-o", path + ".part", url])
    if result.returncode:
        if optional:
            return
        raise SystemExit(f"failed: {url}")
    os.replace(path + ".part", path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    d = parser.parse_args().data
    os.makedirs(d, exist_ok=True)
    for world in WORLDS:
        names = [world[2]] + ([world[5][0]] if world[5] else []) + ([EXTRA[world[0]]["roughness"]] if "roughness" in EXTRA.get(world[0], {}) else [])
        for name in names:
            if name == "topo_4PPD_interp":
                if not os.path.exists(os.path.join(d, name + ".cub")):
                    zpath = os.path.join(d, "titan_topo_corlies.zip")
                    download(TITAN_TOPO, zpath)
                    import zipfile
                    with zipfile.ZipFile(zpath) as z:
                        member = next(m for m in z.namelist() if m.endswith(name + ".cub") and "__MACOSX" not in m)
                        with z.open(member) as src, open(os.path.join(d, name + ".cub"), "wb") as dst:
                            dst.write(src.read())
                continue
            base = USGS + SUBDIRS.get(name, "") + name
            download(base + ".tif", os.path.join(d, name + ".tif"))
            download(base + ".lbl", os.path.join(d, name + ".lbl"), optional=True)


if __name__ == "__main__":
    main()
