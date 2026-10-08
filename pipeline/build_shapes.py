"""Shape models of the small bodies spacecraft have visited, cut into level-of-detail
chunks the app streams as the camera comes close (src/core/shape.ts).

Usage:
    python pipeline/build_shapes.py DATA_DIR public/data/shapes \
        --fixtures tests/fixtures/shapes-reference.json [--only bennu,ryugu]

Each model is the mission team's own: stereophotoclinometry, laser altimetry or
structure-from-motion meshes, as archived with NAIF, ESA, JAXA or the PDS (SOURCES).
They are closed triangle meshes in the body-fixed frame of the body's rotation model,
in km, centred on the centre of mass.

The finest level keeps at most `cap` triangles (a million for Bennu and Ryugu: edges
about 1.1 m and 1.6 m long). Above it sits an octree: the root holds the whole body
simplified to BUDGET triangles (quadric edge collapse); each child holds the triangles
whose centroids fall in its octant, simplified again to BUDGET, down to octants that
hold no more than BUDGET triangles at full resolution. The app draws a node when its
error, seen from the camera, is under a pixel or so, and otherwise its children.
Simplification keeps each cell's open edges, so neighbouring chunks of any levels meet
along the same vertices; every chunk also has a skirt (its open edges extended a little
way into the body) against cracks from rounding.

Output, per body:
    <slug>/index.json   nodes (octree path, error, file and byte range), constants
and src/generated/shapes.json, every body's constants (name, NAIF id, GM, rotation).
    <slug>/top.bin      the root and its eight children
    <slug>/g<ab>.bin    one octant of the second level and everything below it
    <slug>/gravity.bin  the body simplified to about GRAVITY_FACES triangles, for its
                        gravity field (a constant-density polyhedron, Werner & Scheeres 1997)

Chunk layout (little-endian): u32 vertex count, u32 index count, f32 box min x/y/z,
f32 box size, f32 error (km), u32 flags (bit 0: 32-bit indices; the rest: how many
triangles come before the skirt's), then u16 x/y/z per vertex
(quantised over the box), i8 x/y per vertex (octahedral normal), padding to 4 bytes,
then u16 or u32 indices.
"""

import argparse
import base64
import io
import json
import math
import os
import re
import struct
import sys
import urllib.parse
import urllib.request

import numpy as np

BUDGET = 8192
GRAVITY_FACES = 4096
G = 6.6743e-20  # km^3 kg^-1 s^-2

NAIF = "https://naif.jpl.nasa.gov/pub/naif/"
ESA = "https://spiftp.esac.esa.int/data/SPICE/"

