// Frame-time profile of heavy views in headless Chromium (?perf=1).
// Usage: node scripts/perf.mjs [out.json] [view,view] [--build dist]
// Per view: median and p90 of the JS update, render (CPU submit + GPU, via gl.finish)
// and post-render time, draw calls, triangles and points, and the renderer's memory.
// Headless runs on SwiftShader (the GPU emulated on the CPU), so absolute times are far
// slower than a real GPU; compare before/after on the same machine.
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'perf.json';
const only = process.argv[3]?.split(',');
const T = '2026-10-05T04:00:00Z';
export const views = {
  'earth': `focus=Earth&t=${T}`,
  'grand-canyon': `focus=Earth&t=2026-10-05T17:30:00Z&lat=36.075&lon=-112.13&dist=14&heading=10&tilt=28`,
  'satellites': `focus=Earth&t=${T}&dist=60000&tilt=25`,
  'saturn': `focus=Saturn&t=${T}`,
  'asteroid-belt': `focus=Sun&t=${T}&dist=900000000&pitch=0.7`,
  'sky-wide': `focus=Earth&t=${T}&dist=400000&sky=290,30&fov=90`,
  'sun-from-500pc': `focus=Sun&t=${T}&dist=1.5e16&pitch=0.15&fov=80`,
  'milky-way': `focus=Milky%20Way&t=${T}`,
  'andromeda-inside': `focus=Andromeda%20Galaxy&t=${T}&dist=1.5e17&pitch=0.12&yaw=0.8`,
  'cosmic-web': `focus=Milky%20Way&t=${T}&dist=2e22&pitch=0.5`,
  'pillars-ai': `focus=Eagle%20Nebula&t=${T}&dist=9e13`,
  'sgr-a': `focus=Sgr%20A*&t=${T}`,
  'jezero-walk': `site=jezero&t=2026-10-09T16:00:00Z&walk=1`,
  'bennu': `focus=Bennu&t=2020-10-20T21:40:00Z`,
  'sn1987a-day40': `cosmic=sn1987a&at=40&dist=4e10&pitch=1.1`,
  'gw150914-last-orbits': `cosmic=gw150914&at=-0.015&dist=3000&pitch=0.3`,
};

const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const server = await createServer({ server: { port: 5198 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
const results = {};
for (const [name, query] of Object.entries(views)) {
  if (only && !only.includes(name)) continue;
  await page.goto(`http://localhost:5198/?${query}&rate=0&perf=1&quality=high`, { timeout: 180000 });
  await page.waitForSelector('body[data-ready="true"]', { timeout: 120000 });
  for (let quiet = 0, t = 0; quiet < 3 && t < 90; t++) {
    await page.waitForTimeout(1000);
    quiet = (await page.evaluate(() => document.body.dataset.tiles)) === 'idle' ? quiet + 1 : 0;
  }
  await page.evaluate(() => { window.__perf.frames.length = 0; });
  // At least 12 frames (SwiftShader is slow), at most 60 s.
  for (let t = 0; t < 60 && (await page.evaluate(() => window.__perf.frames.length)) < 10; t++) await page.waitForTimeout(1000);
  const p = await page.evaluate(() => window.__perf);
  const f = p.frames.slice(2);
  if (!f.length) { console.log(name, 'no frames'); continue; }
  const col = (k) => f.map((x) => x[k]);
  const r = {
    frames: f.length,
    update: +pct(col('update'), 0.5).toFixed(2), render: +pct(col('render'), 0.5).toFixed(2), renderP90: +pct(col('render'), 0.9).toFixed(2),
    post: +pct(col('post'), 0.5).toFixed(2), total: +pct(f.map((x) => x.update + x.render + x.post), 0.5).toFixed(2),
    calls: pct(col('calls'), 0.5), tris: pct(col('tris'), 0.5), points: pct(col('points'), 0.5),
    programs: p.programs, geometries: p.geometries, textures: p.textures,
  };
  results[name] = r;
  console.log(name.padEnd(22), JSON.stringify(r));
}
writeFileSync(out, JSON.stringify(results, null, 1));
await browser.close();
await server.close();
