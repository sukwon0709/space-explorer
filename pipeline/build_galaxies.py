"""Build the galaxy catalogue: the Local Group, nearby galaxies and the cosmic web.

Usage:
    python pipeline/build_galaxies.py DATA_DIR public/data

Inputs are the downloads of pipeline/fetch_galaxies.py. Writes public/data/galaxies/:

  local.bin   galaxies from the Updated Nearby Galaxy Catalog, Cosmicflows-4, 2MRS and
              6dFGS (about 190,000), plus the Milky Way's globular clusters
  deep.bin    SDSS galaxies not in the local file (about 950,000), loaded when the camera
              leaves the Local Group
  index.json  named galaxies and clusters for search, with their sources

Where each galaxy is
  Every galaxy with a measured distance is placed there. Priority: the UNGC's distance
  (TRGB, Cepheids and other methods within 11 Mpc), then Cosmicflows-4 (SN Ia, TRGB,
  Cepheids, SBF, Tully-Fisher, fundamental plane). Members of a Cosmicflows-4 group with
  two or more measured members take the group's distance, which averages out the
  20% scatter of single Tully-Fisher and fundamental-plane distances. Every other galaxy
  is placed by its redshift: velocity in the CMB frame (Planck 2018 dipole) to comoving
  distance in flat Lambda-CDM with H0 = 74.6 km/s/Mpc (the Cosmicflows-4 calibration)
  and Omega_m = 0.3. Peculiar velocities then stretch clusters along the line of sight
  (the "fingers of God"), as in every redshift map.

What it looks like
  Absolute V magnitudes (Milky Way extinction removed with SFD E(B-V)) come from the
  UNGC's B, 2MRS K, SDSS g and r or 6dF rF, each converted to V with a colour typical of
  the galaxy's type. Sizes, axis ratios and position angles come from HyperLEDA (D25,
  R25, PA), then 2MRS or SDSS; where none is measured the size follows from the
  luminosity. The app draws each galaxy as an inclined disc (or, for ellipticals, a
  round spheroid) with that size, shape and orientation.

Binary layout (little-endian, structure of arrays, n galaxies):
  n x 3 float32  position, barycentric ICRS, Mpc (comoving)
  n uint8        absolute V magnitude, code: M = -26 + code / 10
  n uint8        radius, code: disc scale length (or spheroid half-light radius)
                 r = 0.05 kpc * 10^(code / 60)
  n uint8        axis ratio b/a, code / 255
  n uint8        position angle, code * 180 / 256 degrees (east of north)
  n uint8        B-V colour, code: (B - V) = code / 200
  n uint8        Milky Way E(B-V) toward it, code / 100 (saturates at 2.55)
  n uint8        flags: bits 0-3 distance method (DISTANCE_METHODS), bit 4 spheroid,
                 bit 5 reserved (the app sets it for galaxies it draws from an image),
                 bit 6 globular cluster
  padding to a multiple of 4 bytes
"""

import argparse
import json
import math
import os
import re

import healpy as hp
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

C_KMS = 299792.458
H0 = 74.6
OMEGA_M = 0.3
CMB_APEX = (264.021, 48.253, 369.82)  # Planck 2018 dipole: l, b (deg), km/s
R_V = 3.1
SFD_RECAL = 0.86  # Schlafly and Finkbeiner (2011)
DISTANCE_METHODS = ["redshift", "Tully-Fisher", "fundamental plane", "surface brightness fluctuations",
                    "type Ia supernova", "tip of the red giant branch", "Cepheids", "maser", "other",
                    "type II supernova", "group membership", "Cosmicflows-4 group", "horizontal branch"]
M = {name: k for k, name in enumerate(DISTANCE_METHODS)}
UNGC_METHOD = {"TRGB": M["tip of the red giant branch"], "Cep": M["Cepheids"], "TF": M["Tully-Fisher"],
               "SBF": M["surface brightness fluctuations"], "SN": M["type Ia supernova"], "FP": M["fundamental plane"],
               "mem": M["group membership"], "h": M["redshift"], "h'": M["redshift"], "HB": M["horizontal branch"],
               "RR": M["horizontal branch"]}