# slug: (NAIF id, name, shape model URL, triangle cap). Physical constants are in BODIES below.
SOURCES = {
    # OSIRIS-REx OLA laser altimetry global model v21a, 0.88 m ground sample (Barnouin et al. 2020; Daly et al. 2020).
    "bennu": (2101955, "Bennu", NAIF + "pds/pds4/orex/orex_spice/spice_kernels/dsk/bennu_g_00880mm_alt_obj_0000n00000_v021a.bds", 1_000_000),
    # Hayabusa2 ONC structure-from-motion model, 3 million facets (Watanabe et al. 2019, 2020 update).
    "ryugu": (2162173, "Ryugu", NAIF + "pds/pds4/hyb2/hyb2_spice/spice_kernels/dsk/ryugu_shape_sfm_3m_v20200815.bds", 1_000_000),
    # Hayabusa AMICA stereophotoclinometry (Gaskell et al. 2008), 512 quadrants a side.
    "itokawa": (2025143, "Itokawa", NAIF + "generic_kernels/dsk/asteroids/itokawa/hay_a_amica_5_itokawashape_v1_0_512q.bds", 600_000),
    # NEAR Shoemaker MSI stereophotoclinometry (Gaskell 2008).
    "eros": (2000433, "Eros", NAIF + "generic_kernels/dsk/asteroids/eros/near-a-msi-5-erosshape-v1_0_512q.bds", 600_000),
    # Rosetta OSIRIS stereophotogrammetry (DLR, Preusker et al. 2017), 1 million facets.
    "67p": (1000012, "67P/Churyumov-Gerasimenko", ESA + "ROSETTA/kernels/dsk/ROS_CG_M001_OSPGDLR_N_V1.OBJ", 600_000),
    # New Horizons LORRI (Porter et al. 2024).
    "arrokoth": (2486958, "Arrokoth", "https://pdssbn.astro.umd.edu/holdings/pds4-nh_derived-v3.0/arrokoth_shapemodel_porter2024/arrokoth_porter_2024_v01.obj", 1_000_000),
    # DART DRACO and LICIACube stereophotoclinometry, as Hera's kernels carry them (Daly et al. 2023/2024).
    "didymos": (2065803, "Didymos", ESA + "HERA/kernels/dsk/g_01165mm_spc_obj_didy_0000n00000_v003.obj", 600_000),
    "dimorphos": (120065803, "Dimorphos", ESA + "HERA/kernels/dsk/g_00243mm_spc_obj_dimo_0000n00000_v004.obj", 400_000),
    # Rosetta flybys (OSIRIS, Jorda et al. 2012 for Steins; Preusker/Jorda for Lutetia).
    "lutetia": (2000021, "Lutetia", ESA + "ROSETTA/kernels/dsk/ROS_LU_K780_OSPCLAM_N_V1.OBJ", 500_000),
    "steins": (2002867, "Šteins", ESA + "ROSETTA/kernels/dsk/ROS_ST_K020_OSPCLAM_N_V1.OBJ", 1_000_000),
    # Deep Impact and Stardust-NExT (Thomas et al. 2013).
    "tempel-1": (1000093, "Tempel 1", ESA + "ROSETTA/kernels/dsk/TEMPEL1_9P_K032_THO_V01.OBJ", 1_000_000),
    # Lucy L'LORRI (Lucy team, 2025).
    "donaldjohanson": (20052246, "Donaldjohanson", NAIF + "LUCY/kernels/dsk/lcy_donj_k548_iso20m_v10.bds", 400_000),
}

PCKS = {
    "pck00011.tpc": NAIF + "generic_kernels/pck/pck00011.tpc",
    "bennu_v17.tpc": NAIF + "pds/pds4/orex/orex_spice/spice_kernels/pck/bennu_v17.tpc",
    "ryugu_v10.tpc": NAIF + "pds/pds4/hyb2/hyb2_spice/spice_kernels/pck/ryugu_v10.tpc",
    "donaldjohanson_v12.tpc": NAIF + "LUCY/kernels/pck/donaldjohanson_v12.tpc",
}

