// Flies the relativistic rocket in headless Chromium and prints the cockpit readouts:
// from near Earth, V for the rocket, X to Proxima Centauri at 1 g, then the time bar's
// fastest rate until arrival. Usage: node scripts/rocket-check.mjs [outPrefix]
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const out = process.argv[2] ?? 'rocket';
const server = await createServer({ server: { port: 5199 }, logLevel: 'error' });
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
}));
const show = async (label) => {
  const r = await read();
  console.log(`--- ${label}${r.message ? ` "${r.message}"` : ''}\n${r.lines}`);
  return r;
};

await page.goto('http://localhost:5199/?focus=Earth&t=2026-10-05T04:00:00Z&dist=20000&fly=1&target=Proxima%20Centauri', { timeout: 180000 });
await page.waitForSelector('body[data-ready="true"]', { timeout: 120000 });
await page.waitForTimeout(3000);
await page.keyboard.press('v');
await show('rocket on');
await page.keyboard.press('x');
for (let t = 0; t < 30; t++) {
  await page.waitForTimeout(1000);
  if (/Off to/.test((await read()).message)) break;
}
await show('lift-off');
await page.waitForTimeout(20000);
await show('20 s later');
await page.screenshot({ path: `${out}-cruise.png` });
for (let t = 0; t < 240; t++) {
  await page.waitForTimeout(1000);
  if (/Arrived/.test((await read()).message)) break;
}
await show('arrival');
await page.screenshot({ path: `${out}-arrival.png` });
await browser.close();
await server.close();
