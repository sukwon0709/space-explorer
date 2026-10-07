# Space Explorer

A real-time 3D simulator for travelling from Earth through the Solar System and out to distant galaxies, with every object placed and drawn from real observational data. It runs in the browser (TypeScript + three.js).

The full plan, including the roadmap, lives in the [design doc](https://claude.ai/code/artifact/c235450b-21cd-41a8-bc4b-b69ca4239c84).

## Flight mode (this code)

Besides picking a name and flying there, you can now pilot a ship yourself. `Pilot a ship` (top right, or `?fly=1`) hands you the controls where the camera is; `Leave the ship` (or Esc) gives the camera back.

- **Real gravity** (`src/core/gravity.ts`, `src/core/flight.ts`). Every body with a known mass pulls on the ship: the Sun, planets, Moon and Pluto always, a planet's moons and the four big asteroids within 0.3 AU, the named stars within 0.05 pc (masses from their size and temperature), and the black holes within 10 pc. Masses are the DE440 and JPL satellite ephemeris values. Near a black hole the pull follows the Paczyński–Wiita potential, so it grows faster than Newton's near the horizon, and crossing the horizon loses the ship (a new one appears 30 GM/c² out).
- **Exact anywhere.** The ship's position and velocity are kept relative to whatever dominates where it is (the smallest sphere of influence it is in, else the nearest star or black hole, else the galaxy it is in), and that object's own acceleration comes from the ephemeris. So orbits close to a moon and drifts between galaxies are both computed without rounding. Gravity is integrated with velocity Verlet in steps short against the quickest orbit nearby.
- **Engines and flight assist.** W/S thrust forward and back, A/D sideways, R/F up and down; drag or the arrow keys turn, Q/E roll. The wheel sets engine power (0.01 g to 10,000 g, 10 g to start), and Shift multiplies it by thirty. With flight assist on (Z toggles it), the ship stops turning and drifting when you let go, as hard as the engines allow. Gravity still wins: hovering near Earth with flight assist you sink at about 12 m/s until you push up. With it off, the ship coasts and falls freely, so orbits work: the display shows the orbit's low and high points, or that you are falling back or escaping. Near a turning body, "still" means still over the ground. Close to light speed, the engines push less (special relativity) and the display shows how much slower time runs on board.
- **Landing.** The ship stands on the ground instead of passing through it: Earth and Moon terrain, and the 1 bar level of the giant planets.
- **Warp drive.** X engages it and it runs as fast as it safely can, up to 10^16 times light speed, reaching light years per second within eight seconds from 130 AU out; W/S trim it slower or faster, and X again stops. It slows itself near anything ahead (it can cover the distance to it in about a second, never less than the distance) and drops out one radius above a planet or moon, 10 radii from a star, 15 solar radii from the Sun, 25 GM/c² from a black hole. Galaxies slow it but never stop it. It won't start pointed at a body you are already that close to. Out of warp, the ship is at rest relative to where it arrived.
- **Destinations.** In the ship, picking a name (search, the planet buttons, or a label) sets a destination instead of flying there. A marker shows where it is, with the distance and how long it will take at this speed. X is the one key you need: the ship turns toward it, warps there and stops there by itself (X again stops on the way). T only turns toward it, and G jumps there straight away with the usual animated flight, then gives the controls back.
- **Phones.** Drag to turn; on-screen buttons for thrust, reverse, roll, Go (the X key), flight assist, aiming and jumping.
- **Gate:** the ship's gravity reproduces real orbits (`tests/flight.test.ts`).
  - Started where the Moon is, moving as it moves, the ship (feeling every body but the Moon) follows the Moon's DE440 path to within 0.6 km over a week. Started as the Earth-Moon barycentre, it follows DE440 around the Sun to within 14 km over 60 days.
  - The pull at each surface matches NASA's fact sheets to 1% (Earth 9.80, Moon 1.62, Jupiter 24.79, Sun 274 m/s²). A 420 km circular orbit takes 92.8 minutes, the ISS's period, and closes after one lap.
  - The warp drive carries the ship from Earth to the Moon in under 10 seconds and drops out between 0.9 and 1 lunar radius above the surface, never closer.
- `scripts/fly-check.mjs` flies the ship in headless Chromium (Earth, warp to the Moon, warp to Sirius) and prints the cockpit readouts.

New parameters: `?fly=1` starts in the ship, `&target=Moon` picks a destination, `&power=10` sets the engines (g), `&assist=0` starts with flight assist off.

### Limits

- Bodies pull as points: no oblateness (Earth's J2), so low orbits don't precess as real ones do. There is no atmosphere, so no drag or re-entry heating.
- Stars' masses are estimated from a main-sequence mass-luminosity relation, which overestimates giants. Galaxies and the S-stars do not pull on the ship.
- The warp drive is fiction, made to feel like Elite's supercruise; nothing about it is physics.

## Milestone 6: black holes and tours

- **Black holes, ray-traced in the Kerr metric** (`src/core/kerr.ts`, `src/render/blackhole.ts`). Near a black hole, every pixel's light ray is followed back from the camera along a null geodesic of the spinning (Kerr) spacetime, in Boyer-Lindquist coordinates with fourth-order Runge-Kutta steps on the photon's Hamiltonian. The camera is a zero-angular-momentum observer, so its view includes aberration and the hole's frame dragging. Rays that pass farther than 100 GM/c² are bent with the weak-field formula instead. What a ray meets decides the pixel: the horizon (black), the accretion flow, a companion star, or the sky it came from, looked up in a cube map of the scene drawn around the camera. The same equations run in TypeScript for the tests and in the shader. On the spin axis, where these coordinates are singular, rays are carried straight over the pole.
- **Six black holes** (`src/core/blackholes.ts`, `pipeline/fetch_blackholes.py`), each with its measured mass, distance and orientation where one is known.
  - **Sgr A\***: 4.30 million Suns at 8.277 kpc (GRAVITY 2022), with the 39 S-stars on their measured orbits (Gillessen et al. 2017; S2 from GRAVITY 2020). They move in real time and dim behind 27 magnitudes of dust from Earth.
  - **M87\***: 6.0 billion Suns (Gebhardt et al. 2011, scaled to the Virgo Cluster distance of 16.2 Mpc), spin axis along its jet (Walker et al. 2018).
  - **Gaia BH1, BH2 and BH3**, the dormant black holes Gaia found from their companions' orbits (El-Badry et al. 2023; Panuzzo et al. 2024). The companion stars orbit them in real time.
  - **Cygnus X-1**: 21.2 Suns at 2.22 kpc (Miller-Jones et al. 2021), spin 0.998, with a thin disc and its blue supergiant companion, HDE 226868.
- **Light from matter.** Cygnus X-1's disc is a Novikov-Thorne thin disc at 2% of the Eddington limit (Page and Thorne 1974 flux). Its observed colour is a blackbody at the temperature shifted by the gravitational and Doppler redshift of each point. Sgr A* and M87* show 230 GHz radio light (the `Radio 230 GHz` button, in the EHT's false colour) from a hot flow. Its emissivity profile is the one Gralla, Lupsasca and Marrone (2020) fitted to GRMHD simulations, and its intensity scales as g³. In visible light (button off) their faint flows do not show, only the shadow against the stars.
- **Compared with the EHT.** Beside Sgr A* and M87*, a panel shows the EHT image (credit EHT Collaboration, CC BY 4.0) next to the app's model of the same patch of sky, traced from Earth's direction and blurred to the EHT's 20 µas resolution, at the same scale.
- **Panel.** For each black hole the panel shows its mass, spin and their sources, its horizon size and its shadow's size from Earth. It also shows the camera's distance in GM/c² and how fast clocks run there compared with far away.
- **Guided tours** (`src/ui/tours.ts`): *Earth to the edge of the universe* (14 stops), *Journey to Sgr A\** and *Black holes of the Milky Way*. Start one from the `Tours…` menu. Each stop has a caption, and the tour moves on by itself; it can be paused, stepped back and forward, or ended. `?tour=2&step=4` opens a tour at a stop.
- **Laptops and phones.** The drawing resolution follows the frame rate. It drops when frames take over 1/30 s, as the ray-traced views can on a laptop, and recovers when there is room. Phones and tablets (or `?quality=low`) draw one pixel per CSS pixel, load fewer faint stars and trace with longer steps. Touch screens pinch to zoom and turn with two fingers. On narrow screens the panel folds to three lines (tap to open it). `?stats=1` shows the frame rate.
- **Gate:** the shadow and the ring match theory and the EHT (`tests/blackholes.test.ts`).
  - Rays traced from a distant camera are captured inside, and escape outside, Bardeen's (1973) analytic shadow edge scaled by ±0.1%. This holds for spins 0, 0.9 and 0.99 seen from 17° to 90°.
  - The modelled 230 GHz images, blurred to the EHT's resolution and measured the way the EHT measures ring diameters, give 54.9 µas for Sgr A* (EHT: 51.8 ± 2.3) and 38.1 µas for M87* (EHT: 42 ± 3). The test requires 2σ.
  - The angular gravitational radii are 5.12 µas for Sgr A* (EHT: 4.8 +1.4/−0.7) and 3.64 µas for M87* (EHT: 3.8 ± 0.4).
  - S2's orbit weighs Sgr A* to within 2% of the mass used, and every companion keeps its published periastron, apastron and period.

New targets: `?focus=Sgr%20A*`, `M87*`, `Gaia BH1`, `Gaia BH2`, `Gaia BH3`, `Cygnus X-1`. `radio=0` shows Sgr A* and M87* in visible light. For example, the S-stars are `?focus=Sgr%20A*&dist=1.5e12&pitch=0.6&radio=0`.

### Limits

- The spins of Sgr A* and M87* and the tilt of Sgr A* are assumptions within the EHT's favoured ranges. The Gaia black holes' spins are unknown and drawn as zero. Cygnus X-1's disc is assumed to lie in its orbital plane.
- The hot flows are a time-averaged emissivity profile, not a simulation: they have no turbulence, flares or jet, and are shown only at 230 GHz. The thin disc is opaque and geometrically flat, with no corona or wind.
- Stars in the background are drawn as small discs, so lensing stretches them into short arcs where a true point would only brighten. Near the poles, rays are moved up to 1% of their radius sideways.
- The Galactic Centre's nuclear star cluster has only its S-stars and the catalogue stars; the millions of fainter stars around it are missing.

## Milestone 5: the Milky Way and beyond

- **The Milky Way's glow, from inside and out** (`src/core/milkyway.ts`, `src/render/milkyway.ts`). The diffuse light is not a photograph: it is ray-marched through a model of the Galaxy every frame, so it is right from anywhere. The model has thin and thick discs, the boxy bulge and long bar (Dwek G2 shapes, bar at 28°), and spiral arms traced from masers (Reid et al. 2019, extrapolated on the far side). The Sun sits 8.277 kpc from the centre (GRAVITY 2022), 20.8 pc above the plane (Bennett and Bovy 2019). The disc is normalised to the local luminosity density measured from the app's own star catalogue (`pipeline/build_milkyway.py`), which gives a total M_V of -21.4. Only the light of stars fainter than those drawn is added, so the glow and the stars never double-count. Dust is the Edenhofer 3D map near the Sun and a model dust disc beyond, so the Great Rift and the dark lanes come out of the same dust that dims the stars. The view from outside is labelled as modelled.
- **156,125 galaxies, plus 834,710 more from SDSS** (`pipeline/build_galaxies.py`). Measured distances come first: the Updated Nearby Galaxy Catalog (Cepheids, the tip of the red giant branch) and Cosmicflows-4 (Tully-Fisher, fundamental plane, supernovae, surface brightness fluctuations), using Cosmicflows-4 group distances for groups with at least two members. All other galaxies (2MRS, 6dFGS, SDSS) are placed by their CMB-frame redshift in flat ΛCDM with H0 = 74.6 (the Cosmicflows-4 scale). Redshift-only galaxies in the cores of the big clusters are placed at the cluster's distance, so the clusters are not stretched into "fingers of God". Each galaxy has its measured size, shape, orientation, colour and Milky Way extinction (SFD). Nearby ones are drawn as inclined discs or spheroids with their light spread to their true surface brightness; distant ones are points. 139 globular clusters (Harris 2010) are included.
- **The nearest galaxies in 3D** (`pipeline/build_galaxy_models.py`, `src/render/galaxymodels.ts`). 60 galaxies, Andromeda, Triangulum, the Magellanic Clouds, the Whirlpool, the Sombrero and others, are volumes you can fly around and through, ray-marched on the GPU. Each is built from a survey image: SDSS DR9 g, r, i (linear CCD fluxes) where SDSS covers it, else the Digitized Sky Survey 2 red and blue plates, linearised. Foreground stars are removed using Gaia DR3. The image is split into a Sérsic bulge (fitted in 2D, deprojected to an oblate spheroid with the Prugniel–Simien profile) and a disc, which is deprojected with the galaxy's inclination into a face-on map. The disc's smooth light is in a thick sech² layer; its knots and fine structure, with the dust, in a thin one. Dust lanes come from where the image is both redder and fainter than its surroundings and are put on the near side; a smooth exponential dust disc with a hole for the bulge is added, and the disc's and bulge's light are corrected for the dimming the dust causes as seen from Earth. Edge-on galaxies get a smooth disc with their measured light and thickness. Interacting companions (NGC 5195) are fitted, taken out of their partner's picture and drawn at their own place.
- **Detail below the survey images' resolution** (`src/core/galaxystars.ts`). Up close, a survey image has no more to give (a DSS2 pixel is several parsecs at Andromeda), so the models fill in what is smaller with structure drawn from their own light. Individual giants and supergiants (5% of the light, with a power-law spread of brightness) are scattered where the face-on map puts the light; young blue stars sit in clusters along the arms, where the map's young light is, with pink HII regions around some of them; the bulge's stars follow its Sérsic profile. They are dimmed by the model's dust along the sight line. Below a pixel of the image, the dust breaks into turbulent clouds and filaments and the young light into clumps between them. All of it averages to the maps: the stars appear only once they would be a few pixels apart, the noise only once a pixel is finer than the image, and the volume gives up the light the stars carry, so from Earth (and in the gate) nothing changes. Up close the exposure is set by what fills the view rather than burning out. The Sombrero's dust lies in a ring (Bendo et al. 2006) whose radius (7.2 kpc) and depth are fitted to its image.
- **Telescope images of bright nebulae** (`pipeline/fetch_images.py`, `src/render/images.ts`). 26 nebulae use Digitized Sky Survey 2 colour images, faced to the camera as Earth sees them, with Gaia DR3 foreground stars removed. Every image and model is scaled so its total light matches the object's catalogue magnitude.
- **Nebula close-ups, real then AI-enhanced** (`pipeline/build_nebula_detail.py`, `src/render/images.ts`). Flying in to a nebula's best-known feature (the Pillars of Creation, the Horsehead, the Ring ...) swaps in two nested close-ups as the picture's pixels grow past the screen's. The first is real data at 1″ per pixel: DSS2 for the large scales, with the fine detail from the CCD H-alpha surveys of the Galactic plane (VPHAS+, IPHAS) or DECaPS / Pan-STARRS where those are clean (they over-subtract bright nebulosity, so a field with many deep negative holes is not used). Where the plates saturated (bright cores), the whole-field picture is repaired from the survey. The second is that layer upscaled 4× by Real-ESRGAN (run offline on the CPU), i.e. detail below what any survey resolves, and labelled as AI in the info panel. Each close-up is back-projected onto its parent: averaged down onto the parent's pixels it reproduces the parent (mean residual a few per cent at most for the survey layer and under 1% for the AI layer, checked by `tests/nebulae.test.ts`), so the AI only fills in between the observed pixels and never changes what was observed. The Orion Nebula and the Pleiades nebulosity have none: their cores are saturated in every survey available.
- **Galaxy clusters and the Local Group.** Search the Virgo, Fornax, Coma, Perseus, Centaurus and Hydra clusters, the Leo Triplet, the M81 and Sculptor groups and the Local Group. Labels show the brightest named galaxies in view.
- **The cosmic web.** Out among the galaxies, the exposure lengthens with the scale of the view, as a telescope's would, so the filaments and voids of the redshift surveys show.
- **The cosmic microwave background** (`pipeline/build_cmb.py`, `src/render/cmb.ts`). The Planck PR3 SMICA map is drawn in false colour (±500 µK) on the sphere of last scattering, 12,800 comoving Mpc away. It appears on its own beyond 1.5 Gpc and can be turned on from Earth with the `Microwave background` button (`cmb=1`).
- **Search and panel.** Every named galaxy, cluster and nebula is searchable. The panel shows the distance and how it was measured, the light travel time, the size and the brightness from the camera.
- **Gate:** Andromeda and the Virgo Cluster sit at their measured distances (`tests/galaxies.test.ts`, against `tests/fixtures/galaxy-reference.json`, independent of the pipeline's inputs).
- **Gate:** seen from Earth, the 3D models of the Whirlpool, Andromeda, the Sombrero, the Needle, Triangulum and M87 hold the light of the survey images they were built from (within 15%) and look like them (correlation of square-root brightness above 0.95): `tests/galaxymodels.test.ts` ray-traces each model on the CPU in the app's own frame (`src/core/galaxymodel.ts`, the shader's twin).
  - Andromeda is drawn 770 kpc away, against 761 ± 11 kpc from HST Cepheids (Li et al. 2021).
  - The Virgo Cluster is 16.2 Mpc away, against 16.5 ± 1.1 Mpc from surface brightness fluctuations (Mei et al. 2007). The Fornax Cluster is 19.7 Mpc away, against 20.0 ± 1.4 Mpc (Blakeslee et al. 2009). The LMC is 50.0 kpc away, against 49.59 ± 0.55 kpc (Pietrzyński et al. 2019).
  - Positions are within 1' of NED, and float32 rounding on the GPU stays under a pixel at 4K from Earth, from beside Andromeda and from the Virgo Cluster.

New targets: `?focus=Milky%20Way`, `Andromeda Galaxy` (or `M31`), `Local Group`, `Virgo Cluster`, `Orion Nebula`, `Sgr A*`. For example, the cosmic web is `?focus=Milky%20Way&dist=2e22&pitch=0.5`.

### Limits

- The Milky Way seen from outside is a model: its arms beyond the Galactic Centre are extrapolated, and it has no star clusters or HII regions of its own.
- A galaxy model is one image deprojected: what a disc looks like from above is inferred from one slanted view, so a steeply inclined galaxy (Andromeda is 77° from face-on) is blurred across its minor axis, and spiral structure behind the bulge is not seen. Photographic plates saturate bright cores; there the bulge's profile is bounded by the saturated pixels and the disc is carried in smoothly. From the far side of a nebula you see its picture from Earth.
- Redshift distances carry each galaxy's own motion (about 300 km/s, or 4 Mpc at H0 = 74.6), except in the cluster cores. SDSS covers only a quarter of the sky, so the deep cosmic web is one-sided.
- The CMB layer is the map we see, on our own sphere of last scattering: from elsewhere the true microwave sky would differ.

## Milestone 4: the stars

- **3.4 million stars from Gaia DR3 and Hipparcos** (`pipeline/build_stars.py`). The catalogue has every Gaia star brighter than G = 12, every star within 100 pc down to Gaia's limit, and Hipparcos (XHIP) for the bright stars Gaia saturates on. Distances are 1/parallax where the parallax is good to 20%, otherwise Bailer-Jones et al. (2021). Stars are stored at J2016.0 with their 3D space velocities, so proper motion, radial velocity and parallax all come out of one straight-line motion, as in SOFA's `pmsafe`. They live in an octree of 1,426 nodes in 53 packs (75 MB) that stream in as the camera moves, brightest first (`src/render/stars.ts`).
- **Brightness and colour from wherever you are.** Each star keeps its absolute V magnitude and temperature, so its apparent magnitude is recomputed from the camera position. Fly to another star and the sky rearranges and re-brightens correctly. Colours are blackbody colours of each star's temperature, from its dereddened Gaia BP-RP or Hipparcos B-V (Pecaut and Mamajek 2013). Bright stars spread into glare, and stars near enough to resolve are drawn as discs.
- **3D dust** (`pipeline/build_dust.py`). The Edenhofer et al. (2024) dust map out to 1,250 pc is resampled to a 256 x 256 x 80 grid. From Earth, each star carries its catalogue extinction. Away from the Sun, the shader ray-marches the grid from the camera to each star, so dust clouds dim and redden the stars behind them from any viewpoint.
- **Exoplanets.** 5,991 planets around 4,420 stars from the NASA Exoplanet Archive. Search any host (e.g. TRAPPIST-1) to fly to it and see the star at its true size and colour with its planets' orbits. The `Exoplanets` button labels every planet host in view.
- **Constellations.** The 88 IAU constellation figures (Stellarium's modern sky culture), drawn through the stars' true current positions, so they distort as you leave the Sun.
- **Named stars.** 7,809 stars with IAU names, Bayer/Flamsteed designations or planets are searchable and clickable. The panel shows the distance, magnitude from Earth and from the camera, temperature, radius and planets.
- **Gate:** the sky from Earth matches the catalogues (`tests/stars.test.ts`, against `tests/fixtures/sky-reference.json` computed independently with ERFA from the original catalogues).
  - Every Hipparcos star brighter than V = 6.5 is where Hipparcos puts it in 1960, 2026 and 2060. In 2026 the median error is 0.037", and 99% are within 0.72".
  - Gaia stars are within 9 mas of Gaia DR3.
  - Magnitudes match Hipparcos V to 0.012 mag (95%) for V < 6. They match Tycho-2 V to a median of 0.03 mag down to V = 10.5.
  - The app shows 8,720 naked-eye stars against Hipparcos's 8,726.
  - float32 rounding on the GPU stays under 25 mas from Earth, from 8 pc away and from 430 pc away.

New URL parameters: `sky=ra,dec` points the view at a sky position (degrees, celestial north up), `mlim` sets the faintest magnitude shown at a 50° field, and `constellations=1`, `names=0` and `exoplanets=1` set the layers. `focus` takes star names (`?focus=Betelgeuse`). For example, Orion from Earth is `?focus=Earth&dist=400000&sky=84,-1&fov=40&constellations=1`.

### Limits

- Gaia stars fainter than G = 12 are included only within 100 pc, so the Milky Way shows as stars, not as its diffuse glow. Faint stars far from the Sun are missing when you fly out.
- Binary and multiple stars are drawn as their catalogue entries, without orbital motion. Stars without a radial velocity move only across the sky.
- The dust map stops at 1,250 pc from the Sun, and from Earth stars beyond it get no extra extinction. Inside the box, the ray march takes 16 samples per star, so thin filaments are smoothed.
- Exoplanet orbits are drawn edge-on as seen from Earth (true for transiting planets), because most orbits' orientations are unknown.
- Nebulae are not drawn yet (added in milestone 5).

## Milestone 3: the Solar System

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
- Parts of some moons were never imaged (Triton 61% coverage, Pluto 68%, Charon 66%). Those areas show the body's average colour. Venus and Titan have no visible-light surface, so they are their cloud colour. Mimas, Hyperion, Phoebe, the Uranian moons, Deimos, Pallas and Hygiea have no map yet. Vesta's map uses the IAU 2015 prime meridian, which was not checked against the mosaic. Phobos's mosaic is lit differently on either side of 180° longitude, so its edges are cross-faded and a soft brightness step remains there.
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
npm test             # ephemeris, Horizons, orientation, rotation, moons, eclipse, satellites, jitter, time, sky, galaxy, 3D galaxy, black hole and flight tests
npm run build
npm run screenshot   # renders reference views to screenshots/ (headless Chromium)
```

## Deploy

Every push to `main` builds the app and publishes it to GitHub Pages at https://sukwon0709.github.io/space-explorer/ (`.github/workflows/deploy.yml`). The built site is about 270 MB, within Pages' 1 GB site limit, and no single file is over 20 MB. One-time setup: in the repository's Settings > Pages, set Source to "GitHub Actions". To redeploy without a push, run the workflow from the Actions tab.

To view a build locally instead: `npm run build && npm run preview` (http://localhost:4173).

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

# Satellites
python3 pipeline/fetch_satellites.py public/data/satellites.json

# Stars, dust, exoplanets and constellations, and the sky gate's reference positions
python3 pipeline/fetch_stars.py $DATA          # Gaia DR3 (ESA archive), VizieR, NASA Exoplanet Archive, Stellarium
curl -L -o $DATA/edenhofer_mean_std_healpix.fits https://zenodo.org/records/10658339/files/mean_std_healpix.fits
(cd pipeline && python3 build_dust.py $DATA ../public/data)
python3 pipeline/build_stars.py $DATA public/data --dust $DATA/dust-grid.npz
python3 pipeline/make_sky_fixtures.py $DATA tests/fixtures/sky-reference.json

# The Milky Way glow, galaxies, images and the microwave background
python3 pipeline/build_milkyway.py public/data src/generated/milkyway.json
python3 pipeline/fetch_galaxies.py $DATA       # UNGC, Cosmicflows-4, 2MRS, 6dFGS, PGC, Harris (VizieR), SDSS DR18, SFD, Planck
python3 pipeline/build_galaxies.py $DATA public/data
python3 pipeline/fetch_images.py $DATA public/data   # nebulae: DSS2 colour via CDS hips2fits, Gaia DR3 for the foreground stars
python3 pipeline/build_nebula_detail.py $DATA public/data   # nebula close-ups: VPHAS+/IPHAS/DECaPS/Pan-STARRS via hips2fits, Real-ESRGAN x4 (needs torch, CPU is fine); run after fetch_images.py
python3 pipeline/build_galaxy_models.py $DATA public/data   # 3D galaxies: SDSS DR9 / DSS2 via hips2fits, Gaia DR3; writes tests/fixtures/galaxy-models-reference.json
python3 pipeline/build_cmb.py $DATA public/data

# Black holes: the S-stars and the EHT images
python3 pipeline/fetch_blackholes.py $DATA public/data   # VizieR (Gillessen et al. 2017), ESO image archive
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
- ESA Gaia DR3 (Gaia Collaboration 2023), with distances from Bailer-Jones et al. (2021). This work has made use of data from the European Space Agency (ESA) mission Gaia, processed by the Gaia Data Processing and Analysis Consortium (DPAC).
- Hipparcos (ESA 1997) and XHIP: An Extended Hipparcos Compilation (Anderson & Francis 2012); Tycho-2 (Høg et al. 2000), via VizieR (CDS, Strasbourg). Star names via the `d3-celestial` package.
- 3D dust map of Edenhofer et al. (2024), Zenodo 10658339.
- NASA Exoplanet Archive, Planetary Systems Composite Parameters (NASA Exoplanet Science Institute, Caltech/IPAC).
- Stellarium modern sky culture constellation figures (GPL-2.0).
- Pecaut & Mamajek (2013) stellar colour and temperature table; Riello et al. (2021) Gaia-to-Johnson transformations.
- IAU WGCCRE 2015 report on cartographic coordinates and rotational elements (radii, poles, rotation), via NAIF pck00011.
- NAIF satellite ephemerides mar099, jup365, sat441, ura184, nep097, plu060 (Jacobson et al.) and JPL's sb441-n16 asteroid ephemeris.
- USGS Astrogeology global mosaics: MESSENGER MDIS (NASA/JHUAPL/CIW), Viking Orbiter, Mars Express SRC (ESA/DLR/FU Berlin), Galileo SSI and Voyager, Cassini ISS (NASA/JPL), Dawn FC (NASA/JPL, DLR), New Horizons LORRI (NASA/JHUAPL/SwRI).
- Hubble OPAL global maps of Jupiter, Saturn, Uranus and Neptune (Simon et al., MAST HLSP); Uranus and Neptune true colours from Irwin et al. 2024.
- Cassini RSS Saturn ring occultation, Rev 7 (PDS Ring-Moon Systems Node, CORSS_8001).
- SDO/HMI continuum intensitygram (NASA/SDO and the HMI science team).
- JPL Small-Body Database (asteroid and comet orbits).
- Updated Nearby Galaxy Catalog (Karachentsev et al. 2013); Cosmicflows-4 (Tully et al. 2023); 2MASS Redshift Survey (Huchra et al. 2012); 6dF Galaxy Survey (Jones et al. 2009); HyperLEDA/PGC (Paturel et al. 2003); Harris (1996, 2010 edition) globular clusters; all via VizieR (CDS, Strasbourg).
- Sloan Digital Sky Survey DR18 (SDSS-V collaboration), via SkyServer; SDSS DR9 images via CDS hips2fits. Funding for the SDSS has been provided by the Alfred P. Sloan Foundation and the participating institutions.
- Schlegel, Finkbeiner and Davis (1998) dust map, via NASA LAMBDA.
- Planck PR3 SMICA CMB map (ESA and the Planck Collaboration 2020), via CDS hips2fits.
- The Digitized Sky Surveys were produced at the Space Telescope Science Institute under U.S. Government grant NAG W-2166, from photographic data of the Palomar (POSS-II, Caltech) and UK Schmidt (Royal Observatory Edinburgh, AAO) telescopes; colour HiPS by CDS, via hips2fits.
- Milky Way structure: Reid et al. (2019) spiral arms, GRAVITY Collaboration (2022) Galactic Centre distance, Bland-Hawthorn and Gerhard (2016) review values for the discs, bulge and bar.
- Black holes: GRAVITY Collaboration (2020, 2022) for Sgr A* and S2; Gillessen et al. (2017) S-star orbits via VizieR; Gebhardt et al. (2011) and Walker et al. (2018) for M87*; El-Badry et al. (2023) for Gaia BH1 and BH2; Gaia Collaboration, Panuzzo et al. (2024) for Gaia BH3; Miller-Jones et al. (2021) and Zhao et al. (2021) for Cygnus X-1; Bardeen (1973); Page and Thorne (1974); Gralla, Lupsasca and Marrone (2020).
- Event Horizon Telescope images of M87* (2019) and Sgr A* (2022): EHT Collaboration, CC BY 4.0, via ESO (eso1907a, eso2208-eht-mwa).
- NASA eclipse predictions by Fred Espenak (eclipse.gsfc.nasa.gov) for the 2027 path test; IERS Bulletin A for UT1.