# Mass (GM, km^3/s^2) where a spacecraft measured it from its own orbit or flyby; for
# the rest a density is assumed and GM follows from the model's volume.
#   Bennu 4.892 m^3/s^2 (Scheeres et al. 2019); Ryugu 29.8 (Watanabe et al. 2019,
#   ryugu_v10.tpc); Itokawa 3.51e10 kg (Fujiwara et al. 2006); Eros 4.4631e-4 km^3/s^2
#   (Miller et al. 2002); 67P 9.982e12 kg (Paetzold et al. 2016); Lutetia 1.700e18 kg
#   (Paetzold et al. 2011); Didymos system 5.6e11 kg, Dimorphos 4.3e9 kg (Daly et al. 2024).
# Assumed densities (kg/m^3): Arrokoth 235, where its slopes are lowest (Keane et al.
# 2022); Tempel 1 470 (Thomas et al. 2013, 400-600); Steins 1800 and Donaldjohanson 1500
# (typical of E- and C-type rubble).
BODIES = {
    "bennu": dict(kind="asteroid", gm=4.892e-9, albedo=0.044, color="#555250", rotation="bennu_v17.tpc",
                  boulders=dict(cover=0.5, slope=-2.9, max=40.0)),
    "ryugu": dict(kind="asteroid", gm=2.98e-8, albedo=0.045, color="#4e4b48", rotation="ryugu_v10.tpc",
                  boulders=dict(cover=0.5, slope=-2.65, max=60.0)),
    "itokawa": dict(kind="asteroid", gm=3.51e10 * G, albedo=0.24, color="#9b8f7d", rotation="pck00011.tpc",
                    boulders=dict(cover=0.35, slope=-3.1, max=20.0)),
    "eros": dict(kind="asteroid", gm=4.4631e-4, albedo=0.25, color="#a0907a", rotation="pck00011.tpc",
                 boulders=dict(cover=0.05, slope=-3.2, max=100.0)),
    "67p": dict(kind="comet", gm=9.982e12 * G, albedo=0.065, color="#4a4744", rotation="pck00011.tpc",
                boulders=dict(cover=0.1, slope=-3.6, max=30.0)),
    "arrokoth": dict(kind="kbo", density=235, albedo=0.21, color="#8a5a44",
                     rotation=dict(ra=[317.4880752, 0, 0], dec=[-24.8876496, 0, 0], pm=[184.4589465, 360 / 0.6632553, 0]),
                     boulders=dict(cover=0.0, slope=-3.0, max=1.0)),
    "didymos": dict(kind="asteroid", gm=(5.6e11 - 4.3e9) * G, albedo=0.15, color="#857d72",
                    rotation=dict(ra=[78.21828945997879, 0, 0], dec=[-70.78798538514438, 0, 0], pm=[0, 3823.0088495575224, 0]),
                    boulders=dict(cover=0.4, slope=-2.7, max=30.0)),
    "dimorphos": dict(kind="moon", gm=4.3e9 * G, albedo=0.15, color="#857d72", parent="didymos",
                      boulders=dict(cover=0.6, slope=-2.6, max=8.0)),
    "lutetia": dict(kind="asteroid", gm=1.700e18 * G, albedo=0.19, color="#8a857e", rotation="pck00011.tpc",
                    boulders=dict(cover=0.02, slope=-3.0, max=300.0)),
    "steins": dict(kind="asteroid", density=1800, albedo=0.39, color="#a49c92", rotation="pck00011.tpc",
                   boulders=dict(cover=0.1, slope=-3.0, max=40.0)),
    "tempel-1": dict(kind="comet", density=470, albedo=0.056, color="#4b4844", rotation="pck00011.tpc",
                     boulders=dict(cover=0.05, slope=-3.0, max=20.0)),
    "donaldjohanson": dict(kind="asteroid", density=1500, albedo=0.10, color="#6a6560", rotation="donaldjohanson_v12.tpc",
                           boulders=dict(cover=0.2, slope=-3.0, max=40.0)),
}


def fetch(url: str, path: str) -> str:
    if not os.path.exists(path):
        print(f"downloading {url}", flush=True)
        tmp = path + ".part"
        urllib.request.urlretrieve(url, tmp)
        os.replace(tmp, path)
    return path


# ---- reading meshes --------------------------------------------------------------

def read_dsk(path: str):
    import spiceypy as sp
    handle = sp.dasopr(path)
    dla = sp.dlabfs(handle)
    nv, nplates = sp.dskz02(handle, dla)
    verts = np.empty((nv, 3))
    plates = np.empty((nplates, 3), dtype=np.int64)
    step = 100_000
    for s in range(0, nv, step):
        n = min(step, nv - s)
        verts[s:s + n] = sp.dskv02(handle, dla, s + 1, n)
    for s in range(0, nplates, step):
        n = min(step, nplates - s)
        plates[s:s + n] = sp.dskp02(handle, dla, s + 1, n)
    sp.dascls(handle)
    return verts, plates - 1


