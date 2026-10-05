"""Download the star catalogues the star octree is built from.

Usage:
    python pipeline/fetch_stars.py DATA_DIR

Writes into DATA_DIR/stars/:
  gaia-*.csv          Gaia DR3 (ESA/Gaia/DPAC 2023): every source brighter than G = 12, and
                      every source with a parallax above 10 mas measured to better than
                      10% (the 100 pc neighbourhood), with Bailer-Jones et al. (2021)
                      geometric and photogeometric distances joined in
  hip-gaia.csv        Gaia DR3's Hipparcos-2 best-neighbour crossmatch
  xhip.csv            XHIP (Anderson & Francis 2012, VizieR V/137D): Hipparcos new
                      reduction astrometry with radial velocities, V and B-V, star names
  hip_main.csv        the original Hipparcos catalogue (ESA 1997, VizieR I/239), used only
                      by the sky gate test as an independent check
  tycho2.csv          Tycho-2 (Hog et al. 2000, VizieR I/259) BT and VT for stars in the
                      gate's test fields
  constellations.json Stellarium's modern (IAU/Sky & Telescope) constellation figures
  exoplanets.csv      NASA Exoplanet Archive planetary systems composite parameters
  gaia-hosts.csv      Gaia DR3 rows for exoplanet hosts fainter than the main selection
  mamajek.txt         Pecaut and Mamajek (2013, version 2022.04.16) dwarf colour and
                      temperature sequence, for star colours
"""

import argparse
import os
import time
import urllib.parse
import urllib.request

GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap"
VIZIER_TAP = "https://tapvizier.cds.unistra.fr/TAPVizieR/tap"
EXO_TAP = "https://exoplanetarchive.ipac.caltech.edu/TAP"
MAMAJEK = "https://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt"
STELLARIUM = "https://raw.githubusercontent.com/Stellarium/stellarium/v25.3/skycultures/modern/index.json"

GAIA_COLUMNS = (
    "g.source_id, g.ra, g.dec, g.parallax, g.parallax_error, g.pmra, g.pmdec, g.radial_velocity, "
    "g.phot_g_mean_mag, g.bp_rp, g.teff_gspphot, g.ag_gspphot, g.ebpminrp_gspphot, d.r_med_geo, d.r_med_photogeo"
)
GAIA_FROM = "gaiadr3.gaia_source AS g LEFT OUTER JOIN external.gaiaedr3_distance AS d ON g.source_id = d.source_id"
# Split so each asynchronous job stays well under the archive's row limit.
GAIA_PARTS = {
    "gaia-g10": "g.phot_g_mean_mag < 10",
    "gaia-g11": "g.phot_g_mean_mag >= 10 AND g.phot_g_mean_mag < 11",
    "gaia-g115": "g.phot_g_mean_mag >= 11 AND g.phot_g_mean_mag < 11.5",
    "gaia-g12": "g.phot_g_mean_mag >= 11.5 AND g.phot_g_mean_mag < 12",
    "gaia-near": "(g.phot_g_mean_mag >= 12 OR g.phot_g_mean_mag IS NULL) AND g.parallax > 10 AND g.parallax_over_error > 10",
}


def download(url: str, path: str, data: dict | None = None) -> str:
    if os.path.exists(path):
        return path
    print(f"downloading {url}")
    body = urllib.parse.urlencode(data).encode() if data else None
    tmp = path + ".part"
    with urllib.request.urlopen(urllib.request.Request(url, data=body), timeout=3600) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(tmp, path)
    return path


