"""Hayabusa2 at Ryugu, relative to Ryugu, from JAXA's own navigation kernels.

Horizons has Hayabusa2's heliocentric trajectory, but differenced against Ryugu's orbit it
puts the spacecraft a few km from the asteroid's centre for the whole stay, when it really
hovered at the "home position" 20 km sunward (Earthward) and made its descents from there.
The mission team archived the proximity trajectory relative to Ryugu (the PDS4 SPICE
archive, data.darts.isas.jaxa.jp):

    lidar_derived_trj_20191114_no6dofc_v03.bsp
        positions from the laser altimeter and images, J2000, in 784 arcs (253 days),
        best where it exists: the descents to 0.5 km from the centre are in it.
    hyb2_hpk_20180627_20191119_v01.bsp
        the home-position keeping trajectory, a sample every 10 minutes for the whole
        stay, in the HP frame (+Z from Ryugu toward Earth, +X toward the Sun; defined
        in hyb2_hp_v01.tf). Its samples are read directly, rotated to J2000 here.

Where both are missing, the trajectory is filled by computation:
  - between samples hours apart, a straight line in the HP frame (where the spacecraft
    holds station);
  - the two touchdowns (2019-02-21 22:29 and 2019-07-11 01:06 UTC), after the laser
    arcs end ~100 m up: straight down onto the shape model at the descent's own pace,
    over the point below the last measured position (in Ryugu's rotating frame), then
    back up at 0.5 m/s, as the spacecraft rose after each touch;
  - where one source hands over to another, the difference fades out over an hour,
    so the path has no jumps;
  - on the approach and departure, Horizons's difference shifted to meet the kernels.
"""

import os
import struct
import urllib.request

import numpy as np

ARCHIVE = "https://data.darts.isas.jaxa.jp/pub/pds4/data/hyb2/hyb2_spice/spice_kernels/spk/"
LIDAR = "lidar_derived_trj_20191114_no6dofc_v03.bsp"
HPK = "hyb2_hpk_20180627_20191119_v01.bsp"
RYUGU = 2162173
J2000_JD = 2451545.0
DAY = 86400.0
TOUCHDOWNS = ["2019-02-21T22:29", "2019-07-11T01:06"]
RISE_KMS = 0.5e-3
BLEND_S = 3600.0
# Faster than the spacecraft ever moved near Ryugu (it hovered and descended at cm/s to
# a few m/s): a step between sources, not motion.
JUMP_KMS = 0.01
FILL_S = 1800.0
LIDAR_STEP_S = 600.0


def fetch(name: str, cache: str) -> str:
    path = os.path.join(cache, name)
    if not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)
        print(f"  downloading {name}", flush=True)
        urllib.request.urlretrieve(ARCHIVE + name, path + ".part")
        os.replace(path + ".part", path)
    return path


def utc_et(text: str) -> float:
    """UTC (ISO, to the minute) to TDB seconds past J2000; TDB - UTC is 69.184 s in 2019."""
    t = (np.datetime64(text) - np.datetime64("2000-01-01T12:00")) / np.timedelta64(1, "s")
    return float(t) + 69.184


def type9_records(path: str) -> tuple[np.ndarray, np.ndarray]:
    """The stored states of every type 9 segment (epochs, n x 6 states), not interpolated."""
    import spiceypy as sp
    h = sp.dafopr(path)
    sp.dafbfs(h)
    eps, sts = [], []
    while sp.daffna():
        _, i = sp.dafus(sp.dafgs(), 2, 6)
        a, b = int(i[4]), int(i[5])
        _, n = [int(x) for x in sp.dafgda(h, b - 1, b)]
        sts.append(np.array(sp.dafgda(h, a, a + 6 * n - 1)).reshape(n, 6))
        eps.append(np.array(sp.dafgda(h, a + 6 * n, a + 7 * n - 1)))
    sp.dafcls(h)
    e = np.concatenate(eps)
    s = np.concatenate(sts)
    order = np.argsort(e, kind="stable")
    e, s = e[order], s[order]
    keep = np.concatenate([[True], np.diff(e) > 1e-3])
    return e[keep], s[keep]


