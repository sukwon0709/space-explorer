import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ephemeris, type Vec3 } from '../src/core/ephemeris';
import { BODIES, bodyById } from '../src/core/bodies';
import { GM, SolarGravity } from '../src/core/gravity';
import { Ship, apsides, type FlightWorld, type ShipInput, type Source } from '../src/core/flight';
import { Forecast } from '../src/core/forecast';
import { encounter, flybyStart, stretch } from '../src/core/slingshot';
import { Trajectory } from '../src/core/mission';
import { icrfToScene } from '../src/core/frames';
import { utcToTdb } from '../src/core/time';

const load = (name: string) => {
  const f = readFileSync(new URL(`../public/data/${name}`, import.meta.url));
  return f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength);
};
const ephemeris = new Ephemeris(load('de440.bin'));
ephemeris.add(load('moons-jupiter.bin'));
const solar = new SolarGravity(ephemeris);
const IDLE: ShipInput = { thrust: [0, 0, 0], turn: [0, 0, 0], boost: false, warp: 0 };
const T0 = utcToTdb(Date.UTC(2026, 9, 5, 4));

const world: FlightWorld = {
  position: (id, t, out) => solar.position(id, t, out),
  velocity: (id, t, out) => solar.velocity(id, t, out),
  acceleration: (id, t, out) => solar.acceleration(id, t, out),
  sources: (abs, t) => solar.sources(abs, t).map((id): Source => ({ id, gm: GM[id] })),
  altitude: (id, rel) => Math.hypot(...rel) - bodyById(id).radius[0],
  spin: () => undefined,
  radius: (id) => bodyById(id).radius[0],
};
/** The ship's own rule for which sphere of influence it is in (main.ts chooseRef, Solar System part). */
const frameOf = (abs: Vec3, t: number) => {
  let best = 10, size = Infinity;
  for (const b of BODIES) {
    if (!solar.has(b.id, t)) continue;
    const infl = solar.influence(b.id, t);
    const p = solar.position(b.id, t);
    if (infl < size && Math.hypot(p[0] - abs[0], p[1] - abs[1], p[2] - abs[2]) < infl) {
      best = b.id;
      size = infl;
    }
  }
  return best;
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('Gravity assists', () => {
  // Voyager 1 passed Jupiter on 5 March 1979, 348,890 km from its centre (Stone & Lane
  // 1979), and left some 16 km/s faster relative to the Sun. Its navigated path from
  // Horizons is the truth here; the ship gets only its state ten days out.
  const traj = new Trajectory(load('missions/voyager-1.bin'));
  let tc = 0, best = Infinity;
  for (let t = utcToTdb(Date.UTC(1979, 2, 4)); t < utcToTdb(Date.UTC(1979, 2, 7)); t += 60) {
    const p = traj.position(t, (id, tt, out) => ephemeris.position(id, tt, out));
    const r = len(sub(p, ephemeris.position(599, t)));
    if (r < best) [best, tc] = [r, t];
  }
  const t0 = tc - 10 * 86400, t1 = tc + 10 * 86400;
  const at = (id: number, t: number, out: Vec3) => ephemeris.position(id, t, out);
  /** Voyager's state relative to a body, scene axes. */
  const state = (id: number, t: number) => ({
    rel: sub(icrfToScene(traj.position(t, at)), solar.position(id, t)),
    vel: sub(icrfToScene(traj.velocity(t, at)), solar.velocity(id, t)),
  });
  const helioSpeed = (t: number) => len(state(10, t).vel);

  it('flies Voyager 1 past Jupiter as it flew: closest approach within 300 km and 2 minutes', () => {
    const s0 = state(599, t0);
    const ship = new Ship(599, s0.rel);
    ship.vel = s0.vel;
    ship.assist = false;
    let closest = Infinity, when = 0;
    for (let t = t0; t < t1; t += 120) {
      ship.step(world, t, 120, 0, IDLE);
      const r = len(ship.rel);
      if (r < closest) [closest, when] = [r, t + 120];
    }
    console.log(`Voyager 1 at Jupiter: closest ${closest.toFixed(0)} km (Horizons ${best.toFixed(0)} km), ${((when - tc) / 60).toFixed(1)} min from the real time`);
    expect(Math.abs(best - 348890)).toBeLessThan(500);
    expect(Math.abs(closest - best)).toBeLessThan(300);
    expect(Math.abs(when - tc)).toBeLessThan(240);
    // And out the other side, the ship's speed relative to the Sun is Voyager's.
    ship.rebase(world, 10, t1);
    const gained = len(ship.vel) - helioSpeed(t0);
    const real = helioSpeed(t1) - helioSpeed(t0);
    console.log(`  speed relative to the Sun: ${helioSpeed(t0).toFixed(2)} -> ${len(ship.vel).toFixed(2)} km/s (Voyager ${helioSpeed(t1).toFixed(2)}): +${gained.toFixed(2)} vs +${real.toFixed(2)}`);
    expect(real).toBeGreaterThan(10);
    expect(Math.abs(gained - real)).toBeLessThan(0.05);
  });

  it('predicts the speed after the pass from the approach alone (two-body conic) within 5%', () => {
    // What the display promises on the way in, before any of it has happened.
    const s0 = state(599, t0);
    const pass = encounter(s0.rel, s0.vel, GM[599])!;
    const vJ0 = solar.velocity(599, t0), vJ1 = solar.velocity(599, t1);
    const vSun = solar.velocity(10, t0);
    const before = len(sub(add(vJ0, s0.vel), vSun));
    const after = len(sub(add(vJ1, pass.vOut), solar.velocity(10, t1)));
    console.log(`  conic: periapsis ${pass.peri.toFixed(0)} km, turned ${(pass.turn * 180 / Math.PI).toFixed(1)}°, ${before.toFixed(2)} -> ${after.toFixed(2)} km/s (Voyager ${helioSpeed(t1).toFixed(2)}), periapsis in ${(pass.toPeri / 86400).toFixed(3)} d (real ${((tc - t0) / 86400).toFixed(3)} d)`);
    expect(Math.abs(pass.peri - best) / best).toBeLessThan(0.03);
    expect(Math.abs(pass.toPeri - (tc - t0))).toBeLessThan(3600);
    expect(Math.abs(after - helioSpeed(t1)) / helioSpeed(t1)).toBeLessThan(0.05);
  });

  it('forecasts the same pass the ship then flies, drawn around Jupiter', () => {
    const s0 = state(599, t0);
    const ship = new Ship(599, s0.rel);
    ship.vel = s0.vel;
    const f = new Forecast();
    f.start(world, ship, t0, t0 + 25 * 86400);
    let slices = 0;
    while (!f.advance(world, frameOf, 200)) slices++;
    const run = f.runs[0];
    expect(run.frame).toBe(599);
    const peri = len(f.point(run.closest));
    console.log(`  forecast: ${f.n} points in ${slices + 1} slices, closest ${peri.toFixed(0)} km at ${((f.t[run.closest] - tc) / 60).toFixed(1)} min, then ${f.runs.map((r) => r.frame).join(' → ')}`);
    expect(Math.abs(peri - best)).toBeLessThan(400);
    expect(Math.abs(f.t[run.closest] - tc)).toBeLessThan(600);
    // Matches a ship flying the same time with the ordinary step, wherever both are.
    ship.assist = false;
    let worst = 0;
    for (let t = t0; t < tc + 86400; t += 600) {
      ship.step(world, t, 600, 0, IDLE);
      const p: Vec3 = [0, 0, 0];
      const frame = f.at(t + 600, p);
      if (frame === 599) worst = Math.max(worst, len(sub(p, ship.rel)) / len(ship.rel));
    }
    expect(worst).toBeLessThan(5e-3);
  });

  it('sets up a flyby that passes where asked and speeds the ship up', () => {
    const id = 599;
    const vP = sub(solar.velocity(id, T0), solar.velocity(10, T0));
    const pP = sub(solar.position(id, T0), solar.position(10, T0));
    const ahead = vP.map((x) => x / len(vP)) as Vec3;
    const h: Vec3 = [pP[1] * vP[2] - pP[2] * vP[1], pP[2] * vP[0] - pP[0] * vP[2], pP[0] * vP[1] - pP[1] * vP[0]];
    const normal = h.map((x) => x / len(h)) as Vec3;
    const rp = 1.5 * bodyById(id).radius[0], vInf = 0.4 * len(vP);
    const s = flybyStart(GM[id], rp, vInf, ahead, normal, 50 * rp);
    expect(Math.abs(len(s.rel) - 50 * rp) / (50 * rp)).toBeLessThan(1e-9);
    const pass = encounter(s.rel, s.vel, GM[id])!;
    expect(Math.abs(pass.peri - rp) / rp).toBeLessThan(1e-6);
    expect(Math.abs(pass.vInf - vInf) / vInf).toBeLessThan(1e-9);
    expect(pass.toPeri).toBeGreaterThan(0);
    // The kick points along the planet's motion: the most speed the pass can give.
    const kick = sub(pass.vOut, pass.vIn);
    expect(dot(kick, ahead) / len(kick)).toBeGreaterThan(0.999);
    const gain = len(add(vP, pass.vOut)) - len(add(vP, pass.vIn));
    // Fly it for real: everything pulling, Jupiter's moons too.
    const ship = new Ship(id, s.rel);
    ship.vel = [...s.vel];
    ship.assist = false;
    let closest = Infinity;
    const span = 2.2 * pass.toPeri;
    for (let t = 0; t < span; t += 300) {
      ship.step(world, T0 + t, 300, 0, IDLE);
      closest = Math.min(closest, len(ship.rel));
    }
    const vAfter = sub(add(solar.velocity(id, T0 + span), ship.vel), solar.velocity(10, T0 + span));
    const vBefore = sub(add(solar.velocity(id, T0), s.vel), solar.velocity(10, T0));
    console.log(`Jupiter flyby: closest ${(closest / bodyById(id).radius[0]).toFixed(3)} radii, ${len(vBefore).toFixed(2)} -> ${len(vAfter).toFixed(2)} km/s relative to the Sun (conic +${gain.toFixed(2)})`);
    expect(Math.abs(closest - rp) / rp).toBeLessThan(0.02);
    expect(len(vAfter) - len(vBefore)).toBeGreaterThan(0.8 * gain);
  });
});

describe('Feeling gravity', () => {
  it('measures tides as 2GM/r^3 along the line and -GM/r^3 across it', () => {
    const earth = bodyById(399);
    const r = earth.radius[0];
    const ship = new Ship(399, [r + 0.001, 0, 0]);
    ship.assist = false;
    ship.step(world, T0, 1e-3, 0, IDLE);
    const s = stretch(ship.tides);
    const expected = (2 * GM[399]) / (r + 0.001) ** 3;
    // The Moon and Sun add their own few parts in ten million.
    expect(Math.abs(s.along - expected) / expected).toBeLessThan(2e-6 * 1e3);
    expect(Math.abs(s.axis[0])).toBeGreaterThan(0.9999);
    expect(Math.abs(s.across + expected / 2) / expected).toBeLessThan(2e-3);
    // Over a person's 2 m: about 6 micro-m/s^2, under a millionth of a g.
    console.log(`Tides over 2 m on Earth's surface: ${(s.along * 2).toExponential(3)} m/s²`);
    expect(s.along * 2).toBeGreaterThan(6.0e-6);
    expect(s.along * 2).toBeLessThan(6.3e-6);
    // Agrees with the change of the field across a short distance.
    const other = new Ship(399, [r + 1.001, 0, 0]);
    other.assist = false;
    other.step(world, T0, 1e-3, 0, IDLE);
    const dg = other.pull[0] - ship.pull[0];
    expect(Math.abs(dg - expected) / expected).toBeLessThan(2e-3);
  });

  it('feels the engines, not gravity, in free fall; the ground once landed', () => {
    const ship = new Ship(301, [bodyById(301).radius[0] + 100, 0, 0]);
    ship.assist = false;
    ship.step(world, T0, 1, 0, IDLE);
    expect(len(ship.felt)).toBe(0);
    ship.step(world, T0 + 1, 1, 0, { ...IDLE, thrust: [0, 0, 1] });
    expect(Math.abs(len(ship.felt) * 1000 / 9.80665 - ship.power)).toBeLessThan(1e-9);
    // Standing on the Moon, the ground pushes back with the Moon's 1.62 m/s^2.
    expect(Math.abs(len(ship.pull) * 1000 - 1.62) / 1.62).toBeLessThan(0.15);
  });

  it('keeps a low orbit\'s forecast closed: one revolution, back where it started', () => {
    const r = bodyById(399).radius[0] + 400;
    const ship = new Ship(399, [r, 0, 0]);
    ship.vel = [0, 0, Math.sqrt(GM[399] / r)];
    const f = new Forecast();
    f.start(world, ship, T0, T0 + 86400);
    while (!f.advance(world, frameOf, 500));
    expect(f.end).toBe('orbit');
    const period = 2 * Math.PI * Math.sqrt(r ** 3 / GM[399]);
    expect(Math.abs(f.t[f.n - 1] - T0 - period)).toBeLessThan(60);
    const { peri, apo } = apsides(ship.rel, ship.vel, GM[399]);
    expect(Math.abs(apo - peri)).toBeLessThan(1e-6);
    expect(len(sub(f.point(f.n - 1), ship.rel))).toBeLessThan(30);
  });

  it('ends a forecast that falls into the ground at the ground', () => {
    const r = bodyById(301).radius[0] + 50;
    const ship = new Ship(301, [r, 0, 0]);
    const f = new Forecast();
    f.start(world, ship, T0, T0 + 86400);
    while (!f.advance(world, frameOf, 500));
    expect(f.end).toBe('impact');
    // Free fall from 50 km on the Moon: about 4 minutes.
    const fall = f.t[f.n - 1] - T0;
    expect(fall).toBeGreaterThan(230);
    expect(fall).toBeLessThan(260);
  });
});
