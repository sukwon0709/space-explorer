"""Build the star octree, the named-star index, exoplanets and constellation figures.

Usage:
    python pipeline/build_stars.py DATA_DIR public/data [--dust DATA_DIR/dust-grid.npz]

Inputs are the downloads of pipeline/fetch_stars.py (and, for extinction, the dust grid
of pipeline/build_dust.py).

Stars
  Every Gaia DR3 source brighter than G = 12, every source within 100 pc with a 10%
  parallax, and every exoplanet host Gaia measured, merged with Hipparcos (XHIP) for the
  stars Gaia saturates on (Hp < 6) or missed. About 3.4 million stars.

  Positions are barycentric ICRS at epoch J2016.0 in parsecs, with space velocities from
  the proper motions, distances and radial velocities, so the app moves each star in a
  straight line (the same model as SOFA/ERFA's pmsafe). Distances are 1/parallax when the
  parallax is measured to 20% or better, otherwise Bailer-Jones et al. (2021).

  Brightness is Johnson V: Hipparcos V for Hipparcos stars, Gaia G and BP-RP converted
  with Riello et al. (2021) for Gaia stars. The app stores the absolute magnitude with
  extinction removed (M = V - A_V - 5 log10(d / 10 pc)), so it can recompute the
  apparent magnitude from anywhere. A_V is integrated through the Edenhofer et al. (2024)
  3D dust map from the Sun to the star; from the Sun the app adds exactly this A_V back,
  so V as seen from Earth is the catalogue value. Colour temperatures come from the
  dereddened colour through Pecaut and Mamajek's dwarf sequence.

Octree (stars/index.json, stars/pack-N.bin)
  A cube 2^16 pc on a side around the Sun. Each node keeps the 8,192 most luminous stars
  inside it that no ancestor kept; the rest go to its eight children. The app opens a
  node's children only if their most luminous star could be seen from where the camera
  is, so the whole sky to the current magnitude limit is always loaded, wherever you are.
  Nodes are stored breadth first, spatially sorted, in packs of about 1.5 MB.

  Node blob (n stars, little-endian, 4-byte aligned): n x 3 float32 position (pc),
  n x 3 float16 velocity (km/s), n int16 absolute V magnitude (millimag),
  n uint8 temperature code (T = 2000 K * 25^(code / 255)), n uint8 A_V (0.04 mag steps).
"""

import argparse
import csv
import json
import math
import os
import re
import struct

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

KMS_TO_PCYR = 1.0227121650537077e-6  # 1 km/s in pc per Julian year
MAS = math.pi / 180 / 3600 / 1000
EPOCH = 2016.0
HIP_EPOCH = 1991.25
NODE_CAPACITY = 8192
ROOT_HALF = 65536.0
PACK_BYTES = 1_500_000
T_MIN, T_RATIO = 2000.0, 25.0
AV_STEP = 0.04

# ICRS to Galactic (Hipparcos definition, as in astropy).
ICRS_TO_GAL = np.array([
    [-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
    [+0.4941094278755837, -0.4448296299600112, +0.7469822444972189],
    [-0.8676661490190047, -0.1980763734312015, +0.4559837761750669],
])


def unit(ra_deg, dec_deg):
    ra, dec = np.radians(ra_deg), np.radians(dec_deg)
    return np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], axis=-1)


def space_motion(ra_deg, dec_deg, dist_pc, pmra, pmdec, rv):
    """Position (pc) and velocity (km/s) in barycentric ICRS. pmra is mu_alpha* (mas/yr)."""
    ra, dec = np.radians(ra_deg), np.radians(dec_deg)
    u = unit(ra_deg, dec_deg)
    e_ra = np.stack([-np.sin(ra), np.cos(ra), np.zeros_like(ra)], axis=-1)
    e_dec = np.stack([-np.sin(dec) * np.cos(ra), -np.sin(dec) * np.sin(ra), np.cos(dec)], axis=-1)
    # Tangential speed: (mas/yr -> rad/yr) * pc -> pc/yr -> km/s.
    k = (dist_pc * MAS / KMS_TO_PCYR)[:, None]
    vel = k * (pmra[:, None] * e_ra + pmdec[:, None] * e_dec) + rv[:, None] * u
    return dist_pc[:, None] * u, vel


# ---------------------------------------------------------------- colours and magnitudes