def hermite(t: np.ndarray, tk: np.ndarray, pk: np.ndarray, vk: np.ndarray) -> np.ndarray:
    i = np.clip(np.searchsorted(tk, t) - 1, 0, len(tk) - 2)
    h = (tk[i + 1] - tk[i])[:, None]
    s = ((t - tk[i]) / h[:, 0])[:, None]
    s2, s3 = s * s, s * s * s
    return ((2 * s3 - 3 * s2 + 1) * pk[i] + (s3 - 2 * s2 + s) * h * vk[i]
            + (-2 * s3 + 3 * s2) * pk[i + 1] + (s3 - s2) * h * vk[i + 1])


def rotation(rot: dict, et: float) -> np.ndarray:
    """ICRF to Ryugu's body-fixed frame (IAU style: pole RA/Dec, prime meridian W)."""
    d = et / DAY
    ra, dec = np.radians(rot["ra"][0]), np.radians(rot["dec"][0])
    w = np.radians(rot["pm"][0] + rot["pm"][1] * d)

    def rz(a):
        c, s = np.cos(a), np.sin(a)
        return np.array([[c, s, 0], [-s, c, 0], [0, 0, 1]])

    def rx(a):
        c, s = np.cos(a), np.sin(a)
        return np.array([[1, 0, 0], [0, c, s], [0, -s, c]])

    return rz(w) @ rx(np.pi / 2 - dec) @ rz(np.pi / 2 + ra)


def surface_radius(gravity_bin: str, direction: np.ndarray) -> float:
    """Distance from the centre to the shape model along a body-fixed direction."""
    data = open(gravity_bin, "rb").read()
    nv, nf = struct.unpack_from("<2I", data)
    v = np.frombuffer(data, "<f4", nv * 3, 8).reshape(nv, 3).astype(float)
    f = np.frombuffer(data, "<u4", nf * 3, 8 + nv * 12).reshape(nf, 3)
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    e1, e2 = b - a, c - a
    p = np.cross(direction, e2)
    det = (e1 * p).sum(1)
    ok = np.abs(det) > 1e-12
    inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
    s = -a
    u = (s * p).sum(1) * inv
    q = np.cross(s, e1)
    w = (direction * q).sum(1) * inv
    t = (e2 * q).sum(1) * inv
    hit = ok & (u >= 0) & (w >= 0) & (u + w <= 1) & (t > 0)
    return float(t[hit].max())