ICRS_TO_GAL = np.array([
    [-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
    [+0.4941094278755837, -0.4448296299600112, +0.7469822444972189],
    [-0.8676661490190047, -0.1980763734312015, +0.4559837761750669],
])

# Messier galaxies by their NGC numbers.
MESSIER = {31: 224, 32: 221, 33: 598, 49: 4472, 51: 5194, 58: 4579, 59: 4621, 60: 4649, 61: 4303, 63: 5055,
           64: 4826, 65: 3623, 66: 3627, 74: 628, 77: 1068, 81: 3031, 82: 3034, 83: 5236, 84: 4374, 85: 4382,
           86: 4406, 87: 4486, 88: 4501, 89: 4552, 90: 4569, 91: 4548, 94: 4736, 95: 3351, 96: 3368, 98: 4192,
           99: 4254, 100: 4321, 101: 5457, 102: 5866, 104: 4594, 105: 3379, 106: 4258, 108: 3556, 109: 3992, 110: 205}
COMMON = {
    "NGC224": "Andromeda Galaxy", "NGC598": "Triangulum Galaxy", "NGC5194": "Whirlpool Galaxy",
    "NGC5457": "Pinwheel Galaxy", "NGC4594": "Sombrero Galaxy", "NGC3031": "Bode's Galaxy", "NGC3034": "Cigar Galaxy",
    "NGC5128": "Centaurus A", "NGC4826": "Black Eye Galaxy", "NGC5055": "Sunflower Galaxy", "NGC253": "Sculptor Galaxy",
    "NGC5236": "Southern Pinwheel Galaxy", "NGC4486": "M87 (Virgo A)", "NGC1316": "Fornax A", "NGC4038": "Antennae Galaxies",
    "NGC1300": "NGC 1300", "NGC2903": "NGC 2903", "NGC7331": "NGC 7331", "NGC891": "NGC 891", "NGC4565": "Needle Galaxy",
    "NGC4631": "Whale Galaxy", "NGC6822": "Barnard's Galaxy", "NGC300": "NGC 300", "NGC55": "NGC 55",
    "NGC1275": "Perseus A", "NGC4889": "NGC 4889", "NGC4874": "NGC 4874", "NGC1399": "NGC 1399", "NGC5139": "",
}
# Galaxies the UNGC lists under other names.
UNGC_COMMON = {"Sag dSph": "Sagittarius Dwarf Spheroidal", "UMin": "Ursa Minor Dwarf", "SexDSph": "Sextans Dwarf",
               "Sag dIr": "Sagittarius Dwarf Irregular", "Cetus": "Cetus Dwarf", "SexA": "Sextans A", "SexB": "Sextans B",
               "Antlia": "Antlia Dwarf", "LeoT": "Leo T", "LeoIV": "Leo IV", "LeoV": "Leo V", "CVnI": "Canes Venatici I",
               "CVnII": "Canes Venatici II", "ComaI": "Coma Berenices Dwarf", "BootesII": "Boötes II", "BootesIII": "Boötes III",
               "Willman1": "Willman 1", "PiscesII": "Pisces II", "Cas dSph": "Cassiopeia Dwarf", "Peg dSph": "Pegasus Dwarf Spheroidal",
               "DDO210": "Aquarius Dwarf", "UMa II": "Ursa Major II", "UMa I": "Ursa Major I","LMC": "Large Magellanic Cloud", "SMC": "Small Magellanic Cloud", "SagdSph": "Sagittarius Dwarf",
               "Sculptor": "Sculptor Dwarf", "Fornax": "Fornax Dwarf", "Carina": "Carina Dwarf", "Draco": "Draco Dwarf",
               "UMi": "Ursa Minor Dwarf", "Sextans": "Sextans Dwarf", "LeoI": "Leo I", "LeoII": "Leo II", "WLM": "Wolf-Lundmark-Melotte",
               "IC1613": "IC 1613", "LeoA": "Leo A", "Phoenix": "Phoenix Dwarf", "Tucana": "Tucana Dwarf", "CanVenI": "Canes Venatici I",
               "BootesI": "Boötes I", "Hercules": "Hercules Dwarf", "CraterII": "Crater II", "AntliaII": "Antlia II",
               "SagDIG": "Sagittarius Dwarf Irregular", "Pegasus": "Pegasus Dwarf", "AndII": "Andromeda II", "AndI": "Andromeda I",
               "CIRCINUS": "Circinus Galaxy", "Maffei1": "Maffei 1", "Maffei2": "Maffei 2", "Dw1": "Dwingeloo 1", "Dw2": "Dwingeloo 2"}
# Clusters and groups: centred on their brightest galaxy (by PGC) or the members' mean.
CLUSTERS = [
    {"name": "Virgo Cluster", "sigma": 700, "pgc": 41361, "group": 41220, "radius": 2.2},
    {"name": "Fornax Cluster", "sigma": 370, "pgc": 13418, "group": 13418, "radius": 0.7},
    {"name": "Coma Cluster", "sigma": 1000, "pgc": 44715, "group": 44715, "radius": 3.0},
    {"name": "Perseus Cluster", "sigma": 1300, "pgc": 12429, "group": 12429, "radius": 2.5},
    {"name": "Centaurus Cluster", "sigma": 900, "pgc": 43296, "group": 43296, "radius": 2.0},
    {"name": "Hydra Cluster", "sigma": 700, "pgc": 31478, "group": 31478, "radius": 2.0},
    {"name": "Leo Triplet", "sigma": 150, "pgc": 34695, "group": 34695, "radius": 0.15},
    {"name": "M81 Group", "sigma": 150, "pgc": 28630, "group": 28630, "radius": 0.4},
    {"name": "Sculptor Group", "sigma": 100, "pgc": 2789, "group": 2789, "radius": 1.0},
]


def read_tsv(path: str) -> pd.DataFrame:
    with open(path) as f:
        lines = [ln.rstrip("\n") for ln in f if not ln.startswith("#") and ln.strip()]
    header = lines[0].split("\t")
    rows = [ln.split("\t") for ln in lines[3:]]
    return pd.DataFrame(rows, columns=header).apply(lambda c: c.str.strip())


def num(series) -> np.ndarray:
    return pd.to_numeric(series, errors="coerce").to_numpy(dtype=float)


def sexagesimal(ra: pd.Series, dec: pd.Series) -> tuple[np.ndarray, np.ndarray]:
    r = ra.str.split(expand=True).apply(pd.to_numeric, errors="coerce").to_numpy(float)
    d = dec.str.split(expand=True)
    sign = np.where(d[0].str.startswith("-"), -1.0, 1.0)
    dd = d.apply(lambda c: pd.to_numeric(c.str.replace("-", "").str.replace("+", ""), errors="coerce")).to_numpy(float)
    return 15 * (r[:, 0] + r[:, 1] / 60 + r[:, 2] / 3600), sign * (dd[:, 0] + dd[:, 1] / 60 + dd[:, 2] / 3600)


def unit(ra_deg, dec_deg):
    ra, dec = np.radians(ra_deg), np.radians(dec_deg)
    return np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], axis=-1)


