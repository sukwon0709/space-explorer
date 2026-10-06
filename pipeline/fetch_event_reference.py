"""NASA's catalogues of eclipses and transits, 1960-2060, as a test fixture.

Usage:
    python pipeline/fetch_event_reference.py tests/fixtures/events-reference.json

Sources (Fred Espenak, NASA GSFC eclipse web site, and the Mars 2020 mission):
- Five Millennium Catalog of Solar Eclipses, 1901-2000 and 2001-2100: date, Dynamical
  Time (TD) of greatest eclipse, Delta T, type, gamma, magnitude, Sun altitude and
  central duration. For each eclipse the Besselian-elements page (SEdata.php) adds
  Delta T to 0.1 s and the polynomial Besselian elements; the greatest-eclipse point
  is computed from those elements (Meeus, Elements of Solar Eclipses), since NASA
  prints it only to 0.1 degree. The printed values are kept for a cross-check.
- Five Millennium Catalog of Lunar Eclipses, 1901-2000 and 2001-2100 (Danjon shadow
  enlargement): TD of greatest eclipse, Delta T, type, gamma, umbral and penumbral
  magnitudes, phase durations (0.1 min) and the point with the Moon in the zenith.
- Catalogs of Mercury and Venus transits (geocentric contacts, UT to the minute), and
  the Observer's Handbook pages for the transits of 1999, 2003, 2004, 2006 and 2012,
  which give geocentric contacts to the second.
- Perseverance's Mastcam-Z frames of the Phobos transit on sol 397 (2 April 2022), from
  the Mars 2020 raw-image feed: each frame's time (spacecraft clock, NAIF SCLK kernel)
  and the Sun's area in it, a light curve of the transit.
"""

import argparse
import html
import hashlib
import json
import math
import os
import re
import time
import urllib.request

BASE = "https://eclipse.gsfc.nasa.gov"
SOLAR = ["SEcat5/SE1901-2000.html", "SEcat5/SE2001-2100.html"]
LUNAR = ["LEcat5/LE1901-2000.html", "LEcat5/LE2001-2100.html"]
TRANSITS = {"Mercury": "transit/catalog/MercuryCatalog.html", "Venus": "transit/catalog/VenusCatalog.html"}
HANDBOOK = {"OH/transit99.html": "Mercury", "OH/transit03.html": "Mercury", "OH/transit04.html": "Venus", "OH/transit06.html": "Mercury", "OH/transit12.html": "Venus"}
RAW_IMAGES = "https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&sol=397"
SCLK = "https://naif.jpl.nasa.gov/pub/naif/MARS2020/kernels/sclk/M2020_168_SCLKSCET.00009.tsc"
LSK = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/lsk/naif0012.tls"
CACHE = os.environ.get("EVENTS_CACHE", "/tmp/space-explorer-events")
RELEASE = "https://www.nasa.gov/feature/jpl/nasa-s-perseverance-rover-captures-video-of-solar-eclipse-on-mars"
YEARS = (1960, 2060)
MONTHS = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}
E2 = 0.00669438  # Earth's eccentricity squared, as in the Besselian reductions


def get(path: str) -> str:
    """Fetch a page, keeping a copy in CACHE (the GSFC server is slow; rerunning is quick)."""
    url = path if path.startswith("http") else f"{BASE}/{path}"
    cached = os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest())
    if os.path.exists(cached):
        with open(cached, encoding="latin-1") as f:
            return f.read()
    os.makedirs(CACHE, exist_ok=True)
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "space-explorer pipeline"})
            with urllib.request.urlopen(req, timeout=120) as r:
                page = r.read().decode("latin-1")
            with open(cached, "w", encoding="latin-1") as f:
                f.write(page)
            return page
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 + 3 * attempt)
    raise AssertionError