def read_obj(path: str):
    verts, faces = [], []
    with open(path, encoding="latin-1") as f:
        for line in f:
            parts = line.split()
            if not parts:
                continue
            if parts[0] == "v":
                verts.append((float(parts[1]), float(parts[2]), float(parts[3])))
            elif parts[0] == "f":
                faces.append([int(p.split("/")[0]) for p in parts[1:4]])
    return np.array(verts), np.array(faces, dtype=np.int64) - 1


def clean(verts, faces):
    """Merge duplicate vertices, drop degenerate and unused ones, and orient faces outward."""
    key = np.round(verts / 1e-7).astype(np.int64)
    _, first, inverse = np.unique(key, axis=0, return_index=True, return_inverse=True)
    verts = verts[first]
    faces = inverse.reshape(-1)[faces]
    ok = (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 2] != faces[:, 0])
    faces = faces[ok]
    used = np.unique(faces)
    remap = np.full(len(verts), -1)
    remap[used] = np.arange(len(used))
    verts, faces = verts[used], remap[faces]
    if signed_volume(verts, faces) < 0:
        faces = faces[:, ::-1].copy()
    return verts, faces


def signed_volume(verts, faces):
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    return np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6


def centroid(verts, faces):
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    v = np.einsum("ij,ij->i", a, np.cross(b, c)) / 6
    return ((a + b + c) / 4 * v[:, None]).sum(0) / v.sum()


def area(verts, faces):
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    return 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)


def simplify(verts, faces, target):
    import fast_simplification
    if len(faces) <= target:
        return verts, faces
    v, f = fast_simplification.simplify(verts.astype(np.float64), faces.astype(np.int64), target_reduction=1 - target / len(faces), agg=7)
    return np.asarray(v, dtype=np.float64), np.asarray(f, dtype=np.int64)


def simplify_chunk(verts, faces, target):
    """Simplify an octree cell, keeping its open edges exactly: the cells next to it,
    at whatever level, then meet it along the same full-resolution vertices."""
    import pyfqmr
    if len(faces) <= target:
        return verts, faces
    s = pyfqmr.Simplify()
    s.setMesh(verts.astype(np.float64), faces.astype(np.int32))
    s.simplify_mesh(target_count=target, aggressiveness=7, preserve_border=True, verbose=False)
    v, f, _ = s.getMesh()
    return np.asarray(v, dtype=np.float64), np.asarray(f, dtype=np.int64)


def compact(verts, faces):
    used, inverse = np.unique(faces, return_inverse=True)
    return verts[used], inverse.reshape(faces.shape)


def vertex_normals(verts, faces):
    n = np.zeros_like(verts)
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    fn = np.cross(b - a, c - a)
    for k in range(3):
        np.add.at(n, faces[:, k], fn)
    length = np.linalg.norm(n, axis=1, keepdims=True)
    return n / np.maximum(length, 1e-30)


def oct_encode(n):
    n = n / np.abs(n).sum(1, keepdims=True)
    x, y = n[:, 0].copy(), n[:, 1].copy()
    neg = n[:, 2] < 0
    x[neg], y[neg] = (1 - np.abs(n[neg, 1])) * np.sign(n[neg, 0] + 1e-30), (1 - np.abs(n[neg, 0])) * np.sign(n[neg, 1] + 1e-30)
    return np.clip(np.round(np.stack([x, y], 1) * 127), -127, 127).astype(np.int8)


def boundary_edges(faces):
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    key = np.sort(e, axis=1)
    _, inv, counts = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    # Open edges, kept in their face's winding so the skirt faces outward.
    return e[counts[inv.reshape(-1)] == 1]


def mean_edge(verts, faces):
    a, b = verts[faces[:, 0]], verts[faces[:, 1]]
    return float(np.linalg.norm(a - b, axis=1).mean())


# ---- the level-of-detail octree ---------------------------------------------------