def tap_async(base: str, query: str, path: str) -> str:
    """Run an ADQL query as an asynchronous TAP job and save the CSV result."""
    if os.path.exists(path):
        return path
    data = urllib.parse.urlencode({"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "PHASE": "RUN", "QUERY": query}).encode()
    with urllib.request.urlopen(urllib.request.Request(base + "/async", data=data), timeout=120) as r:
        job = r.geturl()
    print(f"{os.path.basename(path)}: job {job}")
    while True:
        phase = urllib.request.urlopen(job + "/phase", timeout=120).read().decode().strip()
        if phase == "COMPLETED":
            break
        if phase in ("ERROR", "ABORTED"):
            error = urllib.request.urlopen(job, timeout=120).read().decode()
            raise RuntimeError(f"{path}: {phase}\n{error[:2000]}")
        time.sleep(10)
    return download(job + "/results/result", path)


def tap_sync(base: str, query: str, path: str) -> str:
    return download(base + "/sync", path, {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    args = parser.parse_args()
    d = os.path.join(args.data, "stars")
    os.makedirs(d, exist_ok=True)

    for name, where in GAIA_PARTS.items():
        tap_async(GAIA_TAP, f"SELECT {GAIA_COLUMNS} FROM {GAIA_FROM} WHERE {where}", os.path.join(d, f"{name}.csv"))
    tap_async(GAIA_TAP, "SELECT source_id, original_ext_source_id AS hip, angular_distance FROM gaiadr3.hipparcos2_best_neighbour",
              os.path.join(d, "hip-gaia.csv"))

    tap_sync(VIZIER_TAP, 'SELECT HIP, Comp, RAJ2000, DEJ2000, Plx, e_Plx, pmRA, pmDE, Dist, RV, "Vmag", "B-V", "Hpmag", SpType, Name, Cst, HD '
             'FROM "V/137D/XHIP"', os.path.join(d, "xhip.csv"))
    tap_sync(VIZIER_TAP, 'SELECT HIP, Vmag, RAICRS, DEICRS, Plx, pmRA, pmDE, "B-V", BTmag, VTmag, Hpmag, MultFlag FROM "I/239/hip_main"',
             os.path.join(d, "hip_main.csv"))
    # Tycho-2 in the gate's test fields (Orion, Pleiades, Crux, Cygnus), for the faint-end magnitude check.
    fields = [(83.8, -5.4, 6), (56.75, 24.12, 3), (186.6, -60.0, 5), (305.0, 40.0, 5)]
    where = " OR ".join(f"1=CONTAINS(POINT('ICRS', RAmdeg, DEmdeg), CIRCLE('ICRS', {ra}, {dec}, {r}))" for ra, dec, r in fields)
    tap_sync(VIZIER_TAP, f'SELECT TYC1, TYC2, TYC3, RAmdeg, DEmdeg, pmRA, pmDE, BTmag, VTmag, HIP FROM "I/259/tyc2" WHERE {where}',
             os.path.join(d, "tycho2.csv"))

    download(STELLARIUM, os.path.join(d, "constellations.json"))
    tap_sync(EXO_TAP, "SELECT pl_name, hostname, gaia_dr3_id, hip_name, hd_name, sy_snum, sy_pnum, pl_letter, discoverymethod, disc_year, "
             "pl_orbper, pl_orbsmax, pl_orbeccen, pl_orbincl, pl_rade, pl_bmasse, pl_eqt, st_teff, st_rad, st_mass, sy_dist, ra, dec, sy_vmag, sy_gaiamag "
             "FROM pscomppars", os.path.join(d, "exoplanets.csv"))
    gaia_hosts(d)
    download(MAMAJEK, os.path.join(d, "mamajek.txt"))


def gaia_hosts(d: str) -> None:
    """Gaia DR3 rows for every exoplanet host, so faint hosts can be added to the octree."""
    path = os.path.join(d, "gaia-hosts.csv")
    if os.path.exists(path):
        return
    import csv

    ids = sorted({r["gaia_dr3_id"].split()[-1] for r in csv.DictReader(open(os.path.join(d, "exoplanets.csv"))) if r["gaia_dr3_id"].startswith("Gaia DR3")})
    parts = []
    for k in range(0, len(ids), 400):
        part = os.path.join(d, f"gaia-hosts.{k}.csv")
        tap_sync(GAIA_TAP, f"SELECT {GAIA_COLUMNS} FROM {GAIA_FROM} WHERE g.source_id IN ({', '.join(ids[k : k + 400])})", part)
        parts.append(part)
    with open(path, "w") as out:
        for k, part in enumerate(parts):
            lines = open(part).read().splitlines(keepends=True)
            out.writelines(lines if k == 0 else lines[1:])
            os.remove(part)


if __name__ == "__main__":
    main()
