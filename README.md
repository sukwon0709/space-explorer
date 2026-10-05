# Space Explorer

A real-time 3D simulator for travelling from Earth through the Solar System and out to distant galaxies, with every object placed and drawn from real observational data. It runs in the browser (TypeScript + three.js).

The full plan, including the roadmap, lives in the [design doc](https://claude.ai/code/artifact/c235450b-21cd-41a8-bc4b-b69ca4239c84).

## Milestone 3: the Solar System (this code)

- **Every planet, the major moons, Pluto and Charon, and Ceres, Vesta, Pallas and Hygiea** (`src/core/bodies.ts`), as triaxial ellipsoids with IAU 2015 radii, turning with the IAU rotation models from NAIF's pck00011 (`src/core/iau.ts`, matching SPICE to 1e-9 rad in `tests/rotation.test.ts`).
- **Moon and asteroid positions from JPL's satellite and asteroid kernels** (mar099, jup365, sat441, ura184, nep097, plu060, sb441-n16), refitted to float32 Chebyshev series within 1 km and checked against the kernels at 930 epochs that were not fitted (`tests/moons.test.ts`). Each system's file loads when the camera nears it.
- **Global maps** from USGS mosaics (MESSENGER, Viking, Mars Express, Galileo, Voyager, Cassini, Dawn, New Horizons) and, for Jupiter and Saturn, the 2025 Hubble OPAL maps (`pipeline/build_maps.py`). Uranus and Neptune use OPAL latitude profiles with their true colours (Irwin et al. 2024). Monochrome maps, and Viking's false-colour Mars, are tinted with each body's colour. Every map is colour-balanced so its average matches the body's colour at its geometric albedo.
- **Shading and shadows.** Cloud decks use Minnaert limb darkening, rocky and icy surfaces a Lommel-Seeliger/Lambert mix. Moons cast shadows on planets and each other, and planets on their moons, from the overlap of the Sun's and the body's discs, so penumbrae are right (`src/render/shadow.ts`).
- **Rings.** Saturn's radial profile is from the Cassini radio occultation of 3 May 2005 at 1 km resolution. Jupiter's, Uranus's and Neptune's rings use published widths and optical depths. Rings are lit by single scattering in a layer of that optical depth (lit and unlit faces differ), the planet's shadow falls across them, and their shadow falls on the planet (`src/render/rings.ts`).
- **The Sun.** The photosphere is the SDO/HMI continuum image of 21 Sep 2026 15:15 UTC, sunspots and all, projected onto the Sun and turning with it, with limb darkening. The corona (Baumbach model) appears only when the disc is covered. Glare fades with the fraction of the disc in view.
- **Eclipses.** The Moon's shadow darkens the ground, the clouds and the air on Earth, and Earth's shadow turns the Moon red. **Gate:** the 2 August 2027 total eclipse computed from DE440 and IERS Earth orientation matches NASA's published path of totality. The central line is within 0.69 km across the track and 1.3 s along it, the north and south limits within 0.68 km, and the duration at greatest eclipse is 382.5 s against NASA's 382.6 s (`tests/eclipse.test.ts`).
- **Asteroids and comets.** 238,333 asteroids (every numbered one brighter than H = 16, plus every near-Earth asteroid; NEAs in orange) are solved from their orbits on the GPU each frame. About 4,000 comets are solved on the CPU, with elliptic, parabolic and hyperbolic orbits. Both come from the JPL Small-Body Database and show when the view is wide.
- **Exposure.** Exposure follows the eye. Sunlit ground looks the same at Neptune as at Earth, bright clouds and ice get less exposure than dark rock, and the eye opens up in the dark of totality.
- **Time bar.** Rates from −30 days to +30 days per second, a date and time box (UTC), and an events menu. The menu has the 2027 eclipse from Luxor and from space, the 2026 eclipse from Burgos, the lunar eclipses of 3 Mar 2026 and 31 Dec 2028, Io's shadow on Jupiter and Saturn in 2017. Event times were found with the app's own ephemeris.
- **Go-to search** over every body, 260 named asteroids and every comet.

New URL parameters: `look` turns the view up from the ground toward the sky (degrees), `aim=sun` faces the Sun from a ground point, and `fov` sets the field of view. For example, totality from Luxor is `?focus=Earth&t=2027-08-02T10:05:15Z&lat=25.6989&lon=32.6421&dist=0.05&tilt=4&aim=sun&fov=5`. `focus` also takes asteroid and comet names (`?focus=2P/Encke`).

### Limits

- Moon and asteroid positions cover 1960–2060, like DE440 in the app. The two-body asteroid and comet orbits leave out planetary perturbations, which is fine for drawing them but drifts by thousands of km over years.
- The Sun's map is one day's view from Earth. The far side is shown as quiet Sun, and spots change from day to day.
- Parts of some moons were never imaged (Triton 61% coverage, Pluto 68%, Charon 66%). Those areas show the body's average colour. Venus and Titan have no visible-light surface, so they are their cloud colour. Mimas, Hyperion, Phoebe, the Uranian moons, Deimos, Pallas and Hygiea have no map yet. Vesta's map uses the IAU 2015 prime meridian, which was not checked against the mosaic.
- Shadows treat each occluder as a sphere. The corona is a smooth model without streamers. The red of a lunar eclipse is an approximate colour, not computed from Earth's atmosphere.
- Each body has one ring shadow source, its own rings. Rings do not shadow moons.

## Milestone 2: Earth and Moon surfaces

- **Streaming terrain.** Earth and the Moon are quadtrees of terrain tiles (`src/render/globe.ts`), loaded on demand from tile packs and refined until each texel is about a pixel. Each tile's centre is float64 and its vertices are float32 offsets from it, placed relative to the camera every frame, so you can go from 1.5 m above the ground to the Moon without jitter (`tests/jitter.test.ts` replays the float32 GPU path: worst error 0.007 px).
- **Earth.** NASA Blue Marble colour (2.4 km pixels), NOAA ETOPO 2022 heights on the WGS84 ellipsoid (EGM96 geoid added, oceans at sea level), and NASA Black Marble city lights on the night side.
- **Grand Canyon showcase.** Copernicus Sentinel-2 10 m true colour and Copernicus DEM GLO-30 heights for the canyon (36.04–36.30 N, 112.02–112.30 W) down to tile level 13. Elsewhere Earth stops at the global data.
- **Atmosphere.** Single-scattering Rayleigh, Mie and ozone, ray-marched per pixel for the sky and for aerial perspective and sunlight colour on the ground (`src/render/atmosphere.ts`). Stars fade out in the daytime sky.
- **Real clouds.** One hour of NOAA's GMGSI geostationary infrared mosaic (2026-10-05 04:00 UTC) turned into cloud cover on a shell 6 km up.
- **The Moon.** LRO LROC colour and LOLA heights, lit with a Lommel-Seeliger/Lambert mix (the flat look of the full Moon).
- **True orientation.** Earth turns with IERS-measured UT1 and polar motion (NAIF ITRF93 kernels) and the Moon with DE440 librations (MOON_ME), fitted to Chebyshev series within 0.1 m and 1 mm on the surface (`tests/orientation.test.ts`).
- **Positions from JPL DE440** (1960–2060), checked against the JPL Horizons API: worst difference 3.7 m for the Moon, under 0.25 m for everything else.
- **Earth satellites.** The ISS, Tiangong, bright satellites and GPS from CelesTrak elements, propagated with SGP4 (`satellite.js`). A bundled snapshot shows at once and current elements replace it when CelesTrak can be reached. Satellites in Earth's shadow are dimmed; the two stations get labels and orbit trails. Positions match skyfield within 0.2 km (`tests/satellites.test.ts`).
- **Google Earth style controls on Earth and the Moon.** Drag to move across the ground, right-drag or shift-drag to turn and tilt, scroll to zoom. The camera stays above the terrain.

Views can be linked with URL parameters, for example `?focus=Earth&lat=36.075&lon=-112.13&dist=14&heading=10&tilt=28&t=2026-10-05T17:30Z` (degrees and km; `heading` is the direction faced, `tilt` the camera's height above the horizon seen from the look point).

### Limits

- Detailed imagery and terrain exist for the Grand Canyon only. The rest of Earth is 2.4 km imagery on a 10 km height grid (level 5 tiles, refined three levels further for shape only).
- Clouds are one fixed hour; infrared misses warm low cloud and fog.
- Blue Marble is a single cloud-free composite, not monthly.
- The Moon's colour mosaic is stretched for display and scaled back to an average albedo of 0.12.
- SGP4 elements are only shown within 30 days of their epoch.

## Milestone 1: foundations

- **Correct time scales.** UTC is converted to TDB (leap seconds, TT, TDB periodic term), the time scale the ephemeris uses (`src/core/time.ts`).
- **Precision at every scale.** Positions stay in float64. Each frame the camera position is subtracted before anything reaches the GPU (floating origin), and a logarithmic depth buffer covers 1 cm to 10^13 km.
- **Real sky.** 41,411 stars from the XHIP Hipparcos compilation, coloured from their measured B–V index.
- **True shapes.** IAU radii and oblateness, IAU pole directions, and Saturn's rings from Cassini measurements.

## Develop

```sh
npm install
npm run dev          # http://localhost:5173
npm test             # ephemeris, Horizons, orientation, rotation, moons, eclipse, satellites, jitter and time tests
npm run build
npm run screenshot   # renders reference views to screenshots/ (headless Chromium)
```

## Data pipeline

Data files in `public/data/` are generated by Python scripts in `pipeline/`. Raw downloads go in a scratch directory (`DATA` below, about 3 GB).

```sh
python3 -m pip install -r pipeline/requirements.txt

# Positions: DE440 from https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/de440.bsp
python3 pipeline/build_ephemeris.py $DATA/de440.bsp public/data/de440.bin --start 1960-01-01 --end 2060-12-31
python3 pipeline/make_fixtures.py $DATA/de440.bsp tests/fixtures/de440-reference.json --start 1960-01-01 --end 2060-12-31 --samples 70
python3 pipeline/fetch_horizons.py tests/fixtures/horizons-reference.json

# Orientation: NAIF kernels (see the script's docstring for the file list)
python3 pipeline/build_orientation.py $DATA public/data/orientation.bin --fixtures tests/fixtures/orientation-reference.json

# Surfaces and clouds
python3 pipeline/fetch_sources.py $DATA --clouds 2026-10-05T04
python3 pipeline/build_tiles.py $DATA public/data/tiles src/generated/tiles.json   # --only earth-night,... to rebuild some layers
python3 pipeline/build_clouds.py $DATA/gmgsi_lw_2026-10-05T04.nc public/data/clouds.png src/generated/clouds.json

# Moons, asteroids, rotation models, maps, rings, the Sun, small bodies and the eclipse fixture
python3 pipeline/build_moons.py $DATA/spkcache public/data --fixtures tests/fixtures/moons-reference.json
python3 pipeline/build_rotation.py $DATA src/generated/rotation.json --fixtures tests/fixtures/rotation-reference.json
python3 pipeline/build_maps.py $DATA public/data/maps src/generated/maps.json      # --only mars,io,... to rebuild some
python3 pipeline/build_rings.py $DATA public/data/saturn-rings.json
python3 pipeline/build_sun.py 2026-09-21T15:15:00 public/data/maps/sun.jpg src/generated/sun.json
python3 pipeline/fetch_smallbodies.py public/data
python3 pipeline/fetch_eclipse.py tests/fixtures/eclipse-2027-08-02.json

# Satellites and stars
python3 pipeline/fetch_satellites.py public/data/satellites.json
python3 pipeline/build_stars.py node_modules/d3-celestial/data/stars.8.json public/data/stars.bin
```

Tiles are geographic: level L has 2^(L+1) × 2^L tiles of 180/2^L degrees. Colour tiles are 256 px JPEG; height tiles are 65 × 65 int16 grids in 0.5 m steps (the lowest bit marks water), zlib-compressed. Tiles are grouped into packs (one file per subtree) so a view needs a handful of requests.

## Data sources

- JPL DE440 planetary ephemeris (Park et al. 2021); JPL Horizons for the independent check.
- NAIF SPICE kernels: Earth orientation (ITRF93) and lunar orientation (MOON_ME, DE440).
- NASA Blue Marble: Next Generation and Black Marble 2016, MODIS land/water mask, via NASA GIBS.
- NOAA ETOPO 2022 (60 arc-second); EGM96 geoid (NGA), via the PROJ data CDN.
- NOAA GMGSI global geostationary infrared mosaic.
- Contains modified Copernicus Sentinel data 2025 (Sentinel-2 L2A, tile 12SUF, 18 Oct 2025), via Element 84's Earth Search.
- Copernicus DEM GLO-30: © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA.
- LRO LROC WAC colour and LOLA elevation, from NASA SVS's CGI Moon Kit.
- CelesTrak GP orbital elements (stations, visual, GPS).
- XHIP: An Extended Hipparcos Compilation (Anderson & Francis 2012), via the `d3-celestial` package.
- IAU WGCCRE 2015 report on cartographic coordinates and rotational elements (radii, poles, rotation), via NAIF pck00011.
- NAIF satellite ephemerides mar099, jup365, sat441, ura184, nep097, plu060 (Jacobson et al.) and JPL's sb441-n16 asteroid ephemeris.
- USGS Astrogeology global mosaics: MESSENGER MDIS (NASA/JHUAPL/CIW), Viking Orbiter, Mars Express SRC (ESA/DLR/FU Berlin), Galileo SSI and Voyager, Cassini ISS (NASA/JPL), Dawn FC (NASA/JPL, DLR), New Horizons LORRI (NASA/JHUAPL/SwRI).
- Hubble OPAL global maps of Jupiter, Saturn, Uranus and Neptune (Simon et al., MAST HLSP); Uranus and Neptune true colours from Irwin et al. 2024.
- Cassini RSS Saturn ring occultation, Rev 7 (PDS Ring-Moon Systems Node, CORSS_8001).
- SDO/HMI continuum intensitygram (NASA/SDO and the HMI science team).
- JPL Small-Body Database (asteroid and comet orbits).
- NASA eclipse predictions by Fred Espenak (eclipse.gsfc.nasa.gov) for the 2027 path test; IERS Bulletin A for UT1.
