const AU = 149597870.7;
const LIGHT_YEAR = 9460730472580.8;

export function formatDistance(km: number): string {
  const abs = Math.abs(km);
  if (abs < 1) return `${(km * 1000).toFixed(0)} m`;
  if (abs < 1e6) return `${km.toLocaleString('en-US', { maximumFractionDigits: abs < 100 ? 2 : 0 })} km`;
  if (abs < 0.1 * LIGHT_YEAR) return `${(km / AU).toFixed(abs < 10 * AU ? 3 : 1)} AU`;
  return formatLightYearCount(km / LIGHT_YEAR);
}

/** A count of light years in words past a million: 2.54 million light years. */
export function formatLightYearCount(ly: number): string {
  if (ly < 100) return `${ly.toFixed(2)} light years`;
  if (ly < 1e6) return `${Math.round(ly).toLocaleString('en-US')} light years`;
  if (ly < 1e9) return `${(ly / 1e6).toPrecision(3)} million light years`;
  return `${(ly / 1e9).toPrecision(3)} billion light years`;
}

/** Years in words: 2.5 million years. */
export function formatYears(years: number): string {
  if (years < 1e4) return `${Math.round(years).toLocaleString('en-US')} years`;
  if (years < 1e6) return `${Math.round(years / 1000).toLocaleString('en-US')},000 years`;
  if (years < 1e9) return `${(years / 1e6).toPrecision(3)} million years`;
  return `${(years / 1e9).toPrecision(3)} billion years`;
}

export function formatUtc(unixMs: number): string {
  const iso = new Date(unixMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}
