// Flies a gravity assist in headless Chromium and prints the cockpit readouts: from
// near a planet, Y sets up a flyby of it; the readouts and screenshots follow the pass.
// Usage: node scripts/gravity-check.mjs [outPrefix] [planet] [seconds of the shots, a,b,c]
// [start distance km] [extra query, e.g. "noflyby=1"] (noflyby: just sit there, assist on).
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const out = process.argv[2] ?? 'gravity';
const planet = process.argv[3] ?? 'Jupiter';
const shots = (process.argv[4] ?? '4,14,22,40').split(',').map(Number);
const dist = process.argv[5] ?? '3000000';
const extra = process.argv[6] ?? '';
const server = await createServer({ server: { port: 5199 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text().slice(0, 300)); });
const show = async (label) => {
  const r = await page.evaluate(() => ({
    lines: document.querySelector('.flight-lines')?.textContent ?? '',
    message: document.querySelector('.flight-message')?.textContent ?? '',
    tides: document.querySelector('.flight-tides')?.textContent ?? '',
  }));
  console.log(`--- ${label}${r.message ? ` "${r.message}"` : ''} [${r.tides}]\n${r.lines}`);
};

await page.goto(`http://localhost:5199/?focus=${encodeURIComponent(planet)}&t=2026-10-05T04:00:00Z&dist=${dist}&fly=1&target=${encodeURIComponent(planet)}${extra ? `&${extra}` : ''}`, { timeout: 180000 });
await page.waitForSelector('body[data-ready="true"]', { timeout: 120000 });
await page.waitForTimeout(3000);
await show('start');
if (!extra.includes('noflyby')) await page.keyboard.press('y');
let t = 0;
for (const [k, at] of shots.entries()) {
  await page.waitForTimeout((at - t) * 1000);
  t = at;
  await show(`${at} s into the flyby`);
  await page.screenshot({ path: `${out}-${k}.png` });
}
await browser.close();
await server.close();
