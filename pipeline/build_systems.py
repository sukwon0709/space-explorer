"""Build the star-system data: exoplanet orbits in full and the orbits of binary stars.

Usage:
    python pipeline/build_systems.py DATA_DIR OUT_DIR

Downloads into DATA_DIR/systems/ (once):
  pscomp.csv     NASA Exoplanet Archive planetary systems composite parameters, with the
                 columns named.json leaves out: the time of mid-transit, the time of
                 periastron, the argument of periastron, whether the mass is M sin i
  orb6.txt       USNO Sixth Catalog of Orbits of Visual Binary Stars (Hartkopf, Mason
                 et al.), the orbits themselves
  orb6ephem.txt  the catalogue's own predicted separations and position angles, for the
                 gate test
  gaia-61cyg.csv Gaia DR3 positions of 61 Cyg A and B at 2016.0, for the gate test

Writes OUT_DIR/stars/systems.json:
  planets   per planet (by the archive's name, as in named.json): the orbit's phase and
            orientation, and the host's mass
  binaries  the binary stars drawn as two stars on their measured orbits (see BINARIES)
  featured  the systems listed in the app's Star systems menu
and tests/fixtures/systems-reference.json (ORB6 ephemerides, Gaia's 61 Cyg pair).
"""

import argparse
import csv
import json
import math
import os
import re
import urllib.parse
import urllib.request

EXO_TAP = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync"
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
ORB6 = "https://crf.usno.navy.mil/data_products/WDS/orb6/orb6orbits.txt"
ORB6_EPHEM = "https://crf.usno.navy.mil/data_products/WDS/orb6/orb6ephem.txt"

COLUMNS = (
    "pl_name,hostname,pl_orbper,pl_orbsmax,pl_orbeccen,pl_orbincl,pl_orblper,pl_orbtper,pl_tranmid,"
    "pl_rade,pl_bmasse,pl_bmassprov,pl_eqt,pl_insol,pl_imppar,tran_flag,st_teff,st_rad,st_mass,st_logg,st_met,st_rotp,st_age"
)

# Binary stars drawn on their orbits: ORB6 entry (WDS id and discoverer designation),
# the primary and the companion. Masses are the published dynamical ones; a companion
# missing from the star catalogue gets its temperature and radius here.
BINARIES = [
    {
        "wds": "06451-1643", "pair": "AGC   1AB", "primary": 32349,
        # Bond et al. 2017 (ApJ 840, 70): masses, and Sirius B's temperature and radius.
        "masses": [2.063, 1.018],
        "companion": {"name": "Sirius B", "teff": 25369, "radius": 0.008098, "kind": "white dwarf"},
    },
    {
        "wds": "07393+0514", "pair": "SHB   1AB", "primary": 37279,
        # Bond et al. 2015 (ApJ 813, 106): masses; Procyon B's temperature and radius
        # from Provencal et al. 2002 (ApJ 568, 324).
        "masses": [1.478, 0.592],
        "companion": {"name": "Procyon B", "teff": 7740, "radius": 0.01234, "kind": "white dwarf"},
    },
    {
        "wds": "14396-6050", "pair": "RHD   1AB", "primary": 71683,
        # Akeson et al. 2021 (AJ 162, 14).
        "masses": [1.0788, 0.9092],
        "companion": {"hip": 71681},
    },
    {
        "wds": "21069+3845", "pair": "STF2758AB", "primary": 104214,
        # Kervella et al. 2008 (A&A 488, 667) from the orbit and Hipparcos parallax.
        "masses": [0.70, 0.63],
        "companion": {"hip": 104217},
    },
    {
        "wds": "18055+0230", "pair": "STF2272AB", "primary": 88601,
        # Eggenberger et al. 2008 (A&A 480, 831).
        "masses": [0.89, 0.73],
        "companion": {"name": "70 Oph B", "teff": 4390},
    },
    {
        "wds": "00491+5749", "pair": "STF  60AB", "primary": 3821,
        # Masses from the orbit and Hipparcos parallax, split by the mass-luminosity relation.
        "masses": [0.97, 0.57],
        "companion": {"name": "eta Cas B", "teff": 3900},
    },
]

