// Flies the ship in headless Chromium and prints the cockpit readouts: start near
// Earth, warp to the Moon, then out to Sirius. Usage: node scripts/fly-check.mjs [outPrefix]
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const out = process.argv[2] ?? 'fly';
const server = await createServer({ server: { port: 5198 }, logLevel: 'error' });
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

await page.goto('http://localhost:5198/?focus=Earth&t=2026-10-05T04:00:00Z&dist=20000&fly=1&target=Moon', { timeout: 180000 });
await page.waitForSelector('body[data-ready="true"]', { timeout: 120000 });
await page.waitForTimeout(3000);
await show('start');
await page.keyboard.down('w');
await page.waitForTimeout(3000);
await page.keyboard.up('w');
await show('after thrust');
// One press: turn toward the Moon, then warp.
await page.keyboard.press('x');
await until('warp to the Moon', (r) => /Arrived|Dropped/.test(r.message), 240);
await page.screenshot({ path: `${out}-moon.png` });
await page.locator('#search').fill('Sirius');
await page.locator('#search').press('Enter');
await page.waitForTimeout(500);
await page.keyboard.press('x');
await show('warp engaged');
await until('warp to Sirius', (r) => /Arrived|Dropped/.test(r.message), 900);
await page.screenshot({ path: `${out}-sirius.png` });
await browser.close();
await server.close();
