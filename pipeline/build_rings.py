"""Saturn's ring optical depth profile from a Cassini radio occultation.

Usage:
    python pipeline/build_rings.py DATA_DIR public/data/saturn-rings.json

Source: Cassini Radio Science Subsystem, Rev 7 egress Ka-band occultation
(3 May 2005), normal optical depth at 1 km resolution, PDS Ring-Moon Systems Node
volume CORSS_8001. Where the signal vanished (the B ring core) the profile is
clipped at the measurement's threshold optical depth.
"""

import argparse
import json
import os
import urllib.request

import numpy as np

URL = ("https://pds-rings.seti.org/holdings/volumes/CORSS_8xxx/CORSS_8001/data/Rev007/Rev007E/"
       "Rev007E_RSS_2005_123_K34_E/RSS_2005_123_K34_E_TAU_01KM.TAB")
INNER, OUTER, SAMPLES = 74000.0, 141000.0, 4096


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data")
    parser.add_argument("out")
    args = parser.parse_args()
    path = os.path.join(args.data, os.path.basename(URL))
    if not os.path.exists(path):
        urllib.request.urlretrieve(URL, path)
    table = np.loadtxt(path, delimiter=",", usecols=(0, 6, 8))
    radius, tau, threshold = table.T
    tau = np.clip(np.minimum(tau, threshold), 0, None)
    edges = np.linspace(INNER, OUTER, SAMPLES + 1)
    # Mean transmission per bin (not mean tau), so narrow gaps stay visible.
    which = np.digitize(radius, edges) - 1
    ok = (which >= 0) & (which < SAMPLES)
    trans = np.bincount(which[ok], np.exp(-tau[ok]), SAMPLES) / np.maximum(np.bincount(which[ok], minlength=SAMPLES), 1)
    covered = np.bincount(which[ok], minlength=SAMPLES) > 0
    trans[~covered] = 1.0
    out_tau = -np.log(np.clip(trans, 1e-3, 1))
    with open(args.out, "w") as f:
        json.dump({"source": "Cassini RSS Rev 7 Ka-band occultation, 2005-05-03 (PDS CORSS_8001)", "inner_km": INNER, "outer_km": OUTER,
                   "tau": [round(float(t), 4) for t in out_tau]}, f, separators=(",", ":"))
    print(f"wrote {args.out}: {SAMPLES} samples, max tau {out_tau.max():.2f}")


if __name__ == "__main__":
    main()