# The Star systems menu: (star name in named.json, title shown, one line about it).
FEATURED = [
    ("Rigil Kentaurus", "Alpha Centauri A and B", "the nearest stars like the Sun, 4.4 light years away, on an 80 year orbit"),
    ("Proxima", "Proxima Centauri", "the nearest star, a red dwarf with an Earth-mass planet in its habitable zone"),
    ("Barnard's Star", "Barnard's Star", "the second nearest system: four small planets found in 2024 and 2025"),
    ("Sirius", "Sirius A and B", "the brightest star in the sky, with a white dwarf companion the size of Earth"),
    ("Procyon", "Procyon A and B", "a subgiant and another white dwarf"),
    ("Ran", "Epsilon Eridani", "a young Sun-like star with a Jupiter-mass planet"),
    ("Al Naymat II", "Tau Ceti", "a nearby Sun-like star with candidate super-Earths"),
    ("Bessel's Star", "61 Cygni A and B", "two orange dwarfs, the first star whose distance was measured (Bessel, 1838)"),
    ("Luyten's Star", "Luyten's Star", "a red dwarf with a super-Earth in its habitable zone"),
    ("Teegarden's Star", "Teegarden's Star", "a small red dwarf with three Earth-mass planets"),
    ("Ross 128", "Ross 128", "a quiet red dwarf with a temperate Earth-mass planet"),
    ("Lalande 21185", "Lalande 21185", "a red dwarf with two planets, 8.3 light years away"),
    ("TRAPPIST-1", "TRAPPIST-1", "seven Earth-sized planets, all seen to transit, three in the habitable zone"),
    ("LHS 1140", "LHS 1140", "a dense super-Earth that may be a water world"),
    ("TOI-700", "TOI-700", "two Earth-sized planets in a red dwarf's habitable zone"),
    ("Copernicus", "55 Cancri", "five planets, among them 55 Cnc e, a lava world"),
    ("HD 189733", "HD 189733", "a hot Jupiter measured to be deep blue"),
    ("Helvetios", "51 Pegasi", "the first planet found around a Sun-like star (1995)"),
    ("HD 209458", "HD 209458", "the first planet seen to transit its star (1999)"),
    ("KELT-9", "KELT-9", "the hottest known planet, hotter than many stars"),
    ("Kepler-452", "Kepler-452", "a super-Earth on a year-long orbit around a Sun-like star"),
    ("HR 8799", "HR 8799", "four giant planets photographed directly"),
    ("bet Pic", "Beta Pictoris", "a young star with planets photographed directly"),
    ("p Oph", "70 Ophiuchi A and B", "two orange dwarfs on an 88 year orbit"),
    ("Achird", "Eta Cassiopeiae A and B", "a Sun-like star with an orange dwarf companion"),
]


def download(url: str, path: str, data: dict | None = None) -> str:
    if os.path.exists(path):
        return path
    print(f"downloading {url}")
    body = urllib.parse.urlencode(data).encode() if data else None
    tmp = path + ".part"
    with urllib.request.urlopen(urllib.request.Request(url, data=body), timeout=600) as r, open(tmp, "wb") as f:
        f.write(r.read())
    os.replace(tmp, path)
    return path


def num(s: str):
    try:
        v = float(s)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def parse_orb6(path: str) -> dict:
    """ORB6 orbits by (WDS id, designation), in years, arcseconds, degrees, Besselian years."""
    orbits = {}
    for line in open(path, encoding="latin-1"):
        if len(line) < 230 or not line[0].isdigit():
            continue
        wds, pair = line[19:29], line[30:44].strip()

        def f(a, b):
            return num(line[a - 1:b].strip())

        period, punit = f(82, 92), line[92]
        a, aunit = f(106, 114), line[114]
        t0, tunit = f(163, 174), line[174]
        if period is None or a is None or t0 is None:
            continue
        if punit not in "dyc" or aunit not in "amM" or tunit not in "cdmy":
            continue  # a few entries carry unit codes for other cases
        period *= {"d": 1 / 365.25, "y": 1, "c": 100}[punit]
        a *= {"a": 1, "m": 1e-3, "M": 60}[aunit]
        if tunit == "c":
            t0 *= 100
        elif tunit == "d":
            t0 = 1900 + (t0 + 2400000 - 2415020.31352) / 365.242198781
        elif tunit == "m":
            t0 = 1900 + (t0 + 2400000.5 - 2415020.31352) / 365.242198781
        orbits[(wds, " ".join(pair.split()))] = {
            "P": period, "a": a, "i": f(126, 133), "node": f(144, 151), "T": t0,
            "e": f(188, 195), "omega": f(206, 213), "ref": line[237:245].strip(),
            "ascending": line[151] == "*",
        }
    return orbits


