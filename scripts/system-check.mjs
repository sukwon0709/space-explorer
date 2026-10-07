// Flies the ship around another star system in headless Chromium and prints the
// cockpit readouts: start near Proxima Centauri, fly to Proxima b, then on to
// Alpha Centauri B. Usage: node scripts/system-check.mjs [outPrefix]
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const out = process.argv[2] ?? 'system';
const server = await createServer({ server: { port: 5197 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text().slice(0, 300)); });
const read = () => page.evaluate(() => ({
  lines: document.querySelector('.flight-lines')?.textContent ?? '',
  message: document.querySelector('.flight-message')?.textContent ?? '',
  near: document.getElementById('focus-name').textContent,
}));
const show = async (label) => {
  const r = await read();
  console.log(`--- ${label} (near ${r.near})${r.message ? ` "${r.message}"` : ''}\n${r.lines}`);
  return r;
};
const until = async (label, test, seconds) => {
  for (let t = 0; t < seconds; t++) {
    await page.waitForTimeout(1000);
    const r = await read();
    if (test(r)) return show(label);
  }
  return show(`${label} (timed out)`);
};

await page.goto('http://localhost:5197/?focus=Proxima&t=2026-10-05T04:00:00Z&dist=2e7&fly=1&target=Proxima%20Cen%20b', { timeout: 180000 });
await page.waitForSelector('body[data-ready="true"]', { timeout: 120000 });
await page.waitForTimeout(3000);
await show('start');
await page.keyboard.press('x');
await until('to Proxima b', (r) => /Arrived|Dropped/.test(r.message), 400);
await page.waitForTimeout(3000);
await show('at Proxima b');
await page.screenshot({ path: `${out}-proxima-b.png` });
await page.locator('#search').fill('Toliman');
await page.locator('#search').press('Enter');
await page.waitForTimeout(500);
await page.keyboard.press('x');
await until('to Alpha Centauri B', (r) => /Arrived|Dropped/.test(r.message), 600);
await page.waitForTimeout(2000);
await show('at Alpha Centauri B');
await page.screenshot({ path: `${out}-alpha-cen-b.png` });
await browser.close();
await server.close();