def chord(arcsec):
    return 2 * np.sin(np.radians(np.asarray(arcsec) / 3600) / 2)


class Cosmology:
    """Flat Lambda-CDM comoving distance (Mpc) for a redshift, and back."""

    def __init__(self):
        z = np.linspace(0, 3, 30001)
        e = np.sqrt(OMEGA_M * (1 + z) ** 3 + 1 - OMEGA_M)
        dc = np.concatenate([[0], np.cumsum((1 / e[1:] + 1 / e[:-1]) / 2 * np.diff(z))]) * C_KMS / H0
        self.z, self.dc = z, dc

    def comoving(self, z):
        return np.interp(z, self.z, self.dc)

    def redshift(self, dc):
        return np.interp(dc, self.dc, self.z)


def cmb_velocity(cz, ra, dec):
    """Heliocentric cz to the CMB frame."""
    apex = unit(*galactic_to_icrs(CMB_APEX[0], CMB_APEX[1]))
    return cz + CMB_APEX[2] * (unit(ra, dec) @ apex)


def galactic_to_icrs(l_deg, b_deg):
    v = ICRS_TO_GAL.T @ unit(l_deg, b_deg)
    return math.degrees(math.atan2(v[1], v[0])) % 360, math.degrees(math.asin(v[2]))


class Sfd:
    def __init__(self, path):
        self.map = hp.read_map(path, verbose=False) if "verbose" in hp.read_map.__code__.co_varnames else hp.read_map(path)
        self.nside = hp.get_nside(self.map)

    def ebv(self, ra, dec):
        g = unit(ra, dec) @ ICRS_TO_GAL.T
        pix = hp.vec2pix(self.nside, g[:, 0], g[:, 1], g[:, 2])
        return SFD_RECAL * self.map[pix]


def type_colour(t):
    """Typical B-V for a de Vaucouleurs type T (E -5 ... Irr 10)."""
    return np.interp(t, [-5, -2, 0, 1, 3, 5, 7, 10], [0.96, 0.92, 0.88, 0.82, 0.70, 0.58, 0.50, 0.42])


def type_vk(t):
    """Typical V-K for a type (Jarrett et al. 2003 trend)."""
    return np.interp(t, [-5, 0, 3, 5, 8, 10], [3.3, 3.2, 3.0, 2.8, 2.4, 2.2])


