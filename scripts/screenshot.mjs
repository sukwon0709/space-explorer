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
  // The nearest galaxies in 3D.
  'andromeda-above': `focus=Andromeda%20Galaxy&t=${T}&pitch=0.6&yaw=0.3`,
  'andromeda-edge': `focus=Andromeda%20Galaxy&t=${T}&pitch=0.08&yaw=1.2`,
  'whirlpool-edge': `focus=Whirlpool%20Galaxy&t=${T}&pitch=0.1&yaw=1.0`,
  // Up close, where the survey images run out of detail: resolved stars, clusters, HII
  // regions and dust filaments fill in below their resolution.
  'andromeda-close': `focus=Andromeda%20Galaxy&t=${T}&dist=6e17&pitch=0.5&yaw=0.3`,
  'andromeda-inside': `focus=Andromeda%20Galaxy&t=${T}&dist=1.5e17&pitch=0.12&yaw=0.8`,
  'whirlpool-close': `focus=Whirlpool%20Galaxy&t=${T}&dist=4e17&pitch=0.9`,
  'sombrero-close': `focus=Sombrero%20Galaxy&t=${T}&dist=4e17&pitch=0.05`,
  'triangulum': `focus=Triangulum%20Galaxy&t=${T}`,
  'sombrero': `focus=Sombrero%20Galaxy&t=${T}`,
  'needle': `focus=Needle%20Galaxy&t=${T}`,
  'large-magellanic-cloud': `focus=Large%20Magellanic%20Cloud&t=${T}`,
  'virgo-cluster': `focus=Virgo%20Cluster&t=${T}`,
  'cosmic-web': `focus=Milky%20Way&t=${T}&dist=2e22&pitch=0.5`,
  'microwave-sky': `focus=Earth&t=${T}&dist=400000&sky=266.4,-28.9&fov=120&cmb=1`,
  'observable-universe': `focus=Milky%20Way&t=${T}&dist=1e24&pitch=0.3`,
  // Flying in to the Pillars of Creation: the whole-field plate picture, the survey
  // close-up (1 arcsec pixels from Earth), then the AI-enhanced one (0.25 arcsec).
  'eagle': `focus=Eagle%20Nebula&t=${T}`,
  'pillars-survey': `focus=Eagle%20Nebula&t=${T}&dist=4e14`,
  'pillars-ai': `focus=Eagle%20Nebula&t=${T}&dist=9e13`,
  'horsehead-close': `focus=Horsehead%20Nebula&t=${T}&dist=1e14`,
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
  // Flight mode: the ship's cockpit display, with a destination picked.
  'flight-earth': `focus=Earth&t=${T}&dist=20000&fly=1&target=Moon`,
  'flight-saturn': `focus=Saturn&t=${T}&dist=500000&pitch=0.25&fly=1&target=Titan`,
  'flight-moon-low': `focus=Moon&t=${T}&lat=-8&lon=-15&dist=25&heading=60&tilt=6&fly=1&target=Earth`,
  // Landing and walking: Mars, Tranquility Base and Jezero crater, from above and on foot.
  'mars-globe': `focus=Mars&t=2026-10-09T16:00:00Z&lat=18.4&lon=77.5&dist=9000&heading=0&tilt=80`,
  'jezero-crater': `focus=Mars&t=2026-10-09T16:00:00Z&lat=18.5&lon=77.4&dist=60&heading=290&tilt=30`,
  'jezero': `site=jezero&t=2026-10-09T16:00:00Z`,
  'jezero-walk': `site=jezero&t=2026-10-09T16:00:00Z&walk=1`,
  'apollo11': `site=apollo11&t=2026-10-18T04:00:00Z`,
  'apollo11-walk': `site=apollo11&t=2026-10-18T04:00:00Z&walk=1`,
  // Landing anywhere: terrain on every solid world, at times its feature is in daylight.
  'mercury-rachmaninoff': `focus=Mercury&t=2026-12-23T00:00:00Z&lat=27.66&lon=57.37&dist=450&heading=0&tilt=35`,
  'mercury-walk': `focus=Mercury&t=2026-12-23T00:00:00Z&lat=26.4&lon=57.37&dist=0.05&heading=0&tilt=5&walk=1`,
  'ceres-occator': `focus=Ceres&t=2026-10-05T07:50:00Z&lat=19.82&lon=-120.67&dist=170&heading=0&tilt=40`,
  'ceres-ahuna': `focus=Ceres&t=2026-10-05T06:02:00Z&lat=-10.48&lon=-43.8&dist=45&heading=0&tilt=22`,
  'ceres-ahuna-walk': `focus=Ceres&t=2026-10-05T06:02:00Z&lat=-10.95&lon=-43.8&dist=0.05&heading=0&tilt=5&walk=1`,
  'vesta-rheasilvia': `focus=Vesta&t=2026-10-05T05:25:00Z&lat=-71.95&lon=86.3&dist=420&heading=0&tilt=40`,
  'phobos-stickney': `focus=Phobos&t=2026-10-05T08:20:00Z&lat=1&lon=-49&dist=12&heading=0&tilt=40`,
  'io-loki': `focus=Io&t=2026-10-06T03:27:00Z&lat=13&lon=51.2&dist=700&heading=0&tilt=40`,
  'europa-conamara': `focus=Europa&t=2026-10-05T21:30:00Z&lat=9.7&lon=87.3&dist=200&heading=0&tilt=35`,
  'pluto-sputnik': `focus=Pluto&t=2026-10-09T12:24:00Z&lat=19.5&lon=178.7&dist=1700&heading=0&tilt=45`,
  // Under thick atmospheres: Venus's ground under the clouds, Titan's under the haze.
  'venus-clouds': `focus=Venus&t=2026-12-12T00:00:00Z&lat=-7.55&lon=-56.31&dist=30000&heading=0&tilt=0`,
  'venus-venera13': `focus=Venus&t=2026-12-12T00:00:00Z&lat=-7.55&lon=-56.31&dist=0.05&heading=0&tilt=8&walk=1`,
  'venus-maxwell': `focus=Venus&t=2027-01-01T00:00:00Z&lat=64.6&lon=3.3&dist=0.05&heading=0&tilt=10&walk=1`,
  // Spacecraft (?mission=): riding along on the navigated trajectories.
  'voyager2-neptune': `mission=voyager-2&t=1989-08-25T02:40:00Z&rate=0&dist=0.02&heading=150&tilt=8`,
  'voyager1-jupiter': `mission=voyager-1&t=1979-03-05T06:00:00Z&rate=0`,
  'voyager1-trail': `mission=voyager-1&t=1990-02-14T04:48:00Z&focus=Sun&dist=1.1e10&tilt=35&heading=200`,
  'voyager2-grand-tour': `mission=voyager-2&t=1989-08-25T03:56:00Z&focus=Sun&dist=1.3e10&tilt=70&heading=0`,
  'galileo-jupiter': `mission=galileo&t=1996-06-27T04:00:00Z&rate=0`,
  'cassini-saturn': `mission=cassini&t=2004-07-01T01:50:00Z&rate=0`,
  'newhorizons-pluto': `mission=new-horizons&t=2015-07-14T11:30:00Z&rate=0`,
  'juno-jupiter': `mission=juno&t=2016-08-27T11:30:00Z&rate=0&dist=0.06&heading=300&tilt=10`,
  'parker-sun': `mission=parker-solar-probe&t=2024-12-24T11:00:00Z&rate=0`,
  'artemis2-moon': `mission=artemis-2&t=2026-04-06T22:40:00Z&rate=0`,
  'artemis1-moon': `mission=artemis-1&t=2022-11-21T12:45:00Z&rate=0`,
  'titan-huygens': `focus=Titan&t=2026-10-08T00:00:00Z&lat=-10.573&lon=167.665&dist=0.05&heading=90&tilt=6&walk=1`,
  'titan-dunes': `focus=Titan&t=2026-10-10T00:00:00Z&lat=-5.5&lon=105&dist=0.05&heading=0&tilt=6&walk=1`,
  'titan-ligeia': `focus=Titan&t=2026-10-11T12:00:00Z&lat=76.85&lon=112&dist=0.05&heading=0&tilt=4&walk=1`,
  // Near light speed (?drive=rocket): a 1 g trip, this far through it (time on board).
  'rocket-start': `fly=1&drive=rocket&target=Proxima%20Centauri&trip=0&rate=0&fov=100&t=${T}`,
  'rocket-proxima-half': `fly=1&drive=rocket&target=Proxima%20Centauri&trip=0.5&rate=0&fov=100&t=${T}`,
  'rocket-proxima-back': `fly=1&drive=rocket&target=Proxima%20Centauri&trip=0.5&rate=0&fov=100&look=180&t=${T}`,
  'rocket-andromeda': `fly=1&drive=rocket&target=Andromeda%20Galaxy&trip=0.5&rate=0&fov=100&t=${T}`,
  'rocket-andromeda-10': `fly=1&drive=rocket&target=Andromeda%20Galaxy&trip=0.1&rate=0&fov=100&t=${T}`,
  'rocket-andromeda-13': `fly=1&drive=rocket&target=Andromeda%20Galaxy&trip=0.13&rate=0&fov=100&t=${T}`,
  'rocket-andromeda-22': `fly=1&drive=rocket&target=Andromeda%20Galaxy&trip=0.22&rate=0&fov=100&t=${T}`,
  'rocket-andromeda-30': `fly=1&drive=rocket&target=Andromeda%20Galaxy&trip=0.3&rate=0&fov=100&t=${T}`,
  // Star systems: stars up close, binary companions, exoplanets (looks estimated).
  'sirius-system': `focus=Sirius&t=${T}&dist=1.5e10&pitch=1.2`,
  'sirius-b': `focus=Sirius%20B&t=${T}&dist=40000`,
  'alpha-centauri': `focus=Rigil%20Kentaurus&t=${T}&dist=5e9&pitch=0.4`,
  'alpha-cen-a': `focus=Rigil%20Kentaurus&t=${T}&dist=2.2e6`,
  'proxima': `focus=Proxima&t=${T}&dist=3e5`,
  'proxima-b': `focus=Proxima%20Cen%20b&t=${T}`,
  'trappist-1e': `focus=TRAPPIST-1%20e&t=${T}`,
  'trappist-1-system': `focus=TRAPPIST-1&t=${T}&dist=1.5e7&pitch=0.6`,
  'hd-189733-b': `focus=HD%20189733%20b&t=${T}`,
  '55-cnc-e': `focus=55%20Cnc%20e&t=${T}`,
  'kelt-9-b': `focus=KELT-9%20b&t=${T}`,
  'eps-eri-b': `focus=eps%20Eri%20b&t=${T}`,
  // Sky events (the Events menu), mid-event.
  'transit-venus-2012': `event=transit%20venus%202012&t=2012-06-06T01:29:36Z`,
  'transit-mercury-2019': `event=transit%20mercury%202019&t=2019-11-11T15:19:48Z`,
  'phobos-transit': `event=phobos%202%20apr%202022&t=2022-04-02T10:54:47Z`,
  'apophis': `event=apophis&t=2029-04-13T21:45:00Z`,
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
  // Close-up pictures load one after another as each takes over from its parent.
  if (query.includes('Nebula&')) await page.waitForTimeout(6000);
  await page.screenshot({ timeout: 180000, path: `${outDir}/${name}.png` });
  console.log(`saved ${outDir}/${name}.png`);
}
await browser.close();
await server.close();
