"""Download the catalogues and maps milestone 5 (the Milky Way and beyond) is built from.

Usage:
    python pipeline/fetch_galaxies.py DATA_DIR

Writes into DATA_DIR/galaxies/:
  ungc.tsv        Updated Nearby Galaxy Catalog (Karachentsev et al. 2013, VizieR
                  J/AJ/145/101): the ~870 galaxies within 11 Mpc, most with TRGB,
                  Cepheid or other measured distances
  cf4groups.tsv   Cosmicflows-4 group distances (the same paper's table 3)
  cf4.tsv         Cosmicflows-4 (Tully et al. 2023, VizieR J/ApJ/944/94): distance moduli
                  of 55,877 galaxies (SN Ia, TRGB, Cepheids, SBF, Tully-Fisher,
                  fundamental plane)
  2mrs.tsv        2MASS Redshift Survey (Huchra et al. 2012, VizieR J/ApJS/199/26): 44,599
                  galaxies to K = 11.75 over the whole sky
  6dfgs.tsv       6dF Galaxy Survey (Jones et al. 2009, VizieR VII/259): southern redshifts
  pgc.tsv         HyperLEDA's PGC (Paturel et al. 2003, VizieR VII/237): sizes, axis
                  ratios and position angles
  sdss-*.csv      SDSS DR18 spectroscopic galaxies (SkyServer), in right ascension bands
  harris.tsv      Harris (1996, 2010 edition, VizieR VII/202) Milky Way globular clusters
  sfd-ebv.fits    Schlegel, Finkbeiner and Davis (1998) E(B-V), as a HEALPix map (LAMBDA)
  planck-cmb.fits Planck PR3 SMICA CMB temperature (via CDS hips2fits, Galactic CAR, 2048 x 1024)
"""

import argparse
import os
import sys
import time
import urllib.parse
import urllib.request

VIZIER = "https://vizier.cds.unistra.fr/viz-bin/asu-tsv"
SKYSERVER = "https://skyserver.sdss.org/dr18/SkyServerWS/SearchTools/SqlSearch"
HIPS2FITS = "https://alasky.cds.unistra.fr/hips-image-services/hips2fits"
SFD = "https://lambda.gsfc.nasa.gov/data/foregrounds/SFD/lambda_sfd_ebv.fits"

VIZIER_TABLES = {
    "ungc": ("J/AJ/145/101/catalog", "Name,RAJ2000,DEJ2000,a26,b/a,AB,Bmag,Kmag,TT,HRV,Dist,f_Dist,A26,i,BMag,Vlg,NEDname"),
    "cf4": ("J/ApJ/944/94/table2", "PGC,1PGC,Vcmb,DM,e_DM,DMsnIa,DMtf,DMfp,DMsbf,DMsnII,DMtrgb,DMceph,DMmas,RAJ2000,DEJ2000"),
    "cf4groups": ("J/ApJ/944/94/groups", "1PGC,Ngal,DMzp,e_DMzp,Dist,V3k"),
    "2mrs": ("J/ApJS/199/26/table3", "ID,RAJ2000,DEJ2000,Ktmag,E(B-V),Rext,b/a,type,cz,SimbadName"),
    "6dfgs": ("VII/259/6dfgs", "6dFGS,bJmag,rFmag,S/G,cz,q_cz,RAJ2000,DEJ2000"),
    "pgc": ("VII/237/pgc", "PGC,RAJ2000,DEJ2000,OType,logD25,logR25,PA,ANames"),
    "harris": ("VII/202/catalog", "ID,Name,RAJ2000,DEJ2000,Rsun,E(B-V),Vt,MVt,(B-V)t,c,Rc,Rh"),
}


def download(url: str, path: str, data: dict | None = None) -> str:
    if os.path.exists(path):
        return path
    print(f"downloading {url[:160]}", flush=True)
    body = urllib.parse.urlencode(data).encode() if data else None
    tmp = path + ".part"
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=body), timeout=3600) as r, open(tmp, "wb") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            break
        except OSError as err:
            if attempt == 4:
                raise
            print(f"  retrying after {err}", flush=True)
            time.sleep(10 * 2**attempt)
    os.replace(tmp, path)
    return path


def vizier(source: str, columns: str, path: str) -> None:
    download(VIZIER, path, {"-source": source, "-out": columns, "-out.max": "unlimited", "-oc.form": "d"})


def sdss(out_dir: str) -> None:
    # Galaxies with a clean redshift out to z = 0.25 (the main sample and the nearer
    # luminous red galaxies), in 10 degree bands of right ascension so each query
    # stays under SkyServer's row and time limits.
    for ra in range(0, 360, 10):
        path = os.path.join(out_dir, f"sdss-{ra:03d}.csv")
        query = (
            "SELECT s.ra, s.dec, s.z, p.modelMag_g AS g, p.modelMag_r AS r, p.petroR90_r AS r90, "
            "p.expAB_r AS ab, p.expPhi_r AS phi FROM SpecObj AS s JOIN PhotoObj AS p ON s.bestObjID = p.objID "
            f"WHERE s.class = 'GALAXY' AND s.zWarning = 0 AND s.z BETWEEN 0.001 AND 0.25 AND s.ra >= {ra} AND s.ra < {ra + 10}"
        )
        download(f"{SKYSERVER}?{urllib.parse.urlencode({'cmd': query, 'format': 'csv'})}", path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("data")
    parser.add_argument("--only", help="comma-separated subset")
    args = parser.parse_args()
    out = os.path.join(args.data, "galaxies")
    os.makedirs(out, exist_ok=True)
    only = set(args.only.split(",")) if args.only else None
    want = lambda name: only is None or name in only  # noqa: E731
    for name, (source, columns) in VIZIER_TABLES.items():
        if want(name):
            vizier(source, columns, os.path.join(out, f"{name}.tsv"))
    if want("sdss"):
        sdss(out)
    if want("sfd"):
        download(SFD, os.path.join(out, "sfd-ebv.fits"))
    if want("cmb"):
        params = {"hips": "CDS/P/PLANCK/R3/CMB", "width": 2048, "height": 1024, "projection": "CAR",
                  "coordsys": "galactic", "fov": 360, "ra": 266.404996, "dec": -28.936172, "format": "fits"}
        download(f"{HIPS2FITS}?{urllib.parse.urlencode(params)}", os.path.join(out, "planck-cmb.fits"))
    print("done", file=sys.stderr)


if __name__ == "__main__":
    main()
