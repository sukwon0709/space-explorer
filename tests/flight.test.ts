import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ephemeris, type Vec3 } from '../src/core/ephemeris';
import { BODIES, bodyById } from '../src/core/bodies';
import { C_KMS, G0, GM, SolarGravity } from '../src/core/gravity';
import { Ship, apsides, type FlightWorld, type ShipInput, type Source, type WarpLimiter } from '../src/core/flight';
import { utcToTdb } from '../src/core/time';

const file = readFileSync(new URL('../public/data/de440.bin', import.meta.url));
const ephemeris = new Ephemeris(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
const solar = new SolarGravity(ephemeris);
const T0 = utcToTdb(Date.UTC(2026, 9, 5, 4));
const IDLE: ShipInput = { thrust: [0, 0, 0], turn: [0, 0, 0], boost: false, warp: 0 };

/** The Solar System as the ship sees it, optionally leaving some bodies out. */
function solarWorld(exclude: number[] = []): FlightWorld {
  return {
    position: (id, t, out) => solar.position(id, t, out),
    velocity: (id, t, out) => solar.velocity(id, t, out),
    acceleration: (id, t, out) => solar.acceleration(id, t, out),
    sources: (abs, t) => solar.sources(abs, t).filter((id) => !exclude.includes(id)).map((id): Source => ({ id, gm: GM[id] })),
    altitude: (id, rel) => Math.hypot(...rel) - bodyById(id).radius[0],
    spin: () => undefined,
    radius: (id) => bodyById(id).radius[0],
  };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

describe('Flight: gravity', () => {
  it('weighs what NASA lists at each surface (equatorial, 1 bar for the giants)', () => {
    // NASA planetary fact sheets, "surface gravity" / "equatorial gravity" (m/s^2).
    const nasa: Record<string, number> = {
      Mercury: 3.70, Venus: 8.87, Earth: 9.80, Moon: 1.62, Mars: 3.71, Jupiter: 24.79,
      Saturn: 10.44, Uranus: 8.87, Neptune: 11.15, Pluto: 0.62, Sun: 274.0,
    };
    for (const [name, g] of Object.entries(nasa)) {
      const body = BODIES.find((b) => b.name === name)!;
      const world = solarWorld();
      const ship = new Ship(body.id, [body.radius[0] + 0.001, 0, 0]);
      ship.assist = false;
      ship.step(world, T0, 1e-3, 0, IDLE);
      // The field, less what the body's own acceleration already carries the ship with.
      const own = (GM[body.id] / (body.radius[0] + 0.001) ** 2) * 1000;
      expect(Math.abs(own - g) / g, name).toBeLessThan(0.01);
      // The field the ship reports is dominated by the body it stands on.
      expect(ship.strongest, name).toBe(body.id);
      expect(Math.abs(len(ship.gravity) * 1000 - g) / g, name).toBeLessThan(0.01);
    }
  });

  it('flies the Moon\'s real path for a week: DE440 within 2 km', () => {
    // The ship starts exactly where the Moon is, moving as it moves, and feels every
    // body but the Moon. DE440 is an independent fit to lunar laser ranging.
    const world = solarWorld([301]);
    const ship = new Ship(399, sub(solar.position(301, T0), solar.position(399, T0)));
    ship.vel = sub(solar.velocity(301, T0), solar.velocity(399, T0));
    ship.assist = false;
    let worst = 0;
    for (let t = 0; t < 7 * 86400; t += 600) {
      ship.step(world, T0 + t, 600, 0, IDLE);
      const truth = sub(solar.position(301, T0 + t + 600), solar.position(399, T0 + t + 600));
      worst = Math.max(worst, len(sub(ship.rel, truth)));
    }
    console.log(`Moon path, worst difference from DE440 over 7 days: ${worst.toFixed(2)} km`);
    expect(worst).toBeLessThan(2);
  });

  it('flies the Earth-Moon barycentre\'s path around the Sun for 60 days: DE440 within 30 km', () => {
    const world = solarWorld([399, 301]);
    const ship = new Ship(10, sub(solar.position(3, T0), solar.position(10, T0)));
    ship.vel = sub(solar.velocity(3, T0), solar.velocity(10, T0));
    ship.assist = false;
    let worst = 0;
    for (let t = 0; t < 60 * 86400; t += 3600) {
      ship.step(world, T0 + t, 3600, 0, IDLE);
      const truth = sub(solar.position(3, T0 + t + 3600), solar.position(10, T0 + t + 3600));
      worst = Math.max(worst, len(sub(ship.rel, truth)));
    }
    console.log(`Earth-Moon barycentre path, worst difference from DE440 over 60 days: ${worst.toFixed(2)} km`);
    expect(worst).toBeLessThan(30);
  });

  it('holds a low Earth orbit: period from Kepler, back within 2 km after one lap', () => {
    const world = solarWorld();
    const r = 6378.137 + 420;
    const v = Math.sqrt(GM[399] / r);
    const ship = new Ship(399, [r, 0, 0]);
    ship.vel = [0, 0, v];
    ship.assist = false;
    const period = 2 * Math.PI * Math.sqrt(r ** 3 / GM[399]);
    expect(period / 60).toBeCloseTo(92.8, 0); // the ISS's period at that height
    const { peri, apo } = apsides(ship.rel, ship.vel, GM[399]);
    expect(Math.abs(peri - r)).toBeLessThan(1e-6);
    expect(Math.abs(apo - r)).toBeLessThan(1e-6);
    const steps = 1000;
    for (let i = 0; i < steps; i++) ship.step(world, T0 + (i * period) / steps, period / steps, 0, IDLE);
    expect(len(sub(ship.rel, [r, 0, 0]))).toBeLessThan(2);
  });

  it('falls at 1 g near Earth with flight assist off, and sinks gently with it on', () => {
    const world = solarWorld();
    const off = new Ship(399, [6378.137 + 10, 0, 0]);
    off.assist = false;
    for (let i = 0; i < 100; i++) off.step(world, T0 + i * 0.1, 0.1, 0.1, IDLE);
    expect(-off.vel[0] * 1000).toBeCloseTo(9.80 * 10 * (6378.137 / (6378.137 + 10)) ** 2, 0);
    const on = new Ship(399, [6378.137 + 10, 0, 0]);
    on.look([0, 0, -1], [1, 0, 0]); // nose level, roof up
    for (let i = 0; i < 200; i++) on.step(world, T0 + i * 0.1, 0.1, 0.1, IDLE);
    // Flight assist pushes back against the fall, but gravity still wins: a slow sink.
    expect(on.vel[0]).toBeLessThan(0);
    expect(-on.vel[0] * 1000).toBeLessThan(13);
    expect(-on.vel[0] * 1000).toBeGreaterThan(10);
  });

  it('lands on the ground instead of passing through it', () => {
    const world = solarWorld();
    const ship = new Ship(301, [1737.4 + 1, 0, 0]);
    ship.vel = [-0.5, 0, 0];
    ship.assist = false;
    const events = [];
    for (let i = 0; i < 100; i++) events.push(...ship.step(world, T0 + i * 0.1, 0.1, 0.1, IDLE));
    expect(events.some((e) => e.kind === 'landed')).toBe(true);
    expect(ship.landed).toBe(301);
    expect(len(ship.rel)).toBeCloseTo(1737.4, 3);
  });

  it('rebases between reference bodies without moving', () => {
    const world = solarWorld();
    const ship = new Ship(399, [7000, 100, -50]);
    ship.vel = [1, 2, 3];
    const abs = ship.position(world, T0);
    const vAbs = solar.velocity(399, T0).map((v, k) => v + ship.vel[k]);
    ship.rebase(world, 10, T0);
    expect(len(sub(ship.position(world, T0), abs))).toBeLessThan(1e-6);
    const vNow = solar.velocity(10, T0).map((v, k) => v + ship.vel[k]) as Vec3;
    expect(len(sub(vNow, vAbs as Vec3))).toBeLessThan(1e-9);
  });

  it('keeps below the speed of light however hard the engines push', () => {
    const world = solarWorld();
    const ship = new Ship(10, [3e9, 0, 0]);
    ship.power = 1e6;
    ship.look([1, 0, 0], [0, 1, 0]);
    for (let i = 0; i < 100; i++) ship.step(world, T0 + i * 10, 10, 0.1, { ...IDLE, thrust: [0, 0, 1] });
    expect(len(ship.vel)).toBeLessThan(C_KMS);
    expect(len(ship.vel)).toBeGreaterThan(0.99 * C_KMS);
  });
});

describe('Flight: black holes', () => {
  const rg = 10 * 1.476625; // 10 solar masses
  const world: FlightWorld = {
    position: (_id, _t, out = [0, 0, 0]) => { out[0] = out[1] = out[2] = 0; return out; },
    velocity: (_id, _t, out = [0, 0, 0]) => { out[0] = out[1] = out[2] = 0; return out; },
    acceleration: (_id, _t, out = [0, 0, 0]) => { out[0] = out[1] = out[2] = 0; return out; },
    sources: () => [{ id: 1, gm: 10 * GM[10], horizon: 2 * rg }],
    altitude: () => NaN,
    spin: () => undefined,
    radius: () => 2 * rg,
  };

  it('pulls harder than Newton near the horizon, and nothing escapes from inside it', () => {
    const ship = new Ship(1, [20 * rg, 0, 0]);
    ship.assist = false;
    ship.step(world, 0, 1e-9, 0, IDLE);
    const newton = (10 * GM[10]) / (20 * rg) ** 2;
    expect(len(ship.gravity) / newton).toBeCloseTo((20 / 18) ** 2, 6);
    const events = [];
    for (let i = 0; i < 2000 && !events.length; i++) events.push(...ship.step(world, 0, 1e-5, 0, IDLE));
    expect(events[0]?.kind).toBe('horizon');
  });
});

describe('Flight: warp', () => {
  const limiters = (tdb: number): WarpLimiter[] => BODIES.filter((b) => solar.has(b.id, tdb)).map((b) => ({
    id: b.id, pos: solar.position(b.id, tdb), radius: b.radius[0], arrive: b.radius[0],
  }));

  it('carries the ship from Earth to the Moon in seconds and drops out one radius above it', () => {
    const world = solarWorld();
    const earth = solar.position(399, T0), moon = solar.position(301, T0);
    const toMoon = sub(moon, earth);
    const d = len(toMoon);
    const dir: Vec3 = [toMoon[0] / d, toMoon[1] / d, toMoon[2] / d];
    const ship = new Ship(399, [dir[0] * 13000, dir[1] * 13000, dir[2] * 13000]);
    ship.look(dir, [0, 1, 0]);
    expect(ship.engageWarp(world, T0, limiters(T0), true)).toBeUndefined();
    let seconds = 0;
    let dropped: number | undefined;
    let closest = Infinity;
    while (seconds < 60 && dropped === undefined) {
      const events = ship.step(world, T0, 0, 1 / 60, IDLE, limiters(T0));
      seconds += 1 / 60;
      closest = Math.min(closest, len(sub(ship.position(world, T0), moon)));
      dropped = events.find((e) => e.kind === 'dropped')?.id;
    }
    expect(dropped).toBe(301);
    expect(ship.ref).toBe(301);
    expect(seconds).toBeLessThan(20);
    const altitude = len(ship.rel) - 1737.4;
    expect(altitude).toBeGreaterThan(0.9 * 1737.4);
    expect(altitude).toBeLessThan(1737.4);
    expect(closest).toBeGreaterThan(1737.4);
    // Out of warp, at rest relative to the Moon.
    expect(len(ship.vel)).toBe(0);
  });

  it('refuses to start pointing at a body it is already too close to', () => {
    const world = solarWorld();
    const ship = new Ship(399, [8000, 0, 0]);
    ship.look([-1, 0, 0], [0, 1, 0]);
    expect(ship.engageWarp(world, T0, limiters(T0), true)?.kind).toBe('mass-lock');
    ship.look([1, 0, 0], [0, 1, 0]);
    expect(ship.engageWarp(world, T0, limiters(T0), true)).toBeUndefined();
  });

  it('reaches light years per second once clear of the Sun', () => {
    const world = solarWorld();
    const ship = new Ship(10, [0, 2e10, 0]); // 130 AU above the ecliptic
    ship.look([0, 1, 0], [1, 0, 0]);
    ship.engageWarp(world, T0, limiters(T0), true);
    for (let i = 0; i < 60 * 30; i++) ship.step(world, T0, 0, 1 / 60, IDLE, limiters(T0));
    expect(ship.warp.speed / 9.4607e12).toBeGreaterThan(1);
  });
});

void G0;