def chunk_bytes(verts, faces, error, skirt):
    """One chunk: the mesh plus a skirt hanging `skirt` km inward from its open edges."""
    normals = vertex_normals(verts, faces)
    surface = len(faces)
    open_edges = boundary_edges(faces)
    if len(open_edges):
        ends = np.unique(open_edges)
        drop = np.full(len(verts), -1)
        drop[ends] = len(verts) + np.arange(len(ends))
        verts = np.concatenate([verts, verts[ends] - normals[ends] * skirt])
        normals = np.concatenate([normals, normals[ends]])
        a, b = open_edges[:, 0], open_edges[:, 1]
        # The face used a -> b; the skirt quad b, a, a', b' continues it downward.
        quads = np.concatenate([np.stack([b, a, drop[a]], 1), np.stack([b, drop[a], drop[b]], 1)])
        faces = np.concatenate([faces, quads])
    lo = verts.min(0)
    size = float((verts.max(0) - lo).max()) or 1e-6
    q = np.round((verts - lo) / size * 65535).astype(np.uint16)
    wide = len(verts) > 65535
    out = io.BytesIO()
    out.write(struct.pack("<2I5fI", len(verts), faces.size, *lo, size, error, surface << 1 | (1 if wide else 0)))
    out.write(q.tobytes())
    out.write(oct_encode(normals).tobytes())
    out.write(b"\0" * (-out.tell() % 4))
    out.write(faces.astype(np.uint32 if wide else np.uint16).tobytes())
    return out.getvalue()


def build_octree(verts, faces, half):
    """Nodes as (path, depth, verts, faces, error, leaf)."""
    nodes = []
    cent = verts[faces].mean(1)

    def visit(path, idx, lo, size, parent_error):
        sub_v, sub_f = compact(verts, faces[idx])
        leaf = len(idx) <= BUDGET
        if leaf:
            # Full resolution: the error that is left is the model's own resolution.
            sv, sf = sub_v, sub_f
            error = 0.0
        else:
            sv, sf = simplify_chunk(sub_v, sub_f, BUDGET)
            sv, sf = compact(sv, sf)
            # About a third of a simplified triangle's edge: how far its flat face strays from the detail it replaced.
            error = 0.35 * mean_edge(sv, sf)
        skirt = 2.5 * max(error, parent_error * 0.5, 0.5 * mean_edge(sub_v, sub_f))
        nodes.append(dict(path=path, verts=sv, faces=sf, error=error, leaf=leaf, skirt=skirt, count=len(idx)))
        print(f"  node {path or 'root'}: {len(idx)} -> {len(sf)} faces, error {error * 1000:.2f} m", flush=True)
        if leaf:
            return
        h = size / 2
        octant = ((cent[idx] - lo) >= h).astype(int)
        code = octant[:, 0] + 2 * octant[:, 1] + 4 * octant[:, 2]
        for k in range(8):
            sel = idx[code == k]
            if len(sel):
                off = np.array([k & 1, (k >> 1) & 1, (k >> 2) & 1]) * h
                visit(path + str(k), sel, lo + off, h, error)

    visit("", np.arange(len(faces)), np.full(3, -half), 2 * half, 0.0)
    return nodes


# ---- rotation models ---------------------------------------------------------------

def parse_pck(text):
    values = {}
    for block in re.findall(r"\\begindata(.*?)(?:\\begintext|$)", text, flags=re.S):
        for name, op, body in re.findall(r"(\w+)\s*(\+?=)\s*(\([^)]*\)|[^\s(]+)", block):
            nums = [float(v.replace("D", "E").replace("d", "e")) for v in re.findall(r"[-+]?[\d.]+(?:[DdEe][-+]?\d+)?", body)]
            values[name] = values.get(name, []) + nums if op == "+=" else nums
    return values