def load_mamajek(path):
    header, rows = None, []
    for line in open(path):
        if line.startswith("#SpT"):
            if header is None:
                header = line[1:].split()
                continue
            break
        if header is None or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < len(header):
            if rows:
                break
            continue
        rows.append(parts[: len(header)])

    def num(s):
        try:
            return float(s)
        except ValueError:
            return np.nan

    return {h: np.array([num(r[i]) for r in rows]) for i, h in enumerate(header)}


class Colours:
    """Temperature from B-V or BP-RP, and bolometric correction, from Pecaut and Mamajek."""

    def __init__(self, path):
        t = load_mamajek(path)
        ok = (t["Teff"] >= 2300) & np.isfinite(t["B-V"])
        teff, bv, bprp, bc = t["Teff"][ok], t["B-V"][ok], t["Bp-Rp"][ok], t["BCv"][ok]
        # Extend BP-RP to the hot stars with a linear fit against B-V at the blue end.
        both = np.isfinite(bprp)
        first = np.flatnonzero(both)[:12]
        slope, icpt = np.polyfit(bv[first], bprp[first], 1)
        bprp = np.where(both, bprp, slope * bv + icpt)
        self.teff = teff
        self.bv = np.maximum.accumulate(bv)
        self.bprp = np.maximum.accumulate(bprp)
        good = np.isfinite(bc)
        self.log_t_bc, self.bc = np.log10(teff[good])[::-1], bc[good][::-1]

    def from_bv(self, bv):
        return np.interp(bv, self.bv, self.teff)

    def from_bprp(self, bprp):
        return np.interp(bprp, self.bprp, self.teff)

    def bolometric_correction(self, teff):
        return np.interp(np.log10(teff), self.log_t_bc, self.bc)


def gaia_v(g, bprp):
    """Johnson V from Gaia G and BP-RP (Riello et al. 2021, table C.2).

    The fit is for -0.5 < BP-RP < 2.75; it is extended to 5 for the reddest dwarfs,
    where it still gives V within about 0.3 mag (Proxima Centauri, TRAPPIST-1).
    """
    x = np.clip(np.nan_to_num(bprp, nan=0.82), -0.5, 5.0)
    return g - (-0.02704 + 0.01424 * x - 0.2156 * x**2 + 0.01426 * x**3)


# ------------------------------------------------------------------------- the catalogues

def load_gaia(paths):
    frames = [pd.read_csv(p) for p in paths if os.path.exists(p)]
    g = pd.concat(frames, ignore_index=True).drop_duplicates("source_id")
    g = g[np.isfinite(g.phot_g_mean_mag)].reset_index(drop=True)
    return g


def gaia_stars(g):
    plx, eplx = g.parallax.to_numpy(), g.parallax_error.to_numpy()
    good = (plx > 0) & (plx >= 5 * eplx)
    dist = np.where(good, 1000 / np.where(plx > 0, plx, 1), np.nan)
    for col in ("r_med_photogeo", "r_med_geo"):
        dist = np.where(np.isfinite(dist), dist, g[col].to_numpy())
    dist = np.where(np.isfinite(dist), dist, np.where(plx > 0, 1000 / np.where(plx > 0, plx, 1), 1000.0))
    pos, vel = space_motion(g.ra.to_numpy(), g.dec.to_numpy(), dist,
                            np.nan_to_num(g.pmra.to_numpy()), np.nan_to_num(g.pmdec.to_numpy()),
                            np.nan_to_num(g.radial_velocity.to_numpy()))
    bprp = g.bp_rp.to_numpy()
    return dict(pos=pos, vel=vel, v=gaia_v(g.phot_g_mean_mag.to_numpy(), bprp), bprp=bprp, bv=np.full(len(g), np.nan),
                gaia=g.source_id.to_numpy(np.int64), hip=np.full(len(g), -1, np.int64), dist=dist)


