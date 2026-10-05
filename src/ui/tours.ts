/**
 * Guided tours: a sequence of flights, each ending on a view with a caption. Distances
 * are km from the target; yaw and pitch as in the camera rig (radians); targets are
 * search names. Facts in the captions come from the data the app shows (see the HUD
 * and README for sources).
 */
export interface TourStep {
  focus: string;
  dist?: number;
  yaw?: number;
  pitch?: number;
  /** Show Sgr A* and M87* at 230 GHz (radio) or in visible light. */
  radio?: boolean;
  caption: string;
  /** Seconds to stay after arriving before moving on (default 12). */
  hold?: number;
  /** Flight time, seconds (default 6). */
  flight?: number;
}

export interface Tour {
  title: string;
  steps: TourStep[];
}

const AU = 149597870.7;
const PC = 3.0856775814913673e13;

export const TOURS: Tour[] = [
  {
    title: 'Earth to the edge of the universe',
    steps: [
      { focus: 'Earth', caption: 'Home: Earth, with clouds from the latest NOAA satellite mosaic. Everything on this tour is placed from measurements: planets from JPL’s DE440 ephemeris, stars from Gaia, galaxies from redshift surveys.' },
      { focus: 'Moon', caption: 'The Moon, mapped by NASA’s Lunar Reconnaissance Orbiter. Its light takes about 1.3 seconds to reach Earth.' },
      { focus: 'Earth', dist: 900000, caption: 'Earth and the Moon to scale: about thirty Earths would fit in the gap between them.' },
      { focus: 'Sun', dist: 9e8, pitch: 0.7, caption: 'The inner Solar System, with the asteroid belt between Mars and Jupiter (orbits from JPL’s small-body database).' },
      { focus: 'Saturn', caption: 'Saturn, 1.4 billion km from the Sun. Its main rings are about 270,000 km across, yet mostly only metres thick.' },
      { focus: 'Sun', dist: 1.2e10, pitch: 0.5, caption: 'The planets’ orbits. Neptune circles 30 times farther out than Earth; sunlight takes about four hours to reach it.' },
      { focus: 'Sun', dist: 3e14, pitch: 0.15, flight: 8, caption: 'Leaving the Solar System, the Sun shrinks to one star among many. The nearest, Proxima Centauri, is 4.2 light years away.' },
      { focus: 'Orion Nebula', flight: 8, caption: 'The Orion Nebula, a nursery of new stars about 1,300 light years away.' },
      { focus: 'Milky Way', flight: 8, caption: 'Our galaxy from outside: a barred spiral about 100,000 light years across, modelled from star counts and maser distances. The Sun is 27,000 light years from its centre.' },
      { focus: 'Andromeda Galaxy', caption: 'Andromeda, the nearest large galaxy, 2.5 million light years away and approaching us at about 110 km/s.' },
      { focus: 'Local Group', caption: 'The Local Group: the Milky Way, Andromeda, Triangulum and dozens of smaller galaxies.' },
      { focus: 'Virgo Cluster', flight: 8, caption: 'The Virgo Cluster, about 54 million light years away: more than a thousand galaxies, among them M87 with its giant black hole.' },
      { focus: 'Milky Way', dist: 2e22, pitch: 0.5, flight: 8, caption: 'Galaxies from redshift surveys trace the cosmic web: filaments and walls around vast empty voids.' },
      { focus: 'Milky Way', dist: 1e24, pitch: 0.3, flight: 8, hold: 20, caption: 'The edge of what we can see: the cosmic microwave background, light set free 380,000 years after the Big Bang from matter now 46 billion light years away.' },
    ],
  },
  {
    title: 'Journey to Sgr A*',
    steps: [
      { focus: 'Milky Way', caption: 'Our destination is the centre of the Milky Way, 27,000 light years from the Sun.' },
      { focus: 'Sgr A*', dist: 10 * PC, pitch: 0.4, radio: false, flight: 8, caption: 'Ten parsecs from the Galactic Centre. From Earth, dust dims it by about 27 magnitudes in visible light, so astronomers watch it in the infrared and radio.' },
      { focus: 'Sgr A*', dist: 10000 * AU, pitch: 0.6, radio: false, flight: 8, caption: 'The S-stars: 39 stars on orbits measured over 25 years, all circling an unseen mass of 4.3 million Suns. S2 passes within 120 AU of it every 16 years.' },
      { focus: 'Sgr A*', radio: true, flight: 8, caption: 'Sgr A* at 230 GHz, the radio light the Event Horizon Telescope sees: hot gas glowing around the black hole’s shadow. The EHT’s own image is in the corner, at the same scale as the model.' },
      { focus: 'Sgr A*', dist: 1.2e8, pitch: 0.3, radio: false, caption: 'In visible light the faint gas would not show, only the shadow against the stars. Light grazing the hole bends round it, making rings out of the stars behind.' },
      { focus: 'Sgr A*', dist: 6.3e7, pitch: 0.2, radio: false, hold: 20, caption: 'Ten gravitational radii (63 million km) out, the shadow spans more than 50 degrees of sky, and clocks here run about 10% slower than far away.' },
    ],
  },
  {
    title: 'Black holes of the Milky Way',
    steps: [
      { focus: 'Gaia BH1', caption: 'Gaia BH1, the nearest black hole known: 1,560 light years away and 9.6 times the Sun’s mass, found from the wobble of a Sun-like star that circles it every 186 days.' },
      { focus: 'Gaia BH2', caption: 'Gaia BH2: 8.9 Suns, with a red giant companion on a three-and-a-half year orbit, 3,800 light years away.' },
      { focus: 'Gaia BH3', caption: 'Gaia BH3: 33 Suns, the most massive stellar black hole known in our galaxy, 1,900 light years away. Its companion is an ancient giant star poor in metals.' },
      { focus: 'Cygnus X-1', caption: 'Cygnus X-1: 21 Suns, pulling gas from a blue supergiant into a disc hot enough to shine in X-rays. It was the first object widely accepted as a black hole.' },
      { focus: 'Sgr A*', radio: true, flight: 8, caption: 'Sgr A*, the 4.3 million solar mass black hole at the centre of the Milky Way, at 230 GHz.' },
      { focus: 'M87*', radio: true, flight: 8, hold: 20, caption: 'Beyond our galaxy: M87*, about 6 billion Suns, 53 million light years away. In 2019 it became the first black hole ever imaged.' },
    ],
  },
];

