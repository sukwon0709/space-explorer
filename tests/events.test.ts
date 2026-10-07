import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ephemeris } from '../src/core/ephemeris';
import { Orientation } from '../src/core/orientation';
import { PERSEVERANCE, SkyEvents, phobosTransits, phobosView, type SolarEclipse, type LunarEclipse } from '../src/core/skyevents';
import { Track, type TrackJson } from '../src/core/track';
import { J2000_UNIX_MS, tdbToUtc, utcToTdb } from '../src/core/time';

/**
 * Sky events gate: eclipses and transits found with the app's ephemeris (DE440) and
 * Earth orientation reproduce NASA's catalogues for 1960-2060 (Espenak, NASA GSFC;
 * pipeline/fetch_event_reference.py), Phobos's transit filmed by Perseverance matches
 * the frames, and close-approach tracks match JPL Horizons and CAD
 * (pipeline/fetch_approaches.py).
 *
 * NASA's times are TD (= TT; TDB differs by under 2 ms). Where Earth's rotation
 * matters, NASA's Delta T is adopted, as in tests/eclipse.test.ts.
 *
 * Achieved (DE440, IERS orientation with NASA's Delta T):
 * - Solar, 224 eclipses (78 partial, 67 total, 71 annular, 8 hybrid): all found, none
 *   extra, every type agrees. Greatest eclipse within 0.51 s (median 0.27 s; NASA lists
 *   whole seconds), gamma within 0.00005, magnitude within 0.00006, greatest-eclipse
 *   point within 0.90 km (median 0.39 km), Sun altitude within 0.5 deg (NASA: whole
 *   degrees), central duration within 0.64 s over 142 central eclipses.
 * - Lunar, 230 eclipses (88 total, 55 partial, 87 penumbral): all found, every type
 *   agrees. Greatest eclipse within 2.4 s (median 0.34 s), gamma within 0.00014,
 *   umbral and penumbral magnitudes within 0.0004, durations within 4.0 s (partial),
 *   2.9 s (total) and 8.9 s (penumbral) of NASA's 0.1-minute values, sub-lunar point
 *   within NASA's whole-degree rounding.
 * - Transits, 14 of Mercury and 2 of Venus: the same list; contacts within 2.0 s of
 *   NASA's to-the-second geocentric times (1999, 2003, 2004, 2006, 2012) and within
 *   the minute catalogue's rounding; minimum separation within 0.04".
 * - Phobos from Jezero, 2 April 2022: contacts 10:54:30.5 - 10:55:05.2 UTC, 34.7 s;
 *   Perseverance's 160 frames put it 2.0 s earlier.
 * - Close-approach tracks: Hermite interpolation within 0.27 km of held-out Horizons
 *   positions; closest approach within 0.4 s and 1 ppm in distance of CAD.
 */
const load = (name: string) => {
  const file = readFileSync(new URL(`../public/data/${name}`, import.meta.url));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
};
const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const ephemeris = new Ephemeris(load('de440.bin'));
ephemeris.add(load('moons-mars.bin'));
const orientation = new Orientation(new Ephemeris(load('orientation.bin')));

interface NasaSolar { date: string; greatest_td: string; delta_t: number; type: string; gamma: number; magnitude: number; sun_alt: number; duration_s: number | null; lat: number; lon: number }
interface NasaLunar { date: string; greatest_td: string; delta_t: number; type: string; gamma: number; penumbral: number; umbral: number; penumbral_s: number | null; partial_s: number | null; total_s: number | null; lat: number; lon: number }
interface NasaTransit { body: string; date: string; separation: number; ut_minutes: string[]; delta_t: number; ut_seconds?: (string | null)[] }
const nasa: {
  solar: NasaSolar[];
  lunar: NasaLunar[];
  transits: NasaTransit[];
  phobos: { lat: number; lon: number; radius_km: number; frames: [string, number][] };
} = json('./fixtures/events-reference.json');

