/**
 * Time scales. The ephemeris runs on TDB; people think in UTC.
 * UTC -> TAI (leap seconds) -> TT (+32.184 s) -> TDB (periodic term, < 2 ms).
 */

export const J2000_UNIX_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

// [UTC instant the offset starts, TAI - UTC in seconds]. IERS Bulletin C; none added since 2017.
const LEAP_SECONDS: ReadonlyArray<readonly [number, number]> = [
  [Date.UTC(1972, 0, 1), 10], [Date.UTC(1972, 6, 1), 11], [Date.UTC(1973, 0, 1), 12],
  [Date.UTC(1974, 0, 1), 13], [Date.UTC(1975, 0, 1), 14], [Date.UTC(1976, 0, 1), 15],
  [Date.UTC(1977, 0, 1), 16], [Date.UTC(1978, 0, 1), 17], [Date.UTC(1979, 0, 1), 18],
  [Date.UTC(1980, 0, 1), 19], [Date.UTC(1981, 6, 1), 20], [Date.UTC(1982, 6, 1), 21],
  [Date.UTC(1983, 6, 1), 22], [Date.UTC(1985, 6, 1), 23], [Date.UTC(1988, 0, 1), 24],
  [Date.UTC(1990, 0, 1), 25], [Date.UTC(1991, 0, 1), 26], [Date.UTC(1992, 6, 1), 27],
  [Date.UTC(1993, 6, 1), 28], [Date.UTC(1994, 6, 1), 29], [Date.UTC(1996, 0, 1), 30],
  [Date.UTC(1997, 6, 1), 31], [Date.UTC(1999, 0, 1), 32], [Date.UTC(2006, 0, 1), 33],
  [Date.UTC(2009, 0, 1), 34], [Date.UTC(2012, 6, 1), 35], [Date.UTC(2015, 6, 1), 36],
  [Date.UTC(2017, 0, 1), 37],
];

export function taiMinusUtc(unixMs: number): number {
  let offset = 10;
  for (const [from, value] of LEAP_SECONDS) {
    if (unixMs >= from) offset = value;
    else break;
  }
  return offset;
}

/** TDB - TT in seconds (Fairhead & Bretagnon leading terms, accurate to ~30 µs). */
export function tdbMinusTt(ttSecondsPastJ2000: number): number {
  const g = (357.53 + 0.98560028 * (ttSecondsPastJ2000 / 86400)) * (Math.PI / 180);
  return 0.001657 * Math.sin(g) + 0.000014 * Math.sin(2 * g);
}

/** UTC (Unix ms) to TDB seconds past J2000. */
export function utcToTdb(unixMs: number): number {
  const utcSeconds = (unixMs - J2000_UNIX_MS) / 1000;
  const tt = utcSeconds + taiMinusUtc(unixMs) + 32.184;
  return tt + tdbMinusTt(tt);
}

/** TDB seconds past J2000 to UTC (Unix ms). Inverts utcToTdb to well under a millisecond. */
export function tdbToUtc(tdb: number): number {
  let unixMs = J2000_UNIX_MS + (tdb - 69.184) * 1000;
  for (let i = 0; i < 3; i++) unixMs += (tdb - utcToTdb(unixMs)) * 1000;
  return unixMs;
}

/** Simulation clock: TDB that advances at an adjustable rate (simulated seconds per real second). */
export class Clock {
  tdb: number;
  rate = 1;
  paused = false;

  constructor(
    unixMs: number,
    private readonly min = -Infinity,
    private readonly max = Infinity,
  ) {
    this.tdb = this.clamp(utcToTdb(unixMs));
  }

  tick(realSeconds: number): void {
    if (!this.paused) this.tdb = this.clamp(this.tdb + realSeconds * this.rate);
  }

  setUtc(unixMs: number): void {
    this.tdb = this.clamp(utcToTdb(unixMs));
  }

  get utc(): number {
    return tdbToUtc(this.tdb);
  }

  /** The clock's range, UTC (Unix ms). */
  get minUtc(): number {
    return tdbToUtc(this.min);
  }

  get maxUtc(): number {
    return tdbToUtc(this.max);
  }

  private clamp(tdb: number): number {
    if (tdb < this.min || tdb > this.max) this.paused = true;
    return Math.min(this.max, Math.max(this.min, tdb));
  }
}