def hip_stars(x, gaia_dist):
    """XHIP rows to J2016 position/velocity. gaia_dist: Gaia distance per row (NaN if none)."""
    plx, eplx = x.Plx.to_numpy(), x.e_Plx.to_numpy()
    good = (plx > 0) & (plx >= 5 * np.nan_to_num(eplx, nan=1e9))
    dist = np.where(good, 1000 / np.where(plx > 0, plx, 1), gaia_dist)
    xdist = x.Dist.to_numpy()
    dist = np.where(np.isfinite(dist), dist, np.where(xdist > 0, xdist, np.nan))
    dist = np.where(np.isfinite(dist), dist, np.where(plx > 0, 1000 / np.maximum(plx, 0.5), 1000.0))
    pos, vel = space_motion(x.RAJ2000.to_numpy(), x.DEJ2000.to_numpy(), dist,
                            np.nan_to_num(x.pmRA.to_numpy()), np.nan_to_num(x.pmDE.to_numpy()),
                            np.nan_to_num(x.RV.to_numpy()))
    pos = pos + vel * KMS_TO_PCYR * (EPOCH - HIP_EPOCH)
    v = x.Vmag.to_numpy()
    v = np.where(np.isfinite(v), v, x.Hpmag.to_numpy())
    return dict(pos=pos, vel=vel, v=v, bprp=np.full(len(x), np.nan), bv=x["B-V"].to_numpy(),
                gaia=np.full(len(x), -1, np.int64), hip=x.HIP.to_numpy(np.int64), dist=np.linalg.norm(pos, axis=1))


def concat(*parts):
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


def take(s, mask):
    return {k: v[mask] for k, v in s.items()}


# ------------------------------------------------------------------------------- dust

class Dust:
    """Trilinear A_V density (mag/pc) on a heliocentric Galactic grid (see build_dust.py)."""

    def __init__(self, path):
        z = np.load(path)
        self.density = z["density"].astype(np.float32)  # (nx, ny, nz) mag/pc
        self.lo, self.hi = z["lo"], z["hi"]  # box corners, pc (Galactic x, y, z)
        self.cell = (self.hi - self.lo) / (np.array(self.density.shape) - 1)

    def sample(self, p):
        from scipy.ndimage import map_coordinates

        idx = ((p - self.lo) / self.cell).T
        return map_coordinates(self.density, idx, order=1, mode="constant", cval=0.0)

    def extinction_from_sun(self, pos_icrs, step=2.0):
        """A_V from the Sun to each star: the density integrated along the line of sight."""
        gal = pos_icrs @ ICRS_TO_GAL.T
        d = np.linalg.norm(gal, axis=1)
        u = gal / np.maximum(d, 1e-9)[:, None]
        # Inside the box only: beyond it the map has no data.
        with np.errstate(divide="ignore", invalid="ignore"):
            t_exit = np.min(np.where(u > 0, self.hi / u, np.where(u < 0, self.lo / u, np.inf)), axis=1)
        reach = np.minimum(d, t_exit)
        av = np.zeros(len(pos_icrs))
        n_steps = int(np.ceil(reach.max() / step))
        for chunk in range(0, len(pos_icrs), 200_000):
            sl = slice(chunk, chunk + 200_000)
            r, uu = reach[sl], u[sl]
            total = np.zeros(len(r))
            for k in range(n_steps):
                t = (k + 0.5) * step
                live = t < r
                if not live.any():
                    break
                seg = np.minimum(step, r[live] - k * step)
                pts = uu[live] * np.minimum(t, r[live] - seg / 2)[:, None]
                total[live] += self.sample(pts) * seg
            av[sl] = total
        return av


# ---------------------------------------------------------------------------- octree

def build_octree(pos, absmag):
    order = np.argsort(absmag, kind="stable")
    nodes = []

    def build(idx, center, half, level, parent):
        me = len(nodes)
        node = dict(level=level, center=center, half=half, parent=parent, children=[], stars=idx[:NODE_CAPACITY])
        nodes.append(node)
        rest = idx[NODE_CAPACITY:]
        if len(rest) and level < 40:
            p = pos[rest]
            octant = (p[:, 0] > center[0]) * 1 + (p[:, 1] > center[1]) * 2 + (p[:, 2] > center[2]) * 4
            for o in range(8):
                sub = rest[octant == o]
                if len(sub):
                    off = np.array([1 if o & 1 else -1, 1 if o & 2 else -1, 1 if o & 4 else -1]) * half / 2
                    node["children"].append(build(sub, center + off, half / 2, level + 1, me))
        elif len(rest):
            node["stars"] = idx
        return me

    build(order, np.zeros(3), ROOT_HALF, 0, -1)
    return nodes


def morton(center, half):
    q = ((center + ROOT_HALF) / (2 * half)).astype(np.int64)
    code = 0
    for bit in range(20):
        for axis in range(3):
            code |= ((int(q[axis]) >> bit) & 1) << (3 * bit + axis)
    return code