def morph_2mrs(s: pd.Series) -> np.ndarray:
    m = s.str.extract(r"^\s*(-?\d+)")[0]
    return pd.to_numeric(m, errors="coerce").to_numpy(float)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("data")
    parser.add_argument("out")
    args = parser.parse_args()
    src = os.path.join(args.data, "galaxies")
    out = os.path.join(args.out, "galaxies")
    os.makedirs(out, exist_ok=True)
    cosmo = Cosmology()
    sfd = Sfd(os.path.join(src, "sfd-ebv.fits"))

    # ---- HyperLEDA (sizes, shapes, names) ------------------------------------
    pgc = read_tsv(os.path.join(src, "pgc.tsv"))
    pgc_id = num(pgc["PGC"]).astype(np.int64)
    pgc_ra, pgc_dec = sexagesimal(pgc["RAJ2000"], pgc["DEJ2000"])
    pgc_d25 = 0.1 * 10 ** num(pgc["logD25"])  # arcmin
    pgc_q = 10 ** -num(pgc["logR25"])
    pgc_pa = num(pgc["PA"])
    pgc_names = pgc["ANames"].to_numpy()
    ok = np.isfinite(pgc_ra) & np.isfinite(pgc_dec)
    pgc_tree = cKDTree(unit(pgc_ra[ok], pgc_dec[ok]))
    pgc_rows = np.nonzero(ok)[0]
    pgc_index = {int(p): i for i, p in enumerate(pgc_id)}
    print(f"PGC: {len(pgc_id)}")

    def match_pgc(ra, dec, radius_arcsec):
        """Index into the PGC table of the nearest galaxy within the radius, or -1."""
        d, j = pgc_tree.query(unit(ra, dec), distance_upper_bound=float(np.max(chord(radius_arcsec))))
        found = np.isfinite(d) & (d <= chord(radius_arcsec))
        res = np.full(len(ra), -1)
        res[found] = pgc_rows[j[found]]
        return res

    # Every galaxy, keyed by PGC row when matched; unmatched ones get their own keys.
    gal: dict[int, dict] = {}
    anonymous = 10_000_000

    def entry(key: int) -> dict:
        if key not in gal:
            gal[key] = {}
        return gal[key]

    # ---- Updated Nearby Galaxy Catalog ---------------------------------------
    ungc = read_tsv(os.path.join(src, "ungc.tsv"))
    ura, udec = sexagesimal(ungc["RAJ2000"], ungc["DEJ2000"])
    a26 = num(ungc["a26"])
    m = match_pgc(ura, udec, np.maximum(60, np.nan_to_num(a26) * 60 * 0.1))
    # Prefer a match by name (NGC, UGC, IC... as NED writes them, Messier via NGC).
    by_name: dict[str, int] = {}
    for row, names in enumerate(pgc_names):
        for nm in names.split():
            by_name.setdefault(nm, row)
    for k, ned in enumerate(ungc["NEDname"]):
        nm = ned.replace(" ", "")
        mm = re.match(r"^MESSIER0*(\d+)$", nm)
        if mm and int(mm.group(1)) in MESSIER:
            nm = f"NGC{MESSIER[int(mm.group(1))]}"
        nm = re.sub(r"^(NGC|IC|UGC)0+", r"\1", nm)
        if nm in by_name:
            m[k] = by_name[nm]
    for k in range(len(ungc)):
        key = int(m[k]) if m[k] >= 0 else (anonymous := anonymous + 1)
        e = entry(key)
        dist = float(num(ungc["Dist"].iloc[[k]])[0])
        meth = UNGC_METHOD.get(ungc["f_Dist"].iloc[k], M["other"])
        t = float(num(ungc["TT"].iloc[[k]])[0])
        e.update(ra=ura[k], dec=udec[k], dist=dist, method=meth, src="UNGC", ungc=ungc["Name"].iloc[k],
                 T=t, MB=float(num(ungc["BMag"].iloc[[k]])[0]), ungc_a26=a26[k], ungc_q=float(num(ungc["b/a"].iloc[[k]])[0]),
                 v=float(num(ungc["HRV"].iloc[[k]])[0]))
    print(f"UNGC: {len(ungc)}")

    # ---- Cosmicflows-4 --------------------------------------------------------
    groups = read_tsv(os.path.join(src, "cf4groups.tsv"))
    group_dm = dict(zip(num(groups["1PGC"]).astype(int), num(groups["DMzp"])))
    group_n = dict(zip(num(groups["1PGC"]).astype(int), num(groups["Ngal"])))
    cf4 = read_tsv(os.path.join(src, "cf4.tsv"))
    cf_pgc = num(cf4["PGC"]).astype(int)
    cf_group = num(cf4["1PGC"]).astype(int)
    cf_dm = num(cf4["DM"])
    cf_ra, cf_dec = num(cf4["RAJ2000"]), num(cf4["DEJ2000"])
    method_cols = [("DMceph", M["Cepheids"]), ("DMtrgb", M["tip of the red giant branch"]), ("DMmas", M["maser"]),
                   ("DMsnIa", M["type Ia supernova"]), ("DMsbf", M["surface brightness fluctuations"]),
                   ("DMsnII", M["type II supernova"]), ("DMtf", M["Tully-Fisher"]), ("DMfp", M["fundamental plane"])]
    have = {col: np.isfinite(num(cf4[col])) for col, _ in method_cols}
    for k in range(len(cf4)):
        row = pgc_index.get(int(cf_pgc[k]))
        key = row if row is not None else (anonymous := anonymous + 1)
        e = entry(key)
        e.setdefault("ra", cf_ra[k])
        e.setdefault("dec", cf_dec[k])
        e["vcmb"] = float(num(cf4["Vcmb"].iloc[[k]])[0])
        e["cf4"] = int(cf_pgc[k])
        if "dist" in e and e.get("src") == "UNGC" and e["method"] not in (M["redshift"], M["group membership"]):
            continue
        gdm = group_dm.get(int(cf_group[k]))
        if gdm is not None and np.isfinite(gdm) and group_n.get(int(cf_group[k]), 0) >= 2:
            e.update(dist=10 ** ((gdm - 25) / 5), method=M["Cosmicflows-4 group"], src="CF4 group", group=int(cf_group[k]))
        elif np.isfinite(cf_dm[k]):
            meth = next((mm for col, mm in method_cols if have[col][k]), M["other"])
            e.update(dist=10 ** ((cf_dm[k] - 25) / 5), method=meth, src="CF4")
        e["own_dist"] = 10 ** ((cf_dm[k] - 25) / 5) if np.isfinite(cf_dm[k]) else None
    print(f"CF4: {len(cf4)}")

    # ---- 2MRS -----------------------------------------------------------------
    tm = read_tsv(os.path.join(src, "2mrs.tsv"))
    tra, tdec = num(tm["RAJ2000"]), num(tm["DEJ2000"])
    rext = 10 ** num(tm["Rext"])  # arcsec
    m = match_pgc(tra, tdec, np.clip(rext * 0.3, 10, 600))
    kmag, ebv2, q2, cz2, t2 = num(tm["Ktmag"]), num(tm["E(B-V)"]), num(tm["b/a"]), num(tm["cz"]), morph_2mrs(tm["type"])
    names2 = tm["SimbadName"].to_numpy()
    for k in range(len(tm)):
        key = int(m[k]) if m[k] >= 0 else (anonymous := anonymous + 1)
        e = entry(key)
        e.setdefault("ra", tra[k])
        e.setdefault("dec", tdec[k])
        e.update(K=kmag[k], rext=rext[k], q2=q2[k], cz=cz2[k], T2=t2[k], name2=names2[k])
    print(f"2MRS: {len(tm)}")

    # ---- 6dFGS ----------------------------------------------------------------
    six = read_tsv(os.path.join(src, "6dfgs.tsv"))
    keep = (six["S/G"] == "1") & six["q_cz"].isin(["3", "4"])
    six = six[keep].reset_index(drop=True)
    sra, sdec = sexagesimal(six["RAJ2000"], six["DEJ2000"])
    m = match_pgc(sra, sdec, np.full(len(sra), 8.0))
    rf, cz6 = num(six["rFmag"]), num(six["cz"])
    for k in range(len(six)):
        key = int(m[k]) if m[k] >= 0 else (anonymous := anonymous + 1)
        e = entry(key)
        if "cz" in e and "rF" not in e and "K" in e:
            e.setdefault("rF", rf[k])
            continue
        e.setdefault("ra", sra[k])
        e.setdefault("dec", sdec[k])
        e.setdefault("cz", cz6[k])
        e["rF"] = rf[k]
    print(f"6dFGS: {len(six)}")
    local_keys = set(gal)

    # ---- SDSS -----------------------------------------------------------------
    parts = [pd.read_csv(os.path.join(src, f), comment="#") for f in sorted(os.listdir(src)) if f.startswith("sdss-")]
    sd = pd.concat(parts, ignore_index=True)
    sd = sd[(sd["g"] > 0) & (sd["r"] > 0) & (sd["r"] < 22)].reset_index(drop=True)
    sd_ra, sd_dec = sd["ra"].to_numpy(), sd["dec"].to_numpy()
    # Duplicate spectra of one galaxy: keep one.
    _, first = np.unique(np.round(unit(sd_ra, sd_dec) / chord(2.0)).astype(np.int64), axis=0, return_index=True)
    sd = sd.iloc[np.sort(first)].reset_index(drop=True)
    sd_ra, sd_dec = sd["ra"].to_numpy(), sd["dec"].to_numpy()
    m = match_pgc(sd_ra, sd_dec, np.clip(sd["r90"].to_numpy() * 0.5, 4, 120))
    deep_keys = set()
    for k, row in enumerate(sd.itertuples(index=False)):
        key = int(m[k]) if m[k] >= 0 else (anonymous := anonymous + 1)
        e = entry(key)
        if key not in local_keys:
            deep_keys.add(key)
        e.setdefault("ra", row.ra)
        e.setdefault("dec", row.dec)
        e.setdefault("cz", row.z * C_KMS)
        e.update(g=row.g, r=row.r, r90=row.r90, ab=row.ab, phi=row.phi)
    print(f"SDSS: {len(sd)}, {len(deep_keys)} only in SDSS")

    # ---- derived quantities ----------------------------------------------------
    keys = list(gal)
    n = len(keys)
    ra = np.array([gal[k]["ra"] for k in keys], float)
    dec = np.array([gal[k]["dec"] for k in keys], float)
    get = lambda name: np.array([gal[k].get(name, np.nan) for k in keys], float)  # noqa: E731
    dist, cz, vcmb = get("dist"), get("cz"), get("vcmb")
    has_dist = np.isfinite(dist)
    method = np.array([gal[k].get("method", M["redshift"]) for k in keys], int)
    v = np.where(np.isfinite(vcmb), vcmb, cmb_velocity(np.where(np.isfinite(cz), cz, get("v")), ra, dec))
    z = np.clip(v / C_KMS, 0, None)
    # Measured distances are luminosity distances; positions are comoving.
    d_lum = np.where(has_dist, dist, cosmo.comoving(z) * (1 + z))
    d_com = np.where(has_dist, dist / (1 + np.clip(cosmo.redshift(dist), 0, None)), cosmo.comoving(z))
    # Redshift-only galaxies in a cluster's core and velocity range: the cluster's
    # members, placed at the cluster's measured distance (spread over its radius)
    # instead of strung out along the line of sight by their orbital speeds.
    v_helio = np.where(np.isfinite(cz), cz, get("v"))
    sky = unit(ra, dec)
    rows_of = {int(pgc_id[k]): j for j, k in enumerate(keys) if k < 10_000_000}
    for c in CLUSTERS:
        j = rows_of.get(c["pgc"])
        gdm = group_dm.get(c["group"])
        if j is None or gdm is None or not np.isfinite(gdm):
            continue
        dc = 10 ** ((gdm - 25) / 5)
        vc = v_helio[j] if np.isfinite(v_helio[j]) else get("v")[j]
        sep = np.arccos(np.clip(sky @ sky[j], -1, 1))
        member = (~has_dist) & (sep < c["radius"] / dc) & (np.abs(v_helio - vc) < 2.6 * c["sigma"])
        idxs = np.nonzero(member)[0]
        # A fixed pseudo-random depth within the cluster for each member.
        depth = np.sin(idxs * 12.9898 + 78.233) * 43758.5453 % 1
        offset = (depth - 0.5) * c["radius"] * 1.2
        d_com[idxs] = dc + offset
        d_lum[idxs] = d_com[idxs]
        method[idxs] = M["group membership"]
        print(f"{c['name']}: {len(idxs)} redshift-only members placed at {dc:.1f} Mpc")
    valid = np.isfinite(d_com) & (d_com > 0.01)
    # Galaxies with neither a distance nor a usable redshift (blueshifted, or nothing) are dropped.
    print(f"dropped {np.sum(~valid)} without a distance")
    ebv = sfd.ebv(ra, dec)
    T = np.where(np.isfinite(get("T")), get("T"), get("T2"))
    g, r = get("g"), get("r")
    bv = np.where(np.isfinite(g) & np.isfinite(r), (g - r + 0.22) / 1.02, type_colour(np.where(np.isfinite(T), T, 3)))
    bv = np.clip(bv, 0.2, 1.2)
    a_v = R_V * ebv
    mu = 5 * np.log10(np.maximum(d_lum, 1e-3) * 1e6 / 10)
    V = np.full(n, np.nan)
    V = np.where(np.isfinite(get("rF")), get("rF") + 0.45 - a_v, V)
    V = np.where(np.isfinite(g) & np.isfinite(r), g - 0.59 * (g - r) - 0.01 - a_v, V)
    V = np.where(np.isfinite(get("K")), get("K") + type_vk(np.where(np.isfinite(T), T, 3)) - 0.11 * ebv, V)
    absV = V - mu
    absV = np.where(np.isfinite(get("MB")), get("MB") - bv, absV)
    valid &= np.isfinite(absV)

    # Size (D25 radius, kpc) and shape.
    pgc_row = np.array([k if k < 10_000_000 else -1 for k in keys])
    in_pgc = pgc_row >= 0
    d25 = np.where(in_pgc, pgc_d25[np.maximum(pgc_row, 0)], np.nan)
    d25 = np.where(np.isfinite(get("ungc_a26")), get("ungc_a26"), d25)
    rad_arcmin = d25 / 2
    rad_arcmin = np.where(np.isfinite(rad_arcmin), rad_arcmin, get("rext") / 60 * 1.3)
    rad_arcmin = np.where(np.isfinite(rad_arcmin), rad_arcmin, get("r90") / 60 * 1.6)
    r25 = np.radians(rad_arcmin / 60) * d_com * 1000  # kpc
    from_lum = 12 * 10 ** (-0.4 * (absV + 21.5) * 0.5)
    r25 = np.where(np.isfinite(r25) & (r25 > 0), r25, from_lum)
    q = np.where(in_pgc, pgc_q[np.maximum(pgc_row, 0)], np.nan)
    q = np.where(np.isfinite(get("ungc_q")), get("ungc_q"), q)
    q = np.where(np.isfinite(q), q, get("q2"))
    q = np.where(np.isfinite(q), q, get("ab"))
    q = np.clip(np.where(np.isfinite(q), q, 0.7), 0.08, 1)
    pa = np.where(in_pgc, pgc_pa[np.maximum(pgc_row, 0)], np.nan)
    pa = np.where(np.isfinite(pa), pa, get("phi"))
    # An unknown position angle: a fixed pseudo-random one (shapes still look natural).
    pa = np.where(np.isfinite(pa), pa, (np.arange(n) * 137.508) % 180)
    spheroid = (np.isfinite(T) & (T <= -1)) | (~np.isfinite(T) & (bv > 0.92))
    # Disc scale length is D25 / 2 / 3.2 (Freeman); a spheroid's half-light radius about R25 / 3.
    radius = np.where(spheroid, r25 / 3.0, r25 / 3.2)

    # ---- the Milky Way's globular clusters (Harris 2010) ---------------------------
    gc = read_tsv(os.path.join(src, "harris.tsv"))
    gra, gdec = sexagesimal(gc["RAJ2000"], gc["DEJ2000"])
    g_dist = num(gc["Rsun"]) / 1000  # Mpc
    g_mv = num(gc["MVt"])
    g_rh = num(gc["Rh"])  # arcmin
    g_ok = np.isfinite(g_dist) & np.isfinite(g_mv) & np.isfinite(g_rh)
    print(f"globular clusters: {g_ok.sum()}")

    # ---- write ------------------------------------------------------------------
    idx = np.nonzero(valid)[0]
    order = idx[np.argsort(d_com[idx])]
    local = [i for i in order if keys[i] not in deep_keys]
    deep = [i for i in order if keys[i] in deep_keys]

    def encode(sel, extra=None):
        sel = np.asarray(sel, int)
        pos = unit(ra[sel], dec[sel]) * d_com[sel, None]
        absm = absV[sel]
        rad = radius[sel]
        qq, pp, cc, ee = q[sel], pa[sel], bv[sel], ebv[sel]
        flags = (method[sel] & 15) | (spheroid[sel] << 4).astype(int)
        if extra is not None:
            pos = np.concatenate([pos, extra["pos"]])
            absm = np.concatenate([absm, extra["absm"]])
            rad = np.concatenate([rad, extra["radius"]])
            qq = np.concatenate([qq, np.ones(len(extra["pos"]))])
            pp = np.concatenate([pp, np.zeros(len(extra["pos"]))])
            cc = np.concatenate([cc, extra["bv"]])
            ee = np.concatenate([ee, extra["ebv"]])
            flags = np.concatenate([flags, np.full(len(extra["pos"]), (1 << 4) | (1 << 6) | M["horizontal branch"])])
        count = len(pos)
        blob = b"".join([
            pos.astype("<f4").tobytes(),
            np.clip(np.round((absm + 26) * 10), 0, 255).astype(np.uint8).tobytes(),
            np.clip(np.round(60 * np.log10(np.maximum(rad, 1e-4) / 0.05)), 0, 255).astype(np.uint8).tobytes(),
            np.clip(np.round(qq * 255), 1, 255).astype(np.uint8).tobytes(),
            np.clip(np.round((pp % 180) * 256 / 180), 0, 255).astype(np.uint8).tobytes(),
            np.clip(np.round(cc * 200), 0, 255).astype(np.uint8).tobytes(),
            np.clip(np.round(ee * 100), 0, 255).astype(np.uint8).tobytes(),
            np.asarray(flags, np.uint8).tobytes(),
        ])
        blob += b"\0" * (-len(blob) % 4)
        return blob, count

    gsel = np.nonzero(g_ok)[0]
    g_ebv = num(gc["E(B-V)"])[gsel]
    globulars = {
        "pos": unit(gra[gsel], gdec[gsel]) * g_dist[gsel, None],
        "absm": g_mv[gsel],
        # Harris's half-light radius; drawn as a Plummer sphere of that half-light radius.
        "radius": np.radians(g_rh[gsel] / 60) * g_dist[gsel] * 1e3,
        "bv": np.clip(np.nan_to_num(num(gc["(B-V)t"])[gsel], nan=0.75) - g_ebv, 0.3, 1.1),
        "ebv": g_ebv,
    }
    blob, n_local = encode(local, globulars)
    open(os.path.join(out, "local.bin"), "wb").write(blob)
    blob, n_deep = encode(deep)
    open(os.path.join(out, "deep.bin"), "wb").write(blob)
    print(f"local {n_local} ({len(local)} galaxies + {len(gsel)} globular clusters), deep {n_deep}")

    # ---- names for search ----------------------------------------------------------
    named = []
    local_pos = {keys[i]: j for j, i in enumerate(local)}

    def names_of(key):
        e = gal[key]
        out_names = []
        if key < 10_000_000:
            out_names += pgc_names[key].split()
        if "ungc" in e:
            out_names.append(e["ungc"])
        if isinstance(e.get("name2"), str) and e["name2"]:
            out_names.append(re.sub(r"^MESSIER_0*", "M", e["name2"]).replace("_", ""))
        return out_names

    def pretty(n):
        mm = re.match(r"^(NGC|IC|UGC|ESO|PGC|MCG|CGCG)(.*)$", n)
        return f"{mm.group(1)} {mm.group(2).lstrip('0') or '0'}" if mm and mm.group(1) in ("NGC", "IC", "UGC") else n

    ngc_to_messier = {f"NGC{v}": k for k, v in MESSIER.items()}
    for key, j in local_pos.items():
        raw = names_of(key)
        catalogue = [x for x in raw if re.match(r"^(NGC|IC)\d", x)]
        e = gal[key]
        ungc = e.get("ungc")
        messier = next((ngc_to_messier[x] for x in catalogue if x in ngc_to_messier), None)
        common = next((COMMON[x] for x in catalogue if COMMON.get(x)), None) or (UNGC_COMMON.get(ungc) if ungc else None)
        if not (catalogue or ungc or messier or common):
            continue
        aliases = [pretty(x) for x in catalogue]
        if messier:
            aliases.insert(0, f"M{messier}")
        if ungc and not ungc.startswith("MESSIER") and pretty(ungc) not in aliases:
            aliases.append(pretty(ungc))
        name = common or (f"M{messier}" if messier else aliases[0])
        i = local[j]
        entry_ = {"name": name, "aka": [a for a in dict.fromkeys(aliases) if a != name], "i": j,
                  "method": int(method[i]), "dist": round(float(d_lum[i]), 4 if d_lum[i] < 1 else 2),
                  "v": round(float(v[i])) if np.isfinite(v[i]) else None, "pgc": int(pgc_id[key]) if key < 10_000_000 else None}
        if e.get("own_dist") and e.get("group"):
            entry_["own"] = round(e["own_dist"], 2)
        named.append(entry_)
    # Globular clusters: named after their Harris names.
    for j, gi in enumerate(gsel):
        idn, alt = gc["ID"].iloc[gi], gc["Name"].iloc[gi]
        nm = {"omega Cen": "Omega Centauri"}.get(alt, alt) if alt else idn
        named.append({"name": nm, "aka": [idn] if alt else [], "i": len(local) + j, "kind": "globular",
                      "dist": round(float(g_dist[gi]), 5), "method": M["horizontal branch"]})
    # Messier globular clusters by number.
    messier_gc = {"NGC 6205": "M13", "NGC 7078": "M15", "NGC 6656": "M22",
                  "NGC 5272": "M3", "NGC 6121": "M4", "NGC 5904": "M5", "NGC 6341": "M92", "NGC 7089": "M2", "NGC 6254": "M10",
                  "NGC 6218": "M12", "NGC 6093": "M80", "NGC 6266": "M62", "NGC 1904": "M79", "NGC 6838": "M71"}
    for e in named:
        if e.get("kind") == "globular":
            for a in [e["name"], *e["aka"]]:
                label = messier_gc.get(a)
                if label and label not in e["aka"] and label != e["name"]:
                    e["aka"].insert(0, label)
    clusters = []
    by_pgc = {e["pgc"]: e for e in named if e.get("pgc")}
    for c in CLUSTERS:
        e = by_pgc.get(c["pgc"])
        if e is None:
            print(f"cluster {c['name']}: centre galaxy not found")
            continue
        gdm = group_dm.get(c["group"])
        dist_c = 10 ** ((gdm - 25) / 5) if gdm is not None and np.isfinite(gdm) else e["dist"]
        clusters.append({"name": c["name"], "centre": e["name"], "i": e["i"], "dist": round(dist_c, 2), "radius": c["radius"],
                         "members": int(group_n.get(c["group"], 0))})
    index = {
        "methods": DISTANCE_METHODS,
        "local": n_local, "deep": n_deep, "galaxies": len(local), "H0": H0, "omegaM": OMEGA_M,
        "named": named, "clusters": clusters,
    }
    with open(os.path.join(out, "index.json"), "w") as f:
        json.dump(index, f, separators=(",", ":"))
    print(f"named {len(named)}, clusters {len(clusters)}")


if __name__ == "__main__":
    main()
