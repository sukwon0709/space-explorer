"""Reference sky positions and magnitudes for the milestone 4 gate (tests/stars.test.ts).

Usage:
    python pipeline/make_sky_fixtures.py DATA_DIR tests/fixtures/sky-reference.json

Independent of the app's catalogue pipeline: positions come straight from the published
catalogues, moved to each test epoch with ERFA's pmsafe (space motion with radial
velocity and perspective acceleration) and seen from Earth's barycentric position (ERFA
epv00), astrometric (no aberration or light deflection, like the app's planets).

  hip    every star of the original Hipparcos catalogue (ESA 1997, VizieR I/239) brighter
         than V = 6.5 that has a parallax, with its catalogue V
  gaia   1,500 random Gaia DR3 stars from the downloaded selection with parallaxes better
         than 10%, with Tycho-2 V where Tycho-2 has the star (V = VT - 0.090 (BT - VT))
"""

import argparse
import json
import math
import os

import erfa
import numpy as np
import pandas as pd

EPOCHS = ["1960-06-01T00:00:00", "2026-10-05T04:00:00", "2060-06-01T00:00:00"]
AU_PC = 1 / 206264.80624709636
MAS = math.pi / 180 / 3600 / 1000


def tdb_jd(utc: str):
    from astropy.time import Time

    t = Time(utc, scale="utc").tdb
    return t.jd1, t.jd2


def earth_pc(jd1, jd2):
    pvh, pvb = erfa.epv00(jd1, jd2)
    return np.array(pvb["p"]) * AU_PC


def directions(ra_deg, dec_deg, pmra_star, pmdec, plx_mas, rv, epoch_jd, utc):
    """Unit vectors from Earth (ICRS) at `utc`. pmra_star is mu_alpha* (mas/yr)."""
    ra, dec = np.radians(ra_deg), np.radians(dec_deg)
    pmr = pmra_star * MAS / np.cos(dec)
    pmd = pmdec * MAS
    jd1, jd2 = tdb_jd(utc)
    ra2, dec2, _, _, px2, _ = erfa.pmsafe(ra, dec, pmr, pmd, plx_mas / 1000, rv, epoch_jd, 0.0, jd1, jd2)
    d = 1 / px2  # pc
    p = d[:, None] * np.stack([np.cos(dec2) * np.cos(ra2), np.cos(dec2) * np.sin(ra2), np.sin(dec2)], axis=-1)
    p = p - earth_pc(jd1, jd2)
    p /= np.linalg.norm(p, axis=1)[:, None]
    return p


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    parser.add_argument("out")
    args = parser.parse_args()
    d = os.path.join(args.data, "stars")

    hip = pd.read_csv(os.path.join(d, "hip_main.csv"))
    hip = hip[(hip.Vmag < 6.5) & (hip.Plx > 0) & np.isfinite(hip.RAICRS)].reset_index(drop=True)
    xhip = pd.read_csv(os.path.join(d, "xhip.csv")).set_index("HIP")
    rv = np.nan_to_num(hip.HIP.map(xhip.RV).to_numpy())

    gaia = pd.read_csv(os.path.join(d, "gaia-g11.csv"))
    gaia = pd.concat([gaia, pd.read_csv(os.path.join(d, "gaia-g12.csv"))])
    gaia = gaia[(gaia.parallax > 0) & (gaia.parallax > 10 * gaia.parallax_error) & np.isfinite(gaia.pmra)]
    gaia = gaia.sample(1500, random_state=4).reset_index(drop=True)

    tycho = pd.read_csv(os.path.join(d, "tycho2.csv"))
    tycho = tycho[np.isfinite(tycho.VTmag) & np.isfinite(tycho.BTmag)].reset_index(drop=True)

    out = {"epochs": [e + "Z" for e in EPOCHS], "hip": [], "gaia": [], "tycho": []}
    hip_dirs = [directions(hip.RAICRS.to_numpy(), hip.DEICRS.to_numpy(), hip.pmRA.to_numpy(), hip.pmDE.to_numpy(),
                           hip.Plx.to_numpy(), rv, 2448349.0625, e) for e in EPOCHS]
    for k, row in hip.iterrows():
        out["hip"].append({"hip": int(row.HIP), "V": float(row.Vmag), "mult": str(row.MultFlag).strip(),
                           "dir": [[round(float(c), 10) for c in dirs[k]] for dirs in hip_dirs]})
    gaia_dirs = [directions(gaia.ra.to_numpy(), gaia.dec.to_numpy(), gaia.pmra.to_numpy(), gaia.pmdec.to_numpy(),
                            gaia.parallax.to_numpy(), np.nan_to_num(gaia.radial_velocity.to_numpy()), 2457389.0, e) for e in EPOCHS]
    ids = gaia.source_id.to_numpy(np.int64)
    for k, row in gaia.iterrows():
        out["gaia"].append({"gaia": str(ids[k]), "G": float(row.phot_g_mean_mag),
                            "dir": [[round(float(c), 10) for c in dirs[k]] for dirs in gaia_dirs]})
    # Tycho-2 stars (J2000 mean positions, no parallax) in the test fields, for magnitudes.
    tycho = tycho[tycho.VTmag < 10.5].reset_index(drop=True)
    for _, row in tycho.iterrows():
        out["tycho"].append({"tyc": f"{row.TYC1}-{row.TYC2}-{row.TYC3}", "ra": float(row.RAmdeg), "dec": float(row.DEmdeg),
                             "pmra": float(np.nan_to_num(row.pmRA)), "pmdec": float(np.nan_to_num(row.pmDE)),
                             "V": round(float(row.VTmag - 0.090 * (row.BTmag - row.VTmag)), 3), "BV": round(float(0.850 * (row.BTmag - row.VTmag)), 3)})
    with open(args.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {args.out}: {len(out['hip'])} Hipparcos, {len(out['gaia'])} Gaia, {len(out['tycho'])} Tycho-2 stars")


if __name__ == "__main__":
    main()