def node_blob(s, idx):
    n = len(idx)
    teff_code = np.clip(np.round(255 * np.log(s["teff"][idx] / T_MIN) / np.log(T_RATIO)), 0, 255).astype(np.uint8)
    parts = [
        s["pos"][idx].astype("<f4").tobytes(),
        s["vel"][idx].astype("<f2").tobytes(),
        np.clip(np.round(s["absmag"][idx] * 1000), -32768, 32767).astype("<i2").tobytes(),
        teff_code.tobytes(),
        s["avq"][idx].astype(np.uint8).tobytes(),
    ]
    blob = b"".join(parts)
    assert len(blob) == 22 * n
    return blob + b"\0" * (-len(blob) % 4)


def write_octree(s, nodes, out):
    os.makedirs(os.path.join(out, "stars"), exist_ok=True)
    # Breadth first, spatially sorted within a level.
    order = sorted(range(len(nodes)), key=lambda i: (nodes[i]["level"], morton(nodes[i]["center"], nodes[i]["half"])))
    rank = {old: new for new, old in enumerate(order)}
    entries, pack, offset, buf = [], 0, 0, []

    def flush():
        nonlocal pack, offset, buf
        if buf:
            with open(os.path.join(out, "stars", f"pack-{pack}.bin"), "wb") as f:
                f.write(b"".join(buf))
            pack, offset, buf = pack + 1, 0, []

    for old in order:
        node = nodes[old]
        blob = node_blob(s, node["stars"])
        if offset and offset + len(blob) > PACK_BYTES:
            flush()
        m = s["absmag"][node["stars"]]
        entries.append([node["level"], *[round(float(c), 3) for c in node["center"]], node["half"], len(node["stars"]),
                        round(float(m.min()), 3), round(float(m.max()), 3), pack, offset,
                        rank[node["parent"]] if node["parent"] >= 0 else -1, sorted(rank[c] for c in node["children"])])
        buf.append(blob)
        offset += len(blob)
    flush()
    index = {
        "epoch": EPOCH, "capacity": NODE_CAPACITY, "count": int(len(s["pos"])), "packs": pack,
        "teff": [T_MIN, T_RATIO], "avStep": AV_STEP,
        "fields": ["level", "cx", "cy", "cz", "half", "count", "minM", "maxM", "pack", "offset", "parent", "children"],
        "nodes": entries,
    }
    with open(os.path.join(out, "stars", "index.json"), "w") as f:
        json.dump(index, f, separators=(",", ":"))
    print(f"octree: {len(entries)} nodes, depth {max(e[0] for e in entries)}, {pack} packs")


# ------------------------------------------------------------------------ names, planets

GREEK = {"alf": "α", "bet": "β", "gam": "γ", "del": "δ", "eps": "ε", "zet": "ζ", "eta": "η", "the": "θ", "iot": "ι", "kap": "κ",
         "lam": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "omi": "ο", "pi": "π", "rho": "ρ", "sig": "σ", "tau": "τ", "ups": "υ",
         "phi": "φ", "chi": "χ", "psi": "ψ", "ome": "ω"}


def f32(x):
    return float(np.float32(x))


