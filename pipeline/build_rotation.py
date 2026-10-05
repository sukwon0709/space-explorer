"""IAU rotation models and radii for every body the app draws, from NAIF's PCK.

Usage:
    python pipeline/build_rotation.py DATA_DIR src/generated/rotation.json \
        --fixtures tests/fixtures/rotation-reference.json

pck00011.tpc carries the IAU WGCCRE 2015 report's pole directions and prime meridians
(right ascension, declination and W as polynomials in time, plus the periodic
nutation-precession terms some systems have) and triaxial radii. Earth and the Moon
are omitted from the rotation table: they use measured orientation (orientation.bin).
"""

import argparse
import json
import os
import re
import urllib.request

PCK = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc"
BODIES = [10, 199, 299, 399, 301, 499, 401, 402, 599, 501, 502, 503, 504, 699, 601, 602, 603, 604, 605, 606, 607, 608, 609,
          799, 701, 702, 703, 704, 705, 899, 801, 999, 901, 2000001, 2000002, 2000004]


def parse(text):
    values = {}
    for block in re.findall(r"\\begindata(.*?)(?:\\begintext|$)", text, flags=re.S):
        for name, op, body in re.findall(r"(\w+)\s*(\+?=)\s*(\([^)]*\)|[^\s(]+)", block):
            nums = [float(v.replace("D", "E").replace("d", "e")) for v in re.findall(r"[-+]?[\d.]+(?:[DdEe][-+]?\d+)?", body)]
            values[name] = values.get(name, []) + nums if op == "+=" else nums
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    parser.add_argument("out")
    parser.add_argument("--fixtures", help="SPICE pxform matrices at random epochs, for tests/rotation.test.ts")
    args = parser.parse_args()
    path = os.path.join(args.data, "pck00011.tpc")
    if not os.path.exists(path):
        urllib.request.urlretrieve(PCK, path)
    v = parse(open(path, encoding="latin-1").read())

    out = {"source": "NAIF pck00011.tpc (IAU WGCCRE 2015)", "bodies": {}, "systems": {}}
    for body in BODIES:
        entry = {"radii": v[f"BODY{body}_RADII"]} if f"BODY{body}_RADII" in v else {}
        # Earth and the Moon use measured orientation; Hyperion tumbles chaotically and has no model.
        if body not in (399, 301) and f"BODY{body}_POLE_RA" in v:
            entry["ra"] = v[f"BODY{body}_POLE_RA"]
            entry["dec"] = v[f"BODY{body}_POLE_DEC"]
            entry["pm"] = v[f"BODY{body}_PM"]
            for key in ("NUT_PREC_RA", "NUT_PREC_DEC", "NUT_PREC_PM"):
                if f"BODY{body}_{key}" in v:
                    entry[key.lower()] = v[f"BODY{body}_{key}"]
        out["bodies"][str(body)] = entry
    for system in range(1, 10):
        if f"BODY{system}_NUT_PREC_ANGLES" in v:
            # Each angle is a polynomial in Julian centuries of this degree (1 unless stated).
            degree = int(v.get(f"BODY{system}_MAX_PHASE_DEGREE", [1])[0])
            out["systems"][str(system)] = {"degree": degree, "angles": v[f"BODY{system}_NUT_PREC_ANGLES"]}
    with open(args.out, "w") as f:
        json.dump(out, f, indent=1)
    print(f"wrote {args.out}: {len(out['bodies'])} bodies, systems {list(out['systems'])}")
    if args.fixtures:
        import numpy as np  # noqa: PLC0415
        import spiceypy as sp  # noqa: PLC0415

        sp.furnsh(path)
        rng = np.random.default_rng(5)
        cases = []
        for body, entry in out["bodies"].items():
            if "pm" not in entry:
                continue
            for et in rng.uniform(-1.26e9, 1.92e9, 6):
                m = sp.pxform("J2000", f"IAU_{sp.bodc2n(int(body))}", float(et))
                cases.append({"body": int(body), "tdb": float(et), "matrix": np.asarray(m).ravel().tolist()})
        with open(args.fixtures, "w") as f:
            json.dump({"source": "spiceypy pxform with pck00011.tpc", "cases": cases}, f)
        print(f"wrote {args.fixtures}: {len(cases)} cases")


if __name__ == "__main__":
    main()