/** Plays a tour: flies to each step, shows its caption, and moves on after a while. */
export class TourPlayer {
  private tour?: Tour;
  private index = 0;
  private playing = true;
  private arrived?: number;
  private started = 0;
  private readonly title: HTMLElement;
  private readonly caption: HTMLElement;
  private readonly count: HTMLElement;
  private readonly play: HTMLButtonElement;

  constructor(private readonly el: HTMLElement, private readonly go: (step: TourStep) => void) {
    this.title = div('tour-title');
    this.caption = div('tour-caption');
    this.count = div('tour-count');
    const bar = div('tour-controls');
    const button = (text: string, label: string, action: () => void) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', action);
      bar.append(b);
      return b;
    };
    button('◀', 'Previous', () => this.show(this.index - 1));
    this.play = button('❚❚', 'Pause the tour', () => this.setPlaying(!this.playing));
    button('▶', 'Next', () => this.show(this.index + 1));
    bar.append(this.count);
    button('✕', 'End the tour', () => this.stop());
    el.append(this.title, this.caption, bar);
    el.hidden = true;
  }

  get active(): boolean {
    return this.tour !== undefined;
  }

  start(tour: Tour, step = 0): void {
    this.tour = tour;
    this.el.hidden = false;
    this.title.textContent = tour.title;
    this.setPlaying(true);
    this.show(step);
  }

  stop(): void {
    this.tour = undefined;
    this.el.hidden = true;
  }

  /** Call every frame: moves on once the current view has been held long enough. */
  update(now: number, flying: boolean): void {
    if (!this.tour) return;
    if (this.arrived === undefined && !flying && now - this.started > 0.5) this.arrived = now;
    const step = this.tour.steps[this.index];
    if (this.playing && this.arrived !== undefined && now - this.arrived > (step.hold ?? 12) && this.index < this.tour.steps.length - 1) {
      this.show(this.index + 1);
    }
  }

  private show(k: number): void {
    if (!this.tour) return;
    this.index = Math.max(0, Math.min(this.tour.steps.length - 1, k));
    const step = this.tour.steps[this.index];
    this.caption.textContent = step.caption;
    this.count.textContent = `${this.index + 1} / ${this.tour.steps.length}`;
    this.arrived = undefined;
    this.started = performance.now() / 1000;
    this.go(step);
  }

  private setPlaying(on: boolean): void {
    this.playing = on;
    this.play.textContent = on ? '❚❚' : '▶︎';
    this.play.title = on ? 'Pause the tour' : 'Play the tour';
    if (on) this.arrived = undefined;
  }
}

function div(className: string): HTMLElement {
  const d = document.createElement('div');
  d.className = className;
  return d;
}