def star_entry(s, i, name, desig=""):
    e = {"name": name}
    if desig:
        e["desig"] = desig
    if s["hip"][i] >= 0:
        e["hip"] = int(s["hip"][i])
    if s["gaia"][i] >= 0:
        e["gaia"] = str(int(s["gaia"][i]))
    e["pos"] = [f32(c) for c in s["pos"][i]]
    e["vel"] = [float(np.float16(c)) for c in s["vel"][i]]
    e["M"] = round(float(s["absmag"][i]), 3)
    e["V"] = round(float(s["v"][i]), 3)
    e["teff"] = int(round(float(s["teff"][i]), -1))
    e["av"] = round(float(s["avq"][i]) * AV_STEP, 2)
    e["radius"] = round(float(s["radius"][i]), 3)
    return e


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    parser.add_argument("out")
    parser.add_argument("--dust", help="dust grid from build_dust.py (A_V density on a Galactic box)")
    args = parser.parse_args()
    d = os.path.join(args.data, "stars")
    colours = Colours(os.path.join(d, "mamajek.txt"))

    gaia = load_gaia([os.path.join(d, f) for f in sorted(os.listdir(d)) if f.startswith("gaia-") and f.endswith(".csv") and f != "gaia-hosts.csv"])
    hosts = pd.read_csv(os.path.join(d, "gaia-hosts.csv")) if os.path.exists(os.path.join(d, "gaia-hosts.csv")) else None
    if hosts is not None:
        extra = hosts[~hosts.source_id.isin(gaia.source_id)].drop_duplicates("source_id")
        gaia = pd.concat([gaia, extra], ignore_index=True)
        gaia = gaia[np.isfinite(gaia.phot_g_mean_mag)].reset_index(drop=True)
    print(f"gaia: {len(gaia)} sources")

    xhip = pd.read_csv(os.path.join(d, "xhip.csv"))
    xhip = xhip[np.isfinite(xhip.RAJ2000)].reset_index(drop=True)
    xmatch = pd.read_csv(os.path.join(d, "hip-gaia.csv")).sort_values("angular_distance").drop_duplicates("hip")
    gaia_row = pd.Series(np.arange(len(gaia)), index=gaia.source_id)
    match = xhip.HIP.map(xmatch.set_index("hip").source_id)  # DR3 source id per HIP star
    row = match.map(gaia_row)  # row in our Gaia table, NaN if not loaded
    has_row = row.notna().to_numpy()
    rows = row.fillna(-1).to_numpy(np.int64)

    g = gaia_stars(gaia)
    gaia_dist = np.where(has_row, g["dist"][np.maximum(rows, 0)], np.nan)
    h = hip_stars(xhip, gaia_dist)
    hp = xhip.Hpmag.to_numpy()
    # Gaia's two-parameter solutions have no parallax or proper motion: Hipparcos is better.
    gaia_pm = np.isfinite(gaia.pmra.to_numpy())
    use_hip = (~has_row) | (hp < 6) | ~gaia_pm[np.maximum(rows, 0)]
    # Gaia rows replaced by their Hipparcos star; Gaia keeps the HIP number otherwise.
    drop = np.zeros(len(gaia), bool)
    drop[rows[use_hip & has_row]] = True
    g["hip"][rows[~use_hip & has_row]] = xhip.HIP.to_numpy(np.int64)[~use_hip & has_row]
    # Hipparcos stars the crossmatch missed: a Gaia star within 3 arcsec and 1.5 mag of a
    # fainter one is the same star (Gaia's astrometry is used); next to a bright one,
    # anything up to 3 mag fainter is a duplicate entry of the bright star and is dropped.
    tree = cKDTree(g["pos"] / np.linalg.norm(g["pos"], axis=1)[:, None])
    gmag = gaia.phot_g_mean_mag.to_numpy()
    hip_ids = xhip.HIP.to_numpy(np.int64)
    for k in np.flatnonzero(use_hip):
        u = h["pos"][k] / np.linalg.norm(h["pos"][k])
        near = tree.query_ball_point(u, 3 * math.pi / 180 / 3600)
        if hp[k] < 6:
            for j in near:
                if gmag[j] < hp[k] + 3:
                    drop[j] = True
        elif not has_row[k] or not gaia_pm[rows[k]]:
            same = [j for j in near if abs(gmag[j] - hp[k]) < 1.5 and not drop[j] and g["hip"][j] < 0 and gaia_pm[j]]
            if same:
                j = min(same, key=lambda j: abs(gmag[j] - hp[k]))
                g["hip"][j] = hip_ids[k]
                use_hip[k] = False
    s = concat(take(g, ~drop), take(h, use_hip))
    print(f"merged: {len(s['pos'])} stars ({int(use_hip.sum())} from Hipparcos, {int(drop.sum())} Gaia rows replaced)")

    # Extinction from the Sun, then dereddened colours and luminosities.
    if args.dust:
        av = Dust(args.dust).extinction_from_sun(s["pos"])
    else:
        av = np.zeros(len(s["pos"]))
    s["avq"] = np.clip(np.round(av / AV_STEP), 0, 255)
    av_q = s["avq"] * AV_STEP
    ebv = av_q / 3.1
    teff = np.where(np.isfinite(s["bprp"]), colours.from_bprp(s["bprp"] - 1.339 * ebv), np.nan)
    teff = np.where(np.isfinite(teff), teff, colours.from_bv(np.nan_to_num(s["bv"], nan=0.65) - ebv))
    s["teff"] = np.clip(teff, T_MIN, T_MIN * T_RATIO)
    dist = np.linalg.norm(s["pos"], axis=1)
    s["absmag"] = s["v"] - av_q - 5 * np.log10(dist / 10)
    # Radius from luminosity and temperature (R_sun): L = 10^(-0.4 (M_bol - 4.74)).
    mbol = s["absmag"] + colours.bolometric_correction(s["teff"])
    s["radius"] = np.sqrt(10 ** (-0.4 * (mbol - 4.74))) * (5772 / s["teff"]) ** 2
    print(f"A_V: median {np.median(av_q):.3f}, 99% {np.percentile(av_q, 99):.2f}; V range {s['v'].min():.2f}..{s['v'].max():.2f}")

    nodes = build_octree(s["pos"], s["absmag"])
    write_octree(s, nodes, args.out)

    # ---- names
    by_hip = {int(hh): i for i, hh in enumerate(s["hip"]) if hh >= 0}
    by_gaia = {int(gg): i for i, gg in enumerate(s["gaia"]) if gg >= 0}
    culture = json.load(open(os.path.join(d, "constellations.json")))
    names, aka = {}, {}
    for key, value in culture.get("common_names", {}).items():
        m = re.match(r"HIP (\d+)", key)
        if m and int(m.group(1)) in by_hip:
            i = by_hip[int(m.group(1))]
            names.setdefault(i, value[0]["english"])
            aka[i] = [v["english"] for v in value[1:] if v.get("english") and v["english"] != value[0]["english"]]
    starnames = json.load(open(os.path.join(os.path.dirname(__file__), "..", "node_modules", "d3-celestial", "data", "starnames.json")))
    desig = {}
    for hip, e in starnames.items():
        i = by_hip.get(int(hip))
        if i is None:
            continue
        label = e.get("bayer") or e.get("flam")
        parts = [label, e.get("c", "")] if label else []
        if parts:
            desig[i] = " ".join(parts)
        if e.get("name") and i not in names:
            names[i] = e["name"]

    # ---- exoplanets
    planets_by_star: dict[int, list] = {}
    host_names = {}
    for r in csv.DictReader(open(os.path.join(d, "exoplanets.csv"))):
        i = None
        if r["gaia_dr3_id"].startswith("Gaia DR3"):
            i = by_gaia.get(int(r["gaia_dr3_id"].split()[-1]))
        if i is None and r["hip_name"].startswith("HIP "):
            i = by_hip.get(int(r["hip_name"].split()[1]))
        if i is None:
            continue

        def num(key, digits=4):
            try:
                return round(float(r[key]), digits)
            except ValueError:
                return None

        planet = {"name": r["pl_name"], "period": num("pl_orbper"), "a": num("pl_orbsmax"), "e": num("pl_orbeccen", 3), "incl": num("pl_orbincl", 2),
                  "radius": num("pl_rade", 3), "mass": num("pl_bmasse", 3), "teq": num("pl_eqt", 0),
                  "method": r["discoverymethod"], "year": int(r["disc_year"]) if r["disc_year"] else None}
        planets_by_star.setdefault(i, []).append({k: v for k, v in planet.items() if v is not None})
        host_names[i] = r["hostname"]
    n_planets = sum(len(p) for p in planets_by_star.values())
    print(f"exoplanets: {n_planets} planets around {len(planets_by_star)} stars")

    index = []
    for i in sorted(set(names) | set(planets_by_star) | set(desig)):
        name = names.get(i) or host_names.get(i) or desig.get(i)
        e = star_entry(s, i, name, desig.get(i, "") if desig.get(i) != name else "")
        if i in host_names and host_names[i] != name:
            e["host"] = host_names[i]
        if aka.get(i):
            e["aka"] = aka[i]
        if i in planets_by_star:
            e["planets"] = sorted(planets_by_star[i], key=lambda p: p.get("a") or p.get("period") or 0)
        index.append(e)
    with open(os.path.join(args.out, "stars", "named.json"), "w") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    print(f"named stars: {len(index)}")

    # ---- constellation figures (Stellarium modern sky culture)
    figures, verts, vert_of = [], [], {}
    for c in culture["constellations"]:
        lines = []
        for poly in c["lines"]:
            ids = []
            for hip in poly:
                i = by_hip.get(int(hip)) if isinstance(hip, int) or str(hip).isdigit() else None
                if i is None:
                    ids.append(-1)
                    continue
                if i not in vert_of:
                    vert_of[i] = len(verts)
                    verts.append([*[f32(v) for v in s["pos"][i]], *[float(np.float16(v)) for v in s["vel"][i]]])
                ids.append(vert_of[i])
            lines.append(ids)
        figures.append({"id": c["id"].split()[-1], "name": c["common_name"].get("english", c["id"]), "lines": lines})
    with open(os.path.join(args.out, "stars", "constellations.json"), "w") as f:
        json.dump({"stars": verts, "figures": figures}, f, separators=(",", ":"))
    print(f"constellations: {len(figures)} figures, {len(verts)} stars")


if __name__ == "__main__":
    main()