def rows(first_jd: float, last_jd: float, horizons_states, cache: str, gravity_bin: str, rot: dict):
    """Ryugu-relative states (jd, (x, y, z, vx, vy, vz)) strictly between first_jd and
    last_jd, meeting Horizons's difference (horizons_states(jds)) at both ends."""
    import spiceypy as sp
    lidar_path, hpk_path = fetch(LIDAR, cache), fetch(HPK, cache)
    sp.furnsh(lidar_path)
    a_et, z_et = (first_jd - J2000_JD) * DAY, (last_jd - J2000_JD) * DAY

    # The HP frame's axes, from Ryugu's and Earth's heliocentric positions (Horizons, daily).
    days = np.arange(np.floor(first_jd), np.ceil(last_jd) + 1.0)
    ry = np.array([s for _, s in horizons_states("DES=2162173;", list(days))])
    ea = np.array([s for _, s in horizons_states("399", list(days))])
    tk = (days - J2000_JD) * DAY

    def hp_axes(et: np.ndarray) -> np.ndarray:
        r = hermite(et, tk, ry[:, :3], ry[:, 3:])
        e = hermite(et, tk, ea[:, :3], ea[:, 3:])
        z = e - r
        z /= np.linalg.norm(z, axis=1, keepdims=True)
        x = -r - z * (-r * z).sum(1, keepdims=True)
        x /= np.linalg.norm(x, axis=1, keepdims=True)
        return np.stack([x, np.cross(z, x), z], 1)  # rows: HP axes in ICRF

    # Station keeping: the HPK samples, in J2000.
    he, hs = type9_records(hpk_path)
    m = (he > a_et) & (he < z_et)
    he, hs = he[m], hs[m]
    hp_j2000 = np.einsum("nji,nj->ni", hp_axes(he), hs[:, :3])

    # Laser arcs, sampled every ten minutes and at their ends.
    cov = sp.spkcov(lidar_path, -37, sp.cell_double(4000))
    arcs = []
    for j in range(sp.wncard(cov)):
        a, b = sp.wnfetd(cov, j)
        if b <= a_et or a >= z_et:
            continue
        a, b = max(a, a_et + 1), min(b, z_et - 1)
        ts = np.unique(np.concatenate([np.arange(a, b, LIDAR_STEP_S), [b]]))
        ps = np.array([sp.spkpos(str(-37), t, "J2000", "NONE", str(RYUGU))[0] for t in ts])
        arcs.append((ts, ps))

    # Touchdowns: down from the end of the last arc before each, onto the surface below.
    for td in TOUCHDOWNS:
        t_td = utc_et(td)
        before = [k for k, (ts, _) in enumerate(arcs) if ts[-1] < t_td]
        if not before or not (a_et < t_td < z_et):
            continue
        ts, ps = arcs[before[-1]]
        t0, p0 = ts[-1], ps[-1]
        b0 = rotation(rot, t0) @ p0
        up = b0 / np.linalg.norm(b0)
        site = up * surface_radius(gravity_bin, up)
        h = np.linalg.norm(b0) - np.linalg.norm(site)
        t_up = t_td + h / RISE_KMS
        t = np.concatenate([np.arange(t0 + 60, t_td, 60.0), [t_td], np.arange(t_td + 60, t_up, 60.0), [t_up]])
        body = [b0 + (site - b0) * (x - t0) / (t_td - t0) if x <= t_td else site + up * RISE_KMS * (x - t_td) for x in t]
        p = np.array([rotation(rot, x).T @ q for x, q in zip(t, body)])
        arcs.insert(before[-1] + 1, (t, p))
        # Drop laser samples (if any) that the computed descent and rise replace.
        arcs = [(x, y) if (x is t) else (x[(x < t0 + 1) | (x > t_up)], y[(x < t0 + 1) | (x > t_up)]) for x, y in arcs]
        arcs = [(x, y) for x, y in arcs if len(x)]
        arcs.sort(key=lambda r: r[0][0])

    # Station-keeping samples outside the trusted arcs, shifted to meet each arc's ends.
    inside = np.zeros(len(he), bool)
    for ts, _ in arcs:
        inside |= (he >= ts[0] - 300) & (he <= ts[-1] + 300)
    he, hp_j2000 = he[~inside], hp_j2000[~inside]

    def hp_at(t: float) -> np.ndarray:
        k = int(np.clip(np.searchsorted(he, t) - 1, 0, len(he) - 2))
        s = (t - he[k]) / (he[k + 1] - he[k])
        return hp_j2000[k] + (hp_j2000[k + 1] - hp_j2000[k]) * np.clip(s, 0, 1)

    shift = np.zeros_like(hp_j2000)
    for ts, ps in arcs:
        for t, p in ((ts[0], ps[0]), (ts[-1], ps[-1])):
            w = np.clip(1 - np.abs(he - t) / BLEND_S, 0, 1)
            shift += w[:, None] * (p - hp_at(t))
    hp_j2000 = hp_j2000 + shift

    t = np.concatenate([he] + [ts for ts, _ in arcs])
    p = np.concatenate([hp_j2000] + [ps for _, ps in arcs])
    trusted = np.concatenate([np.zeros(len(he), bool)] + [np.ones(len(ts), bool) for ts, _ in arcs])
    order = np.argsort(t, kind="stable")
    t, p, trusted = t[order], p[order], trusted[order]
    keep = np.concatenate([[True], np.diff(t) > 1.0])
    t, p, trusted = t[keep], p[keep], trusted[keep]

    # A station-keeping sample far from both neighbours (a bad record) is dropped.
    def speeds(t, p):
        return np.linalg.norm(np.diff(p, axis=0), axis=1) / np.diff(t)
    for _ in range(3):
        s = speeds(t, p)
        bad = np.zeros(len(t), bool)
        bad[1:-1] = (s[:-1] > JUMP_KMS) & (s[1:] > JUMP_KMS) & ~trusted[1:-1]
        t, p, trusted = t[~bad], p[~bad], trusted[~bad]
    # Where one arc or source hands over to the next they can disagree by a km or two:
    # the station-keeping side is shifted to meet the laser arc (or, between two arcs,
    # the later one to meet the earlier), the shift fading out over an hour.
    s = speeds(t, p)
    for k in np.nonzero(s > JUMP_KMS)[0]:
        off = p[k] - p[k + 1]
        if trusted[k + 1] and not trusted[k]:
            w = np.clip(1 - (t[k] - t[:k + 1]) / BLEND_S, 0, 1)
            p[:k + 1] -= w[:, None] * off
        else:
            w = np.clip(1 - (t[k + 1:] - t[k + 1]) / BLEND_S, 0, 1)
            p[k + 1:] += w[:, None] * off

    # Gaps of hours: a straight line in the HP frame.
    ft, fp = [t[0]], [p[0]]
    for k in range(1, len(t)):
        gap = t[k] - t[k - 1]
        if gap > 2 * FILL_S:
            n = int(gap // FILL_S)
            ts = t[k - 1] + gap * np.arange(1, n) / n
            ax0, ax1 = hp_axes(np.array([t[k - 1], t[k]]))
            h0, h1 = ax0 @ p[k - 1], ax1 @ p[k]
            hs_ = h0 + (h1 - h0) * ((ts - t[k - 1]) / gap)[:, None]
            ft += list(ts)
            fp += list(np.einsum("nji,nj->ni", hp_axes(ts), hs_))
        ft.append(t[k])
        fp.append(p[k])
    t, p = np.array(ft), np.array(fp)

    # Approach and departure: Horizons, shifted to meet the first and last positions.
    six = 6 * 3600.0
    pre = np.arange(a_et + six, t[0] - six / 4, six)
    post = np.arange(t[-1] + six, z_et - six / 4, six)
    if len(pre):
        hz = np.array([s for _, s in horizons_states(-37, list(J2000_JD + pre / DAY), RYUGU)])
        h0 = np.array(horizons_states(-37, [J2000_JD + t[0] / DAY], RYUGU)[0][1])
        w = ((pre - a_et) / (t[0] - a_et))[:, None]
        pre_p = hz[:, :3] + w * (p[0] - h0[:3])
    else:
        pre_p = np.zeros((0, 3))
    if len(post):
        hz = np.array([s for _, s in horizons_states(-37, list(J2000_JD + post / DAY), RYUGU)])
        h1 = np.array(horizons_states(-37, [J2000_JD + t[-1] / DAY], RYUGU)[0][1])
        w = ((z_et - post) / (z_et - t[-1]))[:, None]
        post_p = hz[:, :3] + w * (p[-1] - h1[:3])
    else:
        post_p = np.zeros((0, 3))
    t = np.concatenate([pre, t, post])
    p = np.concatenate([pre_p, p, post_p])

    # Velocities: differences of the positions (the laser kernel stores none).
    v = np.gradient(p, t, axis=0, edge_order=1)
    sp.unload(lidar_path)
    return [(J2000_JD + x / DAY, tuple(q) + tuple(u)) for x, q, u in zip(t, p, v)]
