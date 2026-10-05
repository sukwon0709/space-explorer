// Renders reference views of the built app in headless Chromium and saves PNGs.
// Usage: npm run build && npm run screenshot [-- outDir]
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';

const outDir = process.argv[2] ?? 'screenshots';
mkdirSync(outDir, { recursive: true });

// A fixed epoch keeps the views reproducible.
const T = '2026-10-05T04:00:00Z';
const views = {
  'earth-moon': `focus=Earth&t=${T}&dist=900000&yaw=2.2&pitch=0.25`,
  'inner-system': `focus=Sun&t=${T}&dist=600000000&yaw=0.3&pitch=0.9`,
  'saturn-2017': `focus=Saturn&t=2017-06-15T00:00:00Z&dist=420000&pitch=0.45`, // rings near widest (solstice)
  'saturn-2026': `focus=Saturn&t=${T}&dist=420000&pitch=0.45`, // rings nearly edge-on after the 2025 equinox
  'jupiter': `focus=Jupiter&t=${T}&dist=300000`,
  'earth-close': `focus=Earth&t=${T}&dist=16000`,
};

const server = await createServer({ server: { port: 5199 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
for (const [name, query] of Object.entries(views)) {
  await page.goto(`http://localhost:5199/?${query}&rate=0&capture`);
  await page.waitForSelector('body[data-ready="true"]', { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`saved ${outDir}/${name}.png`);
}
await browser.close();
await server.close();