/** TD (ISO, no zone) as TDB seconds past J2000. */
const td = (iso: string) => (Date.parse(iso) - J2000_UNIX_MS) / 1000;
const START = utcToTdb(Date.UTC(1960, 0, 1)), END = utcToTdb(Date.UTC(2060, 11, 31));
const DEG = Math.PI / 180;

/** NASA's Delta T through the period, interpolated between its eclipses. */
const deltaTs = [...nasa.solar, ...nasa.lunar].map((e) => [td(e.greatest_td), e.delta_t]).sort((a, b) => a[0] - b[0]);
function nasaDeltaT(tdb: number): number {
  let i = deltaTs.findIndex((p) => p[0] > tdb);
  if (i <= 0) return i === 0 ? deltaTs[0][1] : deltaTs[deltaTs.length - 1][1];
  const [t0, v0] = deltaTs[i - 1], [t1, v1] = deltaTs[i];
  return v0 + ((v1 - v0) * (tdb - t0)) / (t1 - t0);
}
const sky = new SkyEvents(ephemeris, orientation, { deltaT: nasaDeltaT });

/** Great-circle distance (km) on a 6371 km sphere. */
function km(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const h = Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(((lon2 - lon1) * DEG) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const worst = (v: number[]) => Math.max(...v.map(Math.abs));

/** Pairs each NASA event with ours within a day; the rest are missing or extra. */
function pair<N extends { greatest_td: string }, O extends { tdb: number }>(theirs: N[], ours: O[]) {
  const pairs: [N, O][] = [];
  const extra = [...ours];
  const missing: N[] = [];
  for (const n of theirs) {
    const i = extra.findIndex((o) => Math.abs(o.tdb - td(n.greatest_td)) < 86400);
    if (i < 0) missing.push(n);
    else pairs.push([n, extra.splice(i, 1)[0]]);
  }
  return { pairs, missing, extra };
}

describe('solar eclipses 1960-2060 against the Five Millennium Canon', () => {
  const found = sky.solarEclipses(START, END);
  const { pairs, missing, extra } = pair(nasa.solar, found);

  it('finds every eclipse NASA lists and no others', () => {
    expect(missing.map((e) => e.date)).toEqual([]);
    expect(extra.map((e) => e.tdb)).toEqual([]);
    expect(pairs.length).toBe(nasa.solar.length);
  });

  it('agrees on types', () => {
    const differ = pairs.filter(([n, o]) => n.type !== o.type);
    console.log(`solar types: ${pairs.length - differ.length}/${pairs.length} agree`, differ.map(([n, o]) => `${n.date} NASA ${n.type}, ours ${o.type}`));
    expect(differ.map(([n, o]) => `${n.date} ${n.type}->${o.type}`)).toEqual(ALLOWED_SOLAR_TYPE_DIFFERENCES);
  });

  it('agrees on time of greatest eclipse, gamma and magnitude', () => {
    const dt = pairs.map(([n, o]) => o.tdb - td(n.greatest_td));
    const dg = pairs.map(([n, o]) => o.gamma - n.gamma);
    const dm = pairs.map(([n, o]) => o.magnitude - n.magnitude);
    console.log(`solar greatest eclipse: worst ${worst(dt).toFixed(2)} s, median |dt| ${median(dt.map(Math.abs)).toFixed(2)} s; gamma worst ${worst(dg).toFixed(5)}; magnitude worst ${worst(dm).toFixed(5)}`);
    expect(worst(dt)).toBeLessThan(TOL.solarTime);
    expect(worst(dg)).toBeLessThan(TOL.gamma);
    expect(worst(dm)).toBeLessThan(TOL.magnitude);
  });

  it('agrees on the greatest-eclipse point, the Sun altitude there and the central duration', () => {
    const d = pairs.map(([n, o]) => km(n.lat, n.lon, o.lat, o.lon));
    const alt = pairs.map(([n, o]) => o.sunAlt - n.sun_alt);
    const central = pairs.filter(([n]) => n.duration_s !== null) as [NasaSolar, SolarEclipse][];
    const dur = central.map(([n, o]) => (o.duration ?? 0) - n.duration_s!);
    console.log(`solar greatest point: worst ${worst(d).toFixed(2)} km, median ${median(d).toFixed(2)} km; Sun altitude worst ${worst(alt).toFixed(2)} deg; central duration worst ${worst(dur).toFixed(2)} s over ${central.length}`);
    expect(worst(d)).toBeLessThan(TOL.point);
    expect(worst(alt)).toBeLessThan(TOL.sunAlt);
    expect(worst(dur)).toBeLessThan(TOL.duration);
  });
});

describe('lunar eclipses 1960-2060 against the Five Millennium Canon (Danjon)', () => {
  const found = sky.lunarEclipses(START, END);
  const { pairs, missing, extra } = pair(nasa.lunar, found);

  it('finds every eclipse NASA lists, of the same type, and no others', () => {
    expect(missing.map((e) => e.date)).toEqual([]);
    expect(extra.map((e) => e.tdb)).toEqual([]);
    const differ = pairs.filter(([n, o]) => n.type !== o.type);
    console.log(`lunar types: ${pairs.length - differ.length}/${pairs.length} agree`);
    expect(differ.map(([n, o]) => `${n.date} ${n.type}->${o.type}`)).toEqual([]);
  });

  it('agrees on time, gamma, magnitudes, durations and the sub-lunar point', () => {
    const dt = pairs.map(([n, o]) => o.tdb - td(n.greatest_td));
    const dg = pairs.map(([n, o]) => o.gamma - n.gamma);
    const du = pairs.map(([n, o]) => o.umbral - n.umbral);
    const dp = pairs.map(([n, o]) => o.penumbral - n.penumbral);
    // A phase that barely happens has a duration that hangs on the fourth decimal of
    // the magnitude (2027 Jul 18: penumbral magnitude 0.0014, 12 minutes), so phases
    // with magnitude under 0.05 (over 1.05 for totality) are left to the magnitudes.
    const dur = (get: (o: LunarEclipse) => number | undefined, key: 'penumbral_s' | 'partial_s' | 'total_s', deep: (n: NasaLunar) => boolean) =>
      pairs.filter(([n]) => n[key] !== null && deep(n)).map(([n, o]) => (get(o) ?? 0) - n[key]!);
    const dPen = dur((o) => o.penumbralDuration, 'penumbral_s', (n) => n.penumbral > 0.05);
    const dPar = dur((o) => o.partialDuration, 'partial_s', (n) => n.umbral > 0.05);
    const dTot = dur((o) => o.totalDuration, 'total_s', (n) => n.umbral > 1.05);
    // NASA lists the sub-lunar point to the degree.
    const dLat = pairs.map(([n, o]) => o.lat - n.lat);
    const dLon = pairs.map(([n, o]) => ((o.lon - n.lon + 540) % 360) - 180);
    console.log(
      `lunar greatest eclipse: worst ${worst(dt).toFixed(2)} s, median |dt| ${median(dt.map(Math.abs)).toFixed(2)} s; gamma worst ${worst(dg).toFixed(5)}; ` +
        `umbral worst ${worst(du).toFixed(5)}, penumbral worst ${worst(dp).toFixed(5)}; durations worst: penumbral ${worst(dPen).toFixed(1)} s, partial ${worst(dPar).toFixed(1)} s, ` +
        `total ${worst(dTot).toFixed(1)} s; sub-lunar point worst ${worst(dLat).toFixed(2)} deg lat, ${worst(dLon).toFixed(2)} deg lon`,
    );
    expect(worst(dt)).toBeLessThan(TOL.lunarTime);
    expect(worst(dg)).toBeLessThan(TOL.gamma);
    expect(worst(du)).toBeLessThan(TOL.magnitude);
    expect(worst(dp)).toBeLessThan(TOL.magnitude);
    // Durations are listed to 0.1 minute (+-3 s). Ours run longer than NASA's in
    // proportion to their length, by 3 s on average for the six-hour penumbral phase,
    // 1 s for the partial and 0.1 s for totality; the penumbral contacts cannot be seen.
    expect(worst(dPen)).toBeLessThan(TOL.penumbralDuration);
    expect(worst(dPar)).toBeLessThan(TOL.lunarDuration);
    expect(worst(dTot)).toBeLessThan(TOL.lunarDuration);
    expect(worst(dLat)).toBeLessThan(0.55);
    expect(worst(dLon)).toBeLessThan(0.55);
  });
});

describe('transits of Mercury and Venus 1960-2060 (geocentric)', () => {
  const found = [...sky.transits(199, START, END), ...sky.transits(299, START, END)];
  /** NASA's UT (HH:MM or HH:MM:SS) on the day of greatest transit as TD, near `near`. */
  const tdOf = (n: NasaTransit, hm: string, near: number) => {
    let t = td(`${n.date}T${hm.length === 5 ? hm + ':00' : hm}Z`) + n.delta_t;
    while (t - near > 43200) t -= 86400;
    while (near - t > 43200) t += 86400;
    return t;
  };

  it('finds the same transits, with contacts matching NASA', () => {
    const pairs = nasa.transits.map((n) => {
      const body = n.body === 'Mercury' ? 199 : 299;
      const o = found.find((f) => f.body === body && Math.abs(f.tdb - td(`${n.date}T12:00:00Z`)) < 86400);
      expect(o, `${n.body} ${n.date}`).toBeDefined();
      return [n, o!] as const;
    });
    expect(found.length).toBe(nasa.transits.length);
    let worstSecond = 0, worstSep = 0, worstShift = 0;
    const shifts: string[] = [];
    for (const [n, o] of pairs) {
      const ours = o.contacts.length === 4 ? [o.contacts[0], o.contacts[1], o.tdb, o.contacts[2], o.contacts[3]] : [o.contacts[0], NaN, o.tdb, NaN, o.contacts[1]];
      // The catalogue gives UT to the minute, and its Delta T is not stated (it differs
      // from the eclipse canon's by up to half a minute, and the catalogue's 2012 times
      // differ that much from NASA's own to-the-second page). So the test fits one time
      // shift per transit, which must stay under 40 s, after which all five contacts
      // must agree within the rounding.
      const residuals = n.ut_minutes.map((hm, i) => (/\d/.test(hm) ? ours[i] - tdOf(n, hm, ours[i]) : NaN)).filter((r) => !Number.isNaN(r));
      expect(residuals.length).toBe(o.contacts.length + 1);
      const shift = (Math.max(...residuals) + Math.min(...residuals)) / 2;
      expect(worst(residuals.map((r) => r - shift)), n.date).toBeLessThan(31);
      worstShift = Math.max(worstShift, Math.abs(shift));
      shifts.push(`${n.date.slice(0, 4)} ${shift.toFixed(0)}`);
      // NASA's pages for 1999-2012 give geocentric contacts to the second.
      n.ut_seconds?.forEach((hms, i) => {
        if (hms) worstSecond = Math.max(worstSecond, Math.abs(ours[i] - tdOf(n, hms, ours[i])));
      });
      worstSep = Math.max(worstSep, Math.abs(o.separation - n.separation));
    }
    console.log(
      `transits: ${pairs.length}; contacts worst ${worstSecond.toFixed(1)} s against the to-the-second pages (1999-2012); ` +
        `minute catalogue shifts (s) ${shifts.join(', ')}; separation worst ${worstSep.toFixed(2)}"`,
    );
    expect(worstShift).toBeLessThan(40);
    expect(worstSecond).toBeLessThan(TOL.transitSecond);
    expect(worstSep).toBeLessThan(0.15);
  });
});

describe('Phobos crossing the Sun seen by Perseverance, sol 397', () => {
  // NASA/JPL, "NASA's Perseverance Rover Captures Video of Solar Eclipse on Mars"
  // (20 April 2022, https://www.nasa.gov/feature/jpl/nasa-s-perseverance-rover-captures-video-of-solar-eclipse-on-mars):
  // filmed with Mastcam-Z on 2 April 2022, sol 397, "the eclipse lasted a little over
  // 40 seconds". The frames themselves (Mars 2020 raw-image feed, times from the rover's
  // clock) time it more closely: the Sun's area in each frame is a light curve.
  const site = { ...PERSEVERANCE, lat: nasa.phobos.lat, lon: nasa.phobos.lon, radius: nasa.phobos.radius_km };
  const day = utcToTdb(Date.UTC(2022, 3, 2));
  const [transit] = phobosTransits(ephemeris, site, day, day + 86400);

  it('happens during the Mastcam-Z sequence and matches its light curve', () => {
    expect(transit).toBeDefined();
    const [c1, , , c4] = transit.contacts;
    const frames = nasa.phobos.frames.map(([utc, area]) => [utcToTdb(Date.parse(utc)), area] as const);
    const view = phobosView(ephemeris, site);
    // Fraction of the Sun's disc covered by Phobos's disc at tdb.
    const covered = (t: number) => {
      const v = view(t);
      const R = v.sunRadius, r = v.phobosRadius, d = v.separation;
      if (d >= R + r) return 0;
      if (d <= R - r) return (r * r) / (R * R);
      const a = r * r * Math.acos((d * d + r * r - R * R) / (2 * d * r)) + R * R * Math.acos((d * d + R * R - r * r) / (2 * d * R));
      return (a - 0.5 * Math.sqrt((-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R))) / (Math.PI * R * R);
    };
    // Fit the frames' times to ours: the Sun's area is full * (1 - covered(T)), with
    // T = g + offset + scale * (t - g) around our greatest transit g. The model curve
    // is tabulated every 0.02 s.
    const g = transit.tdb, t0 = c1 - 10, table = Array.from({ length: 3000 }, (_, i) => covered(t0 + i * 0.02));
    const model = (t: number) => {
      const i = (t - t0) / 0.02;
      return i < 0 || i >= table.length - 1 ? 0 : table[Math.floor(i)] + (table[Math.floor(i) + 1] - table[Math.floor(i)]) * (i % 1);
    };
    const fit = (offset: number, scale: number) => {
      const f = frames.map(([t, area]) => [model(g + offset + scale * (t - g)), area] as const);
      const clear = f.filter(([c]) => c === 0).map(([, a]) => a);
      const full = clear.reduce((s, a) => s + a, 0) / clear.length;
      return Math.sqrt(f.reduce((s, [c, a]) => s + (a - full * (1 - c)) ** 2, 0) / f.length);
    };
    let best = { offset: 0, scale: 1, rms: fit(0, 1) };
    for (let o = -5; o <= 5; o += 0.05) {
      for (let k = 0.9; k <= 1.1; k += 0.0025) {
        const rms = fit(o, k);
        if (rms < best.rms) best = { offset: o, scale: k, rms };
      }
    }
    const observed = (c4 - c1) / best.scale;
    console.log(
      `Phobos transit from Jezero: contacts ${transit.contacts.map((t) => new Date(tdbToUtc(t)).toISOString().slice(11, 22)).join(', ')} UTC, ` +
        `I-IV ${(c4 - c1).toFixed(2)} s; ${frames.length} Mastcam-Z frames: ours runs ${best.offset.toFixed(2)} s late, observed I-IV ${observed.toFixed(1)} s, ` +
        `fit rms ${best.rms.toFixed(1)} px (${fit(0, 1).toFixed(1)} px unfitted)`,
    );
    expect(frames[0][0]).toBeLessThan(c1);
    expect(frames[frames.length - 1][0]).toBeGreaterThan(c4);
    // The offset is within what the Phobos ephemeris allows along its orbit (a few km
    // at 2 km/s); the rover stood 1.4 km from the landing site, which moves it by 0.1 s.
    // The thresholded light curve and Phobos's lumpy outline (a sphere here) leave the
    // fitted duration a couple of seconds from ours.
    expect(Math.abs(best.offset)).toBeLessThan(TOL.phobosOffset);
    expect(Math.abs(observed - (c4 - c1))).toBeLessThan(3);
    // NASA's "a little over 40 seconds" takes in the margins of the sequence (47 s of
    // frames); first to last contact, in the frames and here, is about 35 s.
    expect(c4 - c1).toBeGreaterThan(30);
    expect(c4 - c1).toBeLessThan(42);
  });
});

describe('close-approach tracks', () => {
  const reference: {
    approaches: Array<{ slug: string; name: string; cad: { jd: number; dist_km: number; v_rel: number }; step: number; checks: Array<{ tdb: number; km: [number, number, number] }> }>;
  } = json('./fixtures/approaches-reference.json');
  const files = readdirSync(new URL('../public/data/events/', import.meta.url)).filter((f) => f.endsWith('.json'));

  it('reproduce held-out Horizons positions to under 1 km', () => {
    expect(files.length).toBe(reference.approaches.length);
    let worstKm = 0;
    for (const a of reference.approaches) {
      const track = new Track(json(`../public/data/events/${a.slug}.json`) as TrackJson);
      for (const c of a.checks) {
        const p = track.position(c.tdb);
        worstKm = Math.max(worstKm, Math.hypot(p[0] - c.km[0], p[1] - c.km[1], p[2] - c.km[2]));
      }
    }
    console.log(`tracks: worst held-out position error ${worstKm.toFixed(3)} km`);
    expect(worstKm).toBeLessThan(1);
  });

  it("put the closest approach where JPL's CAD does", () => {
    let worstT = 0, worstD = 0, worstPpm = 0, worstV = 0;
    for (const a of reference.approaches) {
      const c = new Track(json(`../public/data/events/${a.slug}.json`) as TrackJson).closest();
      const dt = c.tdb - (a.cad.jd - 2451545) * 86400;
      worstT = Math.max(worstT, Math.abs(dt));
      worstD = Math.max(worstD, Math.abs(c.distance - a.cad.dist_km));
      worstPpm = Math.max(worstPpm, (Math.abs(c.distance - a.cad.dist_km) / a.cad.dist_km) * 1e6);
      worstV = Math.max(worstV, Math.abs(c.speed - a.cad.v_rel));
    }
    console.log(`closest approach vs CAD: worst ${worstT.toFixed(2)} s, ${worstD.toFixed(2)} km (${worstPpm.toFixed(2)} ppm), ${worstV.toFixed(5)} km/s`);
    expect(worstT).toBeLessThan(TOL.cadTime);
    // CAD's distances come from its own integration of each orbit; they agree with
    // Horizons to under a part per million (1 km at Toutatis's 1.5 million km), and the
    // interpolated tracks within 0.3 km at the closest flybys.
    for (const a of reference.approaches) {
      const c = new Track(json(`../public/data/events/${a.slug}.json`) as TrackJson).closest();
      expect(Math.abs(c.distance - a.cad.dist_km), a.slug).toBeLessThan(Math.max(0.3, 1e-6 * a.cad.dist_km));
    }
    expect(worstV).toBeLessThan(0.001);
  });
});

const TOL = {
  solarTime: 3, lunarTime: 3, gamma: 0.0005, magnitude: 0.0005, point: 5, sunAlt: 1, duration: 1.6, lunarDuration: 5, penumbralDuration: 9,
  transitSecond: 4, phobosOffset: 2.5, cadTime: 1,
};
const ALLOWED_SOLAR_TYPE_DIFFERENCES: string[] = [];
