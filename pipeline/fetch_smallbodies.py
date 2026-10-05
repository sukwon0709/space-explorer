"""Asteroid and comet orbits from the JPL Small-Body Database.

Usage:
    python pipeline/fetch_smallbodies.py public/data

Writes
  asteroids.bin   osculating elements of every numbered asteroid brighter than
                  H = 16 (roughly larger than 2 km) plus every near-Earth asteroid:
                  header b"SBDY", u32 version 1, u32 count, u32 reserved, then count
                  records of 8 float32 (a [AU], e, i, Omega, omega, M [rad] at the
                  epoch, epoch [days past J2000 TDB], H) and count uint8 flags
                  (1 = near-Earth asteroid). Angles are heliocentric ecliptic J2000.
  asteroid-names.json  names and record indexes of the asteroids the search lists:
                  those 100 km or larger, plus well-known visited or hazardous ones.
  comets.json     every comet's perihelion elements (q, e, i, Omega, omega, time of
                  perihelion), full precision.

The app propagates these as two-body orbits, which is good to a few thousand km over
a few years from the epoch for main-belt asteroids (planetary perturbations are not
included) and fine for drawing the belt.
"""

import argparse
import json
import os
import struct
import urllib.parse
import urllib.request

import numpy as np

API = "https://ssd-api.jpl.nasa.gov/sbdb_query.api"
JD_J2000 = 2451545.0
# Visited by spacecraft, hazardous or otherwise famous; always listed in search.
FAMOUS = {"Eros", "Bennu", "Ryugu", "Itokawa", "Apophis", "Didymos", "Psyche", "Lutetia", "Mathilde", "Gaspra", "Ida",
          "Steins", "Annefrank", "Braille", "Toutatis", "Dinkinesh", "Donaldjohanson", "Arrokoth", "Eurybates", "Polymele",
          "Leucus", "Orus", "Patroclus", "Phaethon", "Florence", "Juno", "Eris", "Haumea", "Makemake", "Sedna", "Quaoar",
          "Orcus", "Gonggong", "Varuna", "Ixion", "Chariklo", "Chiron", "Hidalgo", "Hektor", "Kleopatra"}


def query(params):
    url = API + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=600) as r:
        return json.load(r)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out_dir")
    args = parser.parse_args()
    fields = "spkid,full_name,name,a,e,i,om,w,ma,epoch,H,diameter,neo"
    rows = {}
    for extra in ({"sb-ns": "n", "sb-cdata": json.dumps({"AND": ["H|LT|16"]})}, {"sb-group": "neo"}):
        res = query({"fields": fields, "sb-kind": "a", "full-prec": "1", **extra})
        for row in res["data"]:
            rows[row[0]] = dict(zip(res["fields"], row))
        print(f"{extra}: {res['count']} rows")
    items = sorted(rows.values(), key=lambda r: float(r["H"]) if r["H"] else 99)
    items = [r for r in items if r["a"] and r["e"] and float(r["e"]) < 1 and float(r["a"]) > 0]

    rec = np.zeros((len(items), 8), dtype="<f4")
    flags = np.zeros(len(items), dtype=np.uint8)
    names = []
    for k, r in enumerate(items):
        rec[k] = [float(r["a"]), float(r["e"]), np.radians(float(r["i"])), np.radians(float(r["om"])), np.radians(float(r["w"])),
                  np.radians(float(r["ma"])), float(r["epoch"]) - JD_J2000, float(r["H"]) if r["H"] else 18]
        flags[k] = 1 if r["neo"] == "Y" else 0
        name = r["name"]
        if name and ((r["diameter"] and float(r["diameter"]) >= 100) or name in FAMOUS):
            names.append({"name": name, "designation": r["full_name"].strip(), "index": k,
                          "diameter_km": float(r["diameter"]) if r["diameter"] else None})
    with open(os.path.join(args.out_dir, "asteroids.bin"), "wb") as f:
        f.write(struct.pack("<4sIII", b"SBDY", 1, len(items), 0))
        f.write(rec.tobytes())
        f.write(flags.tobytes())
    with open(os.path.join(args.out_dir, "asteroid-names.json"), "w") as f:
        json.dump(names, f, separators=(",", ":"))
    print(f"asteroids: {len(items)} ({int(flags.sum())} near-Earth), {len(names)} named for search")

    res = query({"fields": "full_name,q,e,i,om,w,tp,epoch", "sb-kind": "c", "full-prec": "1"})
    comets = []
    for row in res["data"]:
        r = dict(zip(res["fields"], row))
        if not all(r[k] for k in ("q", "e", "i", "om", "w", "tp")):
            continue
        comets.append({"name": r["full_name"].strip(), "q": float(r["q"]), "e": float(r["e"]), "i": float(r["i"]), "om": float(r["om"]),
                       "w": float(r["w"]), "tp": float(r["tp"]), "epoch": float(r["epoch"])})
    with open(os.path.join(args.out_dir, "comets.json"), "w") as f:
        json.dump({"source": "JPL Small-Body Database", "comets": comets}, f, separators=(",", ":"))
    print(f"comets: {len(comets)}")


if __name__ == "__main__":
    main()
