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
  // Milestone 3: the 2027 eclipse from the ground at Luxor (mid-totality) and from space.
  'eclipse-luxor': `focus=Earth&t=2027-08-02T10:05:15Z&lat=25.6989&lon=32.6421&dist=0.05&tilt=4&aim=sun&fov=5`,
  'eclipse-shadow': `focus=Earth&t=2027-08-02T10:05:30Z&lat=25.75&lon=32.79&dist=9000&heading=0&tilt=88`,
  'lunar-eclipse': `focus=Moon&t=2026-03-03T11:34:00Z&lat=0&lon=0&dist=9000&heading=0&tilt=88`,
  'sun': `focus=Sun&t=${T}`,
  'mercury': `focus=Mercury&t=${T}`,
  'venus': `focus=Venus&t=${T}`,
  'mars': `focus=Mars&t=${T}`,
  'jupiter': `focus=Jupiter&t=${T}&dist=300000`,
  'jupiter-io-shadow': `focus=Jupiter&t=2026-10-07T10:19:00Z&dist=330000`,
  'galilean-moons': `focus=Jupiter&t=${T}&dist=4000000&pitch=0.3`,
  'io': `focus=Io&t=${T}`,
  'europa': `focus=Europa&t=${T}`,
  'saturn-2017': `focus=Saturn&t=2017-06-15T00:00:00Z&dist=420000&pitch=0.45`, // rings near widest (solstice)
  'saturn': `focus=Saturn&t=${T}`,
  'titan': `focus=Titan&t=${T}`,
  'uranus': `focus=Uranus&t=${T}&dist=150000`,
  'neptune': `focus=Neptune&t=${T}`,
  'pluto-charon': `focus=Pluto&t=${T}&dist=40000`,
  'ceres': `focus=Ceres&t=${T}`,
  'asteroid-belt': `focus=Sun&t=${T}&dist=900000000&pitch=0.7`,
  'comet-encke': `focus=2P/Encke&t=${T}`,
  // Milestone 4: the stars.
  'orion': `focus=Earth&t=${T}&dist=400000&sky=84,-1&fov=40&constellations=1`,
  'sky-wide': `focus=Earth&t=${T}&dist=400000&sky=290,30&fov=90`,
  'sirius': `focus=Sirius&t=${T}`,
  'betelgeuse': `focus=Betelgeuse&t=${T}`,
  'trappist-1': `focus=TRAPPIST-1&t=${T}&exoplanets=1`,
  'trappist-1-orbits': `focus=TRAPPIST-1&t=${T}&exoplanets=1&dist=25000000&pitch=0.5`,
  'galactic-centre': `focus=Earth&t=${T}&dist=400000&sky=266.4,-28.9&fov=100`,
  'sun-from-500pc': `focus=Sun&t=${T}&dist=1.5e16&pitch=0.15&fov=80`,
  // Milestone 5: the Milky Way and beyond.
  'milky-way': `focus=Milky%20Way&t=${T}`,
  'milky-way-edge': `focus=Milky%20Way&t=${T}&pitch=0.05`,
  'andromeda-from-earth': `focus=Earth&t=${T}&dist=400000&sky=10.68,41.27&fov=6`,
  'andromeda': `focus=Andromeda%20Galaxy&t=${T}`,
  'local-group': `focus=Local%20Group&t=${T}`,
  'orion-nebula': `focus=Orion%20Nebula&t=${T}`,
  'orion-from-earth': `focus=Earth&t=${T}&dist=400000&sky=83.8,-5.4&fov=12`,
  'whirlpool': `focus=Whirlpool%20Galaxy&t=${T}`,
  'virgo-cluster': `focus=Virgo%20Cluster&t=${T}`,
  'cosmic-web': `focus=Milky%20Way&t=${T}&dist=2e22&pitch=0.5`,
  'microwave-sky': `focus=Earth&t=${T}&dist=400000&sky=266.4,-28.9&fov=120&cmb=1`,
  'observable-universe': `focus=Milky%20Way&t=${T}&dist=1e24&pitch=0.3`,
  // Milestone 6: black holes.
  'sgr-a': `focus=Sgr%20A*&t=${T}`,
  'sgr-a-visible': `focus=Sgr%20A*&t=${T}&radio=0&dist=1.2e8&pitch=0.3`,
  's-stars': `focus=Sgr%20A*&t=${T}&dist=1.5e12&pitch=0.6&radio=0`,
  'm87': `focus=M87*&t=${T}`,
  'gaia-bh3': `focus=Gaia%20BH3&t=${T}`,
  'cygnus-x1': `focus=Cygnus%20X-1&t=${T}`,
  'cygnus-x1-system': `focus=Cygnus%20X-1&t=${T}&dist=2e7&pitch=0.25`,
  'tour-edge': `t=${T}&tour=1&step=14`,
  'tour-sgr-a': `t=${T}&tour=2&step=6`,
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