def rotation_for(slug, naif, spec, data):
    rot = spec.get("rotation")
    if rot is None:
        return None
    if isinstance(rot, dict):
        return rot
    v = parse_pck(open(fetch(PCKS[rot], os.path.join(data, rot)), encoding="latin-1").read())
    return {"ra": v[f"BODY{naif}_POLE_RA"], "dec": v[f"BODY{naif}_POLE_DEC"], "pm": v[f"BODY{naif}_PM"]}


# ---- gravity: a constant-density polyhedron (Werner & Scheeres 1997) ----------------

def polyhedron_gravity(verts, faces, density_g, points):
    """Acceleration (km/s^2) at points from a homogeneous polyhedron; density_g = G * rho."""
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    fn = np.cross(b - a, c - a)
    fn /= np.linalg.norm(fn, axis=1, keepdims=True)
    F = fn[:, :, None] * fn[:, None, :]
    edges = {}
    for f, tri in enumerate(faces):
        for i in range(3):
            p, q = tri[i], tri[(i + 1) % 3]
            ra, rb = verts[p], verts[q]
            # Outward edge normal in the face's plane.
            ne = np.cross(rb - ra, fn[f])
            ne /= np.linalg.norm(ne)
            key = (min(p, q), max(p, q))
            edges.setdefault(key, []).append(np.outer(fn[f], ne))
    E_list, E_end = [], []
    for (p, q), mats in edges.items():
        # Usually two faces; four where simplification pinched the surface together.
        E_list.append(sum(mats))
        E_end.append((p, q))
    E = np.array(E_list)
    ends = np.array(E_end)
    out = []
    for x in points:
        r1, r2, r3 = a - x, b - x, c - x
        l1, l2, l3 = (np.linalg.norm(r, axis=1) for r in (r1, r2, r3))
        num = np.einsum("ij,ij->i", r1, np.cross(r2, r3))
        den = l1 * l2 * l3 + l1 * np.einsum("ij,ij->i", r2, r3) + l2 * np.einsum("ij,ij->i", r3, r1) + l3 * np.einsum("ij,ij->i", r1, r2)
        w = 2 * np.arctan2(num, den)
        ea, eb = verts[ends[:, 0]] - x, verts[ends[:, 1]] - x
        la, lb = np.linalg.norm(ea, axis=1), np.linalg.norm(eb, axis=1)
        le = np.linalg.norm(verts[ends[:, 0]] - verts[ends[:, 1]], axis=1)
        L = np.log((la + lb + le) / (la + lb - le))
        acc = -np.einsum("eij,ej,e->i", E, ea, L) + np.einsum("fij,fj,f->i", F, r1, w)
        out.append(density_g * acc)
    return np.array(out)


