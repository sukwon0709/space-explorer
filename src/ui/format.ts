const AU = 149597870.7;
const LIGHT_YEAR = 9460730472580.8;

export function formatDistance(km: number): string {
  const abs = Math.abs(km);
  if (abs < 1) return `${(km * 1000).toFixed(0)} m`;
  if (abs < 1e6) return `${km.toLocaleString('en-US', { maximumFractionDigits: abs < 100 ? 2 : 0 })} km`;
  if (abs < 0.1 * LIGHT_YEAR) return `${(km / AU).toFixed(abs < 10 * AU ? 3 : 1)} AU`;
  return `${(km / LIGHT_YEAR).toFixed(2)} light years`;
}

export function formatUtc(unixMs: number): string {
  const iso = new Date(unixMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}