def parse_ephem(path: str, wanted: set) -> dict:
    out = {}
    for line in open(path, encoding="latin-1"):
        key = (line[0:10], " ".join(line[11:27].split()))
        if key not in wanted:
            continue
        vals = re.findall(r"\d+\.\d+", line[40:])[:10]
        out[f"{key[0]} {key[1]}"] = [{"year": 2025 + k, "theta": float(vals[2 * k]), "rho": float(vals[2 * k + 1])} for k in range(5)]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("out")
    args = ap.parse_args()
    d = os.path.join(args.data, "systems")
    os.makedirs(d, exist_ok=True)
    download(EXO_TAP, os.path.join(d, "pscomp.csv"), {"query": f"select {COLUMNS} from pscomppars", "format": "csv"})
    download(ORB6, os.path.join(d, "orb6.txt"))
    download(ORB6_EPHEM, os.path.join(d, "orb6ephem.txt"))
    download(GAIA_TAP, os.path.join(d, "gaia-61cyg.csv"), {
        "REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv",
        "QUERY": "SELECT source_id, ra, dec, ref_epoch, parallax FROM gaiadr3.gaia_source WHERE source_id IN (1872046609345556480, 1872046574983497216)",
    })

    named = json.load(open(os.path.join(args.out, "stars", "named.json")))
    by_hip = {s["hip"]: s for s in named if s.get("hip")}
    host_of = {p["name"]: s["name"] for s in named for p in s.get("planets", [])}

    # ---- planets: what named.json leaves out
    planets, hosts = {}, {}
    for r in csv.DictReader(open(os.path.join(d, "pscomp.csv"))):
        star = host_of.get(r["pl_name"])
        if not star:
            continue
        e = {}
        for key, col, digits in (("w", "pl_orblper", 2), ("tc", "pl_tranmid", 6), ("tp", "pl_orbtper", 5), ("b", "pl_imppar", 3), ("insol", "pl_insol", 3)):
            v = num(r[col])
            if v is not None:
                e[key] = round(v, digits)
        if r["pl_bmassprov"].strip().lower() == "msini":
            e["msini"] = 1
        if r["tran_flag"] == "1":
            e["transits"] = 1
        planets[r["pl_name"]] = e
        h = {}
        for key, col, digits in (("mass", "st_mass", 3), ("logg", "st_logg", 2), ("met", "st_met", 2), ("rotp", "st_rotp", 2), ("age", "st_age", 2)):
            v = num(r[col])
            if v is not None:
                h[key] = round(v, digits)
        if h:
            hosts.setdefault(star, {}).update(h)
    print(f"planets: {len(planets)} matched, around {len(hosts)} hosts")

    # ---- binaries
    orbits = parse_orb6(os.path.join(d, "orb6.txt"))
    binaries = []
    for b in BINARIES:
        orbit = orbits[(b["wds"], " ".join(b["pair"].split()))]
        primary = by_hip[b["primary"]]
        comp = dict(b["companion"])
        if "hip" in comp:
            comp["star"] = by_hip[comp.pop("hip")]["name"]
        else:
            # Absolute V from the catalogue's magnitude for B at the primary's distance.
            line = next(l for l in open(os.path.join(d, "orb6.txt"), encoding="latin-1") if l[19:29] == b["wds"] and " ".join(l[30:44].split()) == " ".join(b["pair"].split()))
            v2 = num(line[73:78].strip())
            dist = math.sqrt(sum(x * x for x in primary["pos"]))
            comp["M"] = round(v2 - 5 * math.log10(dist / 10), 2)
        binaries.append({
            "wds": b["wds"], "pair": " ".join(b["pair"].split()), "primary": primary["name"], "primaryHip": b["primary"],
            "masses": b["masses"], "companion": comp,
            # Epoch of the primary's catalogue position and motion: Gaia's 2016.0, or Hipparcos's 1991.25.
            "epoch": 2016.0 if primary.get("gaia") else 1991.25,
            "orbit": {k: (round(v, 6) if isinstance(v, float) else v) for k, v in orbit.items()},
        })
        print(f"binary {primary['name']} + {comp.get('name') or comp.get('star')}: P {orbit['P']:.2f} y, a {orbit['a']:.3f}\" ({orbit['ref']})")

    featured = []
    names = {s["name"] for s in named}
    for star, title, note in FEATURED:
        if star not in names:
            print(f"featured star missing: {star}")
            continue
        featured.append({"star": star, "title": title, "note": note})

    with open(os.path.join(args.out, "stars", "systems.json"), "w") as f:
        json.dump({"planets": planets, "hosts": hosts, "binaries": binaries, "featured": featured}, f, ensure_ascii=False, separators=(",", ":"))

    # ---- gate-test reference: ORB6's own ephemerides, Gaia's 61 Cyg pair
    wanted = {(b["wds"], " ".join(b["pair"].split())) for b in BINARIES}
    rows = list(csv.DictReader(open(os.path.join(d, "gaia-61cyg.csv"))))
    gaia = {r["source_id"]: r for r in rows}
    a, bb = gaia["1872046609345556480"], gaia["1872046574983497216"]
    da = (float(bb["ra"]) - float(a["ra"])) * math.cos(math.radians(float(a["dec"]))) * 3600
    dd = (float(bb["dec"]) - float(a["dec"])) * 3600
    ref = {
        "orb6": parse_ephem(os.path.join(d, "orb6ephem.txt"), wanted),
        "gaia61Cyg": {"year": 2016.0, "rho": math.hypot(da, dd), "theta": math.degrees(math.atan2(da, dd)) % 360},
    }
    fixtures = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "systems-reference.json")
    with open(fixtures, "w") as f:
        json.dump(ref, f, indent=1)
    print(f"reference: {len(ref['orb6'])} ORB6 ephemerides; Gaia 61 Cyg rho {ref['gaia61Cyg']['rho']:.3f}\" theta {ref['gaia61Cyg']['theta']:.2f}")


if __name__ == "__main__":
    main()