# ---- main ------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    parser.add_argument("out")
    parser.add_argument("--fixtures")
    parser.add_argument("--catalogue", default="src/generated/shapes.json", help="bodies' constants for the app")
    parser.add_argument("--only")
    args = parser.parse_args()
    shapes_dir = os.path.join(args.data, "shapes")
    os.makedirs(shapes_dir, exist_ok=True)
    fixtures = {}
    if args.fixtures and os.path.exists(args.fixtures):
        fixtures = json.load(open(args.fixtures))
    catalogue_path = args.catalogue
    catalogue = json.load(open(catalogue_path)) if os.path.exists(catalogue_path) else {"bodies": {}}
    rng = np.random.default_rng(7)

    for slug, (naif, name, url, cap) in SOURCES.items():
        if args.only and slug not in args.only.split(","):
            continue
        spec = BODIES[slug]
        print(f"{name}: {url}", flush=True)
        src = fetch(url, os.path.join(shapes_dir, os.path.basename(urllib.parse.urlparse(url).path)))
        verts, faces = read_dsk(src) if src.lower().endswith(".bds") else read_obj(src)
        verts, faces = clean(verts, faces)
        full_volume = signed_volume(verts, faces)
        full_faces = len(faces)
        com = centroid(verts, faces)
        if len(faces) > cap:
            verts, faces = simplify(verts, faces, cap)
            verts, faces = clean(verts, faces)
        volume = signed_volume(verts, faces)
        radii = np.linalg.norm(verts, axis=1)
        half = float(np.abs(verts).max()) * 1.0001
        print(f"  {full_faces} faces in the model, {len(faces)} kept; volume {full_volume:.6g} km^3 ({volume:.6g} kept), "
              f"centre of figure offset {np.linalg.norm(com) * 1000:.1f} m", flush=True)

        density = spec.get("density")
        gm = spec.get("gm") or G * density * 1e9 * volume
        gv, gf = simplify(verts, faces, GRAVITY_FACES)
        gv, gf = clean(*compact(gv, gf))
        gravity_volume = signed_volume(gv, gf)

        out_dir = os.path.join(args.out, slug)
        os.makedirs(out_dir, exist_ok=True)
        for f in os.listdir(out_dir):
            os.remove(os.path.join(out_dir, f))
        with open(os.path.join(out_dir, "gravity.bin"), "wb") as f:
            f.write(struct.pack("<2I", len(gv), len(gf)))
            f.write(gv.astype("<f4").tobytes())
            f.write(gf.astype("<u4").tobytes())

        nodes = build_octree(verts, faces, half)
        files: dict[str, io.BytesIO] = {}
        index_nodes = []
        for node in nodes:
            file = "top" if len(node["path"]) <= 1 else "g" + node["path"][:2]
            buf = files.setdefault(file, io.BytesIO())
            data = chunk_bytes(node["verts"], node["faces"], node["error"], node["skirt"])
            index_nodes.append([node["path"], file, buf.tell(), len(data), round(node["error"], 7), 1 if node["leaf"] else 0])
            buf.write(data)
        total = 0
        for file, buf in files.items():
            with open(os.path.join(out_dir, file + ".bin"), "wb") as f:
                f.write(buf.getvalue())
            total += buf.tell()
        print(f"  {len(nodes)} nodes in {len(files)} files, {total / 1e6:.1f} MB", flush=True)

        rotation = rotation_for(slug, naif, spec, args.data)
        entry = {
            "id": naif, "name": name, "kind": spec["kind"], "source": os.path.basename(src),
            "faces": full_faces, "kept": len(faces), "volume": volume, "gm": gm, "gmMeasured": "gm" in spec,
            "density": gm / G / volume / 1e9, "albedo": spec["albedo"], "color": spec["color"],
            "radius": float(radii.max()), "meanRadius": float((3 * volume / 4 / math.pi) ** (1 / 3)),
            "minRadius": float(radii.min()), "extents": np.abs(verts).max(axis=0).round(6).tolist(), "half": half, "gravityScale": volume / gravity_volume,
            "rotation": rotation, "parent": spec.get("parent"), "boulders": spec["boulders"],
            "resolution": mean_edge(verts, faces), "nodes": index_nodes,
        }
        with open(os.path.join(out_dir, "index.json"), "w") as f:
            json.dump(entry, f, separators=(",", ":"))
        catalogue["bodies"][slug] = {k: entry[k] for k in ("id", "name", "kind", "radius", "meanRadius", "minRadius", "extents", "resolution", "gm", "albedo", "color", "rotation", "parent")}

        # Reference gravity at points around and on the body (independent numpy implementation).
        dirs = rng.normal(size=(6, 3))
        dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
        pts = np.concatenate([dirs * radii.max() * 1.5, dirs[:3] * radii.max() * 6])
        acc = polyhedron_gravity(gv, gf, gm / gravity_volume, pts)
        fixtures[slug] = {
            "id": naif, "volume": volume, "fullVolume": full_volume, "gm": gm,
            "points": pts.tolist(), "accel": acc.tolist(),
        }
    with open(catalogue_path, "w") as f:
        json.dump(catalogue, f, indent=1)
    if args.fixtures:
        with open(args.fixtures, "w") as f:
            json.dump(fixtures, f)


if __name__ == "__main__":
    main()
