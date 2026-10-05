// Renders reference views of the built app in headless Chromium and saves PNGs.
// Usage: npm run screenshot [-- outDir [view,view]]
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';

const outDir = process.argv[2] ?? 'screenshots';
mkdirSync(outDir, { recursive: true });

// A fixed epoch keeps the views reproducible (it matches the bundled cloud map).
const T = '2026-10-05T04:00:00Z';
const views = {
  'earth': `focus=Earth&t=${T}`,
  'earth-night': `focus=Earth&t=2026-10-05T22:00:00Z&lat=45&lon=10&dist=5000&heading=0&tilt=70`,
  'grand-canyon': `focus=Earth&t=2026-10-05T17:30:00Z&lat=36.075&lon=-112.13&dist=14&heading=10&tilt=28`,
  'grand-canyon-rim': `focus=Earth&t=2026-10-05T17:30:00Z&lat=36.075&lon=-112.11&dist=7&heading=195&tilt=12`,
  'iss': `focus=Earth&t=2026-10-05T04:12:00Z&lat=-1&lon=38&dist=2500&heading=20&tilt=35`,
  'satellites': `focus=Earth&t=${T}&dist=60000&tilt=25`,
  'moon': `focus=Moon&t=${T}`,
  'earth-moon': `focus=Earth&t=${T}&dist=900000&heading=200&tilt=20`,
  'saturn-2017': `focus=Saturn&t=2017-06-15T00:00:00Z&dist=420000&pitch=0.45`, // rings near widest (solstice)
  'jupiter': `focus=Jupiter&t=${T}&dist=300000`,
};
const only = process.argv[3]?.split(',');

const server = await createServer({ server: { port: 5199 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error('console:', m.text().slice(0, 300)); });
for (const [name, query] of Object.entries(views)) {
  if (only && !only.includes(name)) continue;
  await page.goto(`http://localhost:5199/?${query}&rate=0&capture`, { timeout: 180000 });
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60000 });
  // Let the terrain stream in: wait until no tiles are loading for a moment.
  for (let quiet = 0, t = 0; quiet < 3 && t < 120; t++) {
    await page.waitForTimeout(1000);
    quiet = (await page.evaluate(() => document.body.dataset.tiles)) === 'idle' ? quiet + 1 : 0;
  }
  await page.screenshot({ timeout: 180000, path: `${outDir}/${name}.png` });
  console.log(`saved ${outDir}/${name}.png`);
}
await browser.close();
await server.close();
