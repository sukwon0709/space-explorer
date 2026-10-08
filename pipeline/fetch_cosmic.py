"""Data for the live cosmic events (src/events.ts): public/data/cosmic/.

- sn1987a.json: SN 1987A's UVOIR bolometric light curve, days 14-935 after the neutrino
  burst (Suntzeff et al. 1991, AJ 102, 1118; with Bouchet et al. 1991, A&A 245, 490,
  table 6), as transcribed by D. Jeffery (UNLV).
- gw150914.json: what LIGO recorded on 2015-09-14 (GWOSC, the data behind figures 1 and 2
  of Abbott et al. 2016, PRL 116, 061102): Hanford's and Livingston's strain, band-passed
  35-350 Hz; the numerical-relativity waveform filtered the same way and unfiltered;
  the GWTC-1 parameters; and the most probable point of the GWTC-1 sky map.
- pms.json: pre-main-sequence tracks for 0.7 and 0.8 solar masses (Baraffe et al. 2015).

Usage: python3 pipeline/fetch_cosmic.py public/data/cosmic [--cache /tmp/claude-0/data/events]
The sky map needs healpy (pip install healpy).
"""
import argparse
import json
import os
import urllib.request

import numpy as np

JEFFERY = 'https://www.physics.unlv.edu/~jeffery/astro/supernovae/spectra/d1980/sn1987a_II/'
GWOSC = 'https://gwosc.org/GW150914data/P150914/'
EVENT = 'https://gwosc.org/eventapi/json/GWTC-1-confident/GW150914/v3/'
SKYMAP = 'https://dcc.ligo.org/public/0157/P1800381/007/GW150914_skymap.fits.gz'
BHAC15 = 'https://perso.ens-lyon.fr/isabelle.baraffe/BHAC15dir/BHAC15_tracks+structure'


def fetch(url, cache):
    path = os.path.join(cache, url.rstrip('/').split('/')[-1] or 'index')
    if not os.path.exists(path):
        with urllib.request.urlopen(url, timeout=120) as r, open(path, 'wb') as f:
            f.write(r.read())
    return path


def bolometric(cache):
    rows = []
    for line in open(fetch(JEFFERY + 'lc_bol2.dat', cache)):
        parts = line.split()
        try:
            day, logl = float(parts[0]), float(parts[1])
        except (ValueError, IndexError):
            continue
        table = int(parts[2]) if len(parts) > 2 else 5
        # Table 6 is Bouchet et al.; the rest Suntzeff et al.
        rows.append([day, logl, 'B91' if table == 6 else 'S91'])
    return {
        'source': 'UVOIR bolometric luminosity, log10 erg/s; S91: Suntzeff et al. 1991 (AJ 102, 1118), '
                  'B91: Bouchet et al. 1991 (A&A 245, 490, table 6). Day 0 is the neutrino burst, 1987-02-23 07:35:35 UT.',
        'points': rows,
    }


def strain(cache, name):
    d = np.loadtxt(fetch(GWOSC + name, cache))
    return d[:, 0], d[:, 1]


def gw150914(cache):
    t, h_obs = strain(cache, 'fig1-observed-H.txt')
    _, l_obs = strain(cache, 'fig1-observed-L.txt')
    tw, h_nr = strain(cache, 'fig1-waveform-H.txt')
    _, l_nr = strain(cache, 'fig1-waveform-L.txt')
    tu, h_raw = strain(cache, 'fig2-unfiltered-waveform-H.txt')
    event = json.load(open(fetch(EVENT, cache)))
    e = next(iter(event['events'].values()))
    pe = e['parameters']['gwtc1_pe_GW150914']
    keep = ['mass_1_source', 'mass_2_source', 'chirp_mass_source', 'final_mass_source', 'a_final', 'E_rad', 'L_peak',
            'luminosity_distance', 'redshift', 'chi_eff', 'sky_area']
    params = {k: [pe[k], pe.get(k + '_lower'), pe.get(k + '_upper')] for k in keep}

    import healpy as hp
    m = hp.read_map(fetch(SKYMAP, cache), field=0)
    k = int(np.argmax(m))
    theta, phi = hp.pix2ang(hp.npix2nside(len(m)), k)
    r = lambda a: [float(f'{x:.4g}') for x in a]
    return {
        'source': 'LIGO Open Science Center: GW150914 figure data (Abbott et al. 2016, PRL 116, 061102), GWTC-1 parameters '
                  'and sky map (Abbott et al. 2019, PRX 9, 031040). Strain x 1e21; time in seconds after 2015-09-14 09:50:45 UTC '
                  '(GPS 1126259462). Livingston as recorded: it saw the wave about 7 ms before Hanford, with the opposite sign.',
        'gps': 1126259462,
        'utc': '2015-09-14T09:50:45Z',
        'params': params,
        'sky': {'ra': float(np.degrees(phi)), 'dec': float(90 - np.degrees(theta))},
        # The filtered traces (figure 1) share one time grid; the unfiltered one (figure 2) its own.
        't0': float(t[0]), 'dt': float((t[-1] - t[0]) / (len(t) - 1)),
        'observedH': r(h_obs), 'observedL': r(l_obs), 'nrH': r(h_nr[: len(t)]), 'nrL': r(l_nr[: len(t)]),
        'nrT0': float(tw[0]),
        'unfilteredT0': float(tu[0]), 'unfilteredDt': float((tu[-1] - tu[0]) / (len(tu) - 1)), 'unfilteredH': r(h_raw),
    }


def pms(cache):
    tracks = {}
    for line in open(fetch(BHAC15, cache)):
        parts = line.split()
        if len(parts) < 6 or parts[0] not in ('0.700', '0.800'):
            continue
        try:
            row = [float(x) for x in parts[1:6]]
        except ValueError:
            continue
        log_t, teff, log_l, _, radius = row
        tracks.setdefault(parts[0], []).append([log_t, teff, log_l, radius])
    return {
        'source': 'Baraffe, Homeier, Allard & Chabrier 2015, A&A 577, A42 (BHAC15): log10 age (yr), Teff (K), log10 L/Lsun, R/Rsun.',
        'tracks': {k: v for k, v in tracks.items()},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--cache', default='/tmp/claude-0/data/events')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    os.makedirs(a.cache, exist_ok=True)
    for name, data in [('sn1987a.json', bolometric(a.cache)), ('gw150914.json', gw150914(a.cache)), ('pms.json', pms(a.cache))]:
        with open(os.path.join(a.out, name), 'w') as f:
            json.dump(data, f, separators=(',', ':'))
        print(name, os.path.getsize(os.path.join(a.out, name)))


if __name__ == '__main__':
    main()