def text(page: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", page))


def iso(y, mon, d, hms: str) -> str:
    return f"{y:04d}-{MONTHS[mon]:02d}-{int(d):02d}T{hms}Z"


def signed(value: str, hemi: str) -> float:
    return -float(value) if hemi in "SW" else float(value)


def besselian_point(el: dict, t: float, delta_t: float) -> tuple[float, float, bool]:
    """Greatest-eclipse point from Besselian elements at t hours past t0 (Meeus).

    Where the axis meets the Earth this is the central point on the ellipsoid. When it
    misses, NASA's printed points match the point of a spherical Earth nearest the axis
    (with an ellipsoid they would sit up to 0.2 degrees further poleward), so that is
    what is computed."""
    ev = lambda c: sum(a * t**k for k, a in enumerate(c))
    x, y, d, mu = ev(el["x"]), ev(el["y"]), math.radians(ev(el["d"])), ev(el["mu"])
    rho1 = math.sqrt(1 - E2 * math.cos(d) ** 2)
    central = x * x + (y / rho1) ** 2 <= 1
    e2 = E2 if central else 0.0
    rho1 = math.sqrt(1 - e2 * math.cos(d) ** 2)
    sd1, cd1 = math.sin(d) / rho1, math.sqrt(1 - e2) * math.cos(d) / rho1
    y1 = y / rho1
    if central:
        zeta1 = math.sqrt(1 - x * x - y1 * y1)
    else:
        m = math.hypot(x, y1)
        x, y1, zeta1 = x / m, y1 / m, 0.0
    h = math.degrees(math.atan2(x, zeta1 * cd1 - y1 * sd1))
    phi1 = math.asin(y1 * cd1 + zeta1 * sd1)
    lat = math.degrees(math.atan(math.tan(phi1) / math.sqrt(1 - e2)))
    lon = -(mu - h - 0.00417807 * delta_t)
    return lat, (lon + 540) % 360 - 180, central


def solar() -> list[dict]:
    rows = []
    pat = re.compile(
        r"^(\d{5})\s+(-?\d+) (\w{3}) (\d\d)\s+(\d\d:\d\d:\d\d)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+([PATH])(\S?)\s+(\S\S)\s+(-?\d\.\d+)\s+(\d\.\d+)\s+(\d+)([NS])\s+(\d+)([EW])\s+(\d+)(?:[ \t]+(\d+|-))?(?:[ \t]+(\d\dm\d\ds|-))?",
        re.M,
    )
    for page in SOLAR:
        for m in pat.finditer(text(get(page))):
            g = m.groups()
            year = int(g[1])
            if not YEARS[0] <= year <= YEARS[1]:
                continue
            dur = g[19]
            rows.append({
                "date": f"{year:04d}-{MONTHS[g[2]]:02d}-{g[3]}",
                "greatest_td": iso(year, g[2], g[3], g[4]),
                "type": {"P": "partial", "A": "annular", "T": "total", "H": "hybrid"}[g[8]],
                "subtype": g[9],
                "saros": int(g[7]),
                "gamma": float(g[11]),
                "magnitude": float(g[12]),
                "sun_alt": int(g[17]),
                "duration_s": int(dur[:2]) * 60 + int(dur[3:5]) if dur and dur != "-" else None,
            })
    for row in rows:
        ymd = row["date"].replace("-", "")
        page = text(get(f"SEsearch/SEdata.php?Ecl={ymd}"))
        row["delta_t"] = float(re.search(r"ΔT\s*=\s*(-?[\d.]+)\s*s", page).group(1))
        t0 = float(re.search(r"Polynomial Besselian Elements for:.*?([\d.]+)\s*TDT\s*\(=t0\)", page).group(1))
        names = ["x", "y", "d", "l1", "l2", "mu"]
        el = {n: [] for n in names}
        for k in range(4):
            line = re.search(rf"^\s*{k}\s+(.+)$", page.split("(=t0)")[1], re.M).group(1)
            for n, v in zip(names, re.findall(r"-?\d+\.\d+", line)):
                el[n].append(float(v))
        hh, mm, ss = (int(v) for v in row["greatest_td"][11:19].split(":"))
        t = (hh + mm / 60 + ss / 3600 - t0 + 12) % 24 - 12
        lat, lon, central = besselian_point(el, t, row["delta_t"])
        circ = re.search(r"Latitude:\s+([\d.]+)° ([NS]).*?Longitude:\s+([\d.]+)° ([EW])", page, re.S)
        printed = [signed(circ.group(1), circ.group(2)), signed(circ.group(3), circ.group(4))]
        dlat, dlon = lat - printed[0], ((lon - printed[1] + 540) % 360 - 180) * math.cos(math.radians(lat))
        if math.hypot(dlat, dlon) > 0.09:
            raise RuntimeError(f"{row['date']}: Besselian point {lat:.3f} {lon:.3f} vs printed {printed}")
        row.update({"lat": round(lat, 4), "lon": round(lon, 4), "printed_latlon": printed, "central_axis": central})
        print(f"solar {row['date']} {row['type']:8s} dT={row['delta_t']} {lat:8.3f} {lon:9.3f}")
    return rows


def lunar() -> list[dict]:
    rows = []
    pat = re.compile(
        r"^(\d{5})\s+(-?\d+) (\w{3}) (\d\d)\s+(\d\d:\d\d:\d\d)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+([NPT])(\S?)\s+(\S\S)\s+(-?\d\.\d+)\s+(-?\d\.\d+)\s+(-?\d\.\d+)\s+([\d.]+|-)\s+([\d.]+|-)\s+([\d.]+|-)\s+(\d+)([NS])\s+(\d+)([EW])",
        re.M,
    )
    minutes = lambda v: None if v == "-" else round(float(v) * 60, 1)
    for page in LUNAR:
        for m in pat.finditer(text(get(page))):
            g = m.groups()
            year = int(g[1])
            if not YEARS[0] <= year <= YEARS[1]:
                continue
            rows.append({
                "date": f"{year:04d}-{MONTHS[g[2]]:02d}-{g[3]}",
                "greatest_td": iso(year, g[2], g[3], g[4]),
                "delta_t": int(g[5]),
                "type": {"N": "penumbral", "P": "partial", "T": "total"}[g[8]],
                "subtype": g[9],
                "gamma": float(g[11]),
                "penumbral": float(g[12]),
                "umbral": float(g[13]),
                "penumbral_s": minutes(g[14]),
                "partial_s": minutes(g[15]),
                "total_s": minutes(g[16]),
                "lat": signed(g[17], g[18]),
                "lon": signed(g[19], g[20]),
            })
    return rows


def solar_delta_t(rows: list[dict]):
    """NASA's Delta T as a function of date, interpolated between solar eclipses."""
    pts = sorted((r["greatest_td"], r["delta_t"]) for r in rows)
    def at(date: str) -> float:
        for (d0, v0), (d1, v1) in zip(pts, pts[1:]):
            if d0 <= date <= d1:
                y0, y1, y = (time.mktime(time.strptime(s[:10], "%Y-%m-%d")) for s in (d0, d1, date))
                return round(v0 + (v1 - v0) * (y - y0) / (y1 - y0), 1)
        return pts[0][1] if date < pts[0][0] else pts[-1][1]
    return at


def transits(delta_t) -> list[dict]:
    rows = []
    hm = r"(\d\d:\d\d|-+|—)"
    pat = re.compile(rf"^\s+(\d{{4}}) (\w{{3}}) (\d\d)\s+{hm}\s+{hm}\s+{hm}\s+{hm}\s+{hm}\s+([\d.]+)", re.M)
    for body, page in TRANSITS.items():
        seen = set()
        for m in pat.finditer(text(get(page))):
            g = m.groups()
            year = int(g[0])
            if not YEARS[0] <= year <= YEARS[1] or (year, g[1], g[2]) in seen:
                continue
            seen.add((year, g[1], g[2]))
            date = f"{year:04d}-{MONTHS[g[1]]:02d}-{g[2]}"
            times = list(g[3:8])
            rows.append({
                "body": body, "date": date, "separation": float(g[8]),
                # Contacts are UT to the minute; the date is that of greatest transit.
                "ut_minutes": times,
                "delta_t": delta_t(date),
                "source": f"{BASE}/{page}",
            })
    for page, body in HANDBOOK.items():
        t = text(get(page))
        contacts = {}
        for name, hms in re.findall(r"(Contact I{1,3}V?|Contact IV|Greatest(?: Transit)?)\s+(\d\d:\d\d:\d\d)", t):
            contacts[name.replace(" Transit", "")] = hms
        year = 2000 + int(page[-7:-5]) if int(page[-7:-5]) < 50 else 1900 + int(page[-7:-5])
        row = next(r for r in rows if r["body"] == body and r["date"].startswith(str(year)))
        row["ut_seconds"] = [contacts.get(k) for k in ["Contact I", "Contact II", "Greatest", "Contact III", "Contact IV"]]
        row["seconds_source"] = f"{BASE}/{page}"
    return rows


def phobos() -> dict:
    """The Mastcam-Z sequence of the transit: each frame's time and the Sun's area in it.

    The feed's date_taken_utc reads the sub-second part of the spacecraft clock as clock
    ticks, so frame times come from the clock itself, converted with NAIF's Mars 2020
    SCLK kernel. The Sun's area is the count of pixels brighter than half its disc in the
    320-pixel browse image; Phobos's silhouette takes up to a fifth of it."""
    import io

    import numpy as np
    import spiceypy as sp
    from PIL import Image

    frames = json.loads(get(RAW_IMAGES))["images"]
    # The transit sequence: Mastcam-Z left, solar filter, 10:54-10:56 UTC.
    seq = {f["imageid"]: f for f in frames if "ND6" in f["camera"].get("filter_name", "") and "T10:54" <= f["date_taken_utc"][10:] < "T10:56"}
    seq = sorted(seq.values(), key=lambda f: float(f["extended"]["sclk"]))
    kernels = []
    for url in [LSK, SCLK]:
        path = os.path.join(CACHE, os.path.basename(url))
        if not os.path.exists(path):
            urllib.request.urlretrieve(url, path)
        kernels.append(path)
    for k in kernels:
        sp.furnsh(k)
    light = []
    for f in seq:
        whole, frac = f["extended"]["sclk"].split(".")
        et = sp.scs2e(-168, whole) + float("0." + frac)
        req = urllib.request.Request(f["image_files"]["small"], headers={"User-Agent": "space-explorer pipeline"})
        with urllib.request.urlopen(req, timeout=120) as r:
            im = np.asarray(Image.open(io.BytesIO(r.read())).convert("L"), dtype=float)
        light.append([sp.et2utc(et, "ISOC", 3) + "Z", int((im > 0.5 * np.percentile(im, 99.9)).sum())])
    return {
        "site": "Octavia E. Butler Landing, Jezero crater",
        # NAIF m2020_ls_ops210303_iau2000_v1.bsp (landing site, IAU_MARS): planetocentric.
        "lat": 18.444627, "lon": 77.450886, "radius_km": 3391.937,
        "sol": 397,
        "duration_note": "the eclipse lasted a little over 40 seconds",
        "frames": light,
        "sources": [RELEASE, RAW_IMAGES, SCLK, "https://naif.jpl.nasa.gov/pub/naif/MARS2020/kernels/spk/m2020_ls_ops210303_iau2000_v1.bsp"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("out")
    args = parser.parse_args()
    s = solar()
    out = {
        "source": "Espenak, NASA GSFC: Five Millennium Catalogs of Solar and Lunar Eclipses, transit catalogs; Mars 2020 raw images",
        "solar": s,
        "lunar": lunar(),
        "transits": transits(solar_delta_t(s)),
        "phobos": phobos(),
    }
    with open(args.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {args.out}: {len(out['solar'])} solar, {len(out['lunar'])} lunar, {len(out['transits'])} transits")


if __name__ == "__main__":
    main()
