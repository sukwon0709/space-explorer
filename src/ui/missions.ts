/**
 * Spacecraft to ride along with. Trajectories are the navigation teams' own, as JPL
 * Horizons serves them (pipeline/fetch_missions.py); everything below is what to call
 * them, what they look like and which bodies their flybys and arrivals are computed for
 * (scripts/build-missions.mjs). Shapes are drawn from published dimensions, simplified.
 */

export type CraftModel = 'voyager' | 'pioneer' | 'galileo' | 'cassini' | 'newhorizons' | 'juno' | 'rosetta' | 'parker' | 'osirisrex' | 'orion' | 'juice' | 'lucy' | 'near' | 'deepimpact' | 'hayabusa2' | 'dart';

export interface Mission {
  slug: string;
  name: string;
  /** NAIF id in Horizons. */
  naif: number;
  model: CraftModel;
  /** Trail colour. */
  color: string;
  /** One line shown when the mission starts. */
  summary: string;
  /**
   * Bodies whose closest approaches become moments: NAIF id and how close counts
   * (km from the centre). Planets are found by their system barycentre's moons file.
   */
  encounters: Array<[number, number]>;
  /**
   * Small bodies the mission stays with or passes (their shape models load with it):
   * the trajectory is relative to them there (pipeline/fetch_missions.py VISITS).
   */
  visits?: number[];
  /** Moments the data cannot find by distance alone (UTC, title). */
  extra?: Array<[string, string]>;
  /** Trajectory after this date (UTC) is the team's prediction. */
  predictedAfter?: string;
}

const AU = 149597870.7;

/** Planets count from inside their sphere of influence; big moons from 100,000 km. */
const PLANETS: Array<[number, number]> = [[199, 0.05 * AU], [299, 0.03 * AU], [399, 1e6], [499, 0.02 * AU], [599, 0.35 * AU], [699, 0.35 * AU], [799, 0.3 * AU], [899, 0.5 * AU], [999, 0.1 * AU]];
const planets = (...ids: number[]) => PLANETS.filter(([id]) => ids.includes(id));
const moons = (within: number, ...ids: number[]): Array<[number, number]> => ids.map((id) => [id, within]);

export const MISSIONS: Mission[] = [
  {
    slug: 'voyager-1', name: 'Voyager 1', naif: -31, model: 'voyager', color: '#7fc8ff',
    summary: 'Launched 5 September 1977. Jupiter and Saturn, then out of the planets’ plane; the most distant human-made object.',
    encounters: [...planets(599, 699), ...moons(500000, 501, 502, 503, 504), ...moons(100000, 606)],
    extra: [['1990-02-14T04:48:00Z', 'The Pale Blue Dot: Voyager 1 photographs Earth from 6 billion km'], ['2012-08-25T00:00:00Z', 'Crosses the heliopause into interstellar space']],
  },
  {
    slug: 'voyager-2', name: 'Voyager 2', naif: -32, model: 'voyager', color: '#9fe0b0',
    summary: 'Launched 20 August 1977. The grand tour: Jupiter, Saturn, Uranus and Neptune, each a gravity assist to the next.',
    encounters: [...planets(599, 699, 799, 899), ...moons(500000, 501, 502, 503, 504), ...moons(300000, 606, 705), ...moons(100000, 801)],
    extra: [['2018-11-05T00:00:00Z', 'Crosses the heliopause into interstellar space']],
  },
  {
    slug: 'pioneer-10', name: 'Pioneer 10', naif: -23, model: 'pioneer', color: '#ffd27f',
    summary: 'Launched 3 March 1972. First through the asteroid belt and first to Jupiter; contact was lost in 2003.',
    encounters: [...planets(599)],
    extra: [['2003-01-23T00:00:00Z', 'Last signal received from Pioneer 10, 12 billion km out']],
  },
  {
    slug: 'pioneer-11', name: 'Pioneer 11', naif: -24, model: 'pioneer', color: '#ffb07f',
    summary: 'Launched 6 April 1973. Swung close under Jupiter’s south pole and on to the first visit to Saturn.',
    encounters: [...planets(599, 699)],
  },
  {
    slug: 'galileo', name: 'Galileo', naif: -77, model: 'galileo', color: '#c7a6ff',
    summary: 'Launched 18 October 1989. Venus once and Earth twice to reach Jupiter, then eight years in orbit among its moons.',
    encounters: [...planets(299, 399, 599), ...moons(50000, 501, 502, 503, 504), [301, 1e6]],
    extra: [['1995-12-07T22:04:00Z', 'The probe enters Jupiter’s atmosphere'], ['2003-09-21T18:57:00Z', 'Galileo plunges into Jupiter']],
  },
  {
    slug: 'cassini', name: 'Cassini', naif: -82, model: 'cassini', color: '#ffe08a',
    summary: 'Launched 15 October 1997. Venus twice, Earth and Jupiter on the way; 13 years orbiting Saturn; the Grand Finale.',
    encounters: [...planets(299, 399, 599, 699), ...moons(30000, 606), ...moons(5000, 602, 603, 604, 605, 608, 609), [301, 1e6]],
    extra: [['2005-01-14T11:38:00Z', 'Huygens lands on Titan'], ['2017-09-15T10:31:00Z', 'Cassini enters Saturn’s atmosphere']],
  },
  {
    slug: 'new-horizons', name: 'New Horizons', naif: -98, model: 'newhorizons', color: '#ff9f9f',
    summary: 'Launched 19 January 2006, the fastest launch ever. Jupiter’s gravity flung it to Pluto in nine and a half years.',
    encounters: [...planets(599, 999), ...moons(100000, 901), [2486958, 100000]],
    visits: [2486958],
  },
  {
    slug: 'juno', name: 'Juno', naif: -61, model: 'juno', color: '#8fe3ff',
    summary: 'Launched 5 August 2011. An Earth flyby for speed, then polar orbits of Jupiter skimming 4,000 km above the clouds.',
    encounters: [...planets(399, 599), ...moons(100000, 501, 502, 503)],
    predictedAfter: '2026-09-23T00:00:00Z',
  },
  {
    slug: 'rosetta', name: 'Rosetta', naif: -226, model: 'rosetta', color: '#b8f08a',
    summary: 'Launched 2 March 2004. Earth three times and Mars once to catch comet 67P/Churyumov–Gerasimenko, then two years beside it.',
    encounters: [...planets(399, 499), [2002867, 100000], [2000021, 100000]],
    visits: [2002867, 2000021, 1000012],
    extra: [['2014-08-06T09:00:00Z', 'Arrives at comet 67P'], ['2014-11-12T15:34:00Z', 'Philae lands on the comet'], ['2016-09-30T10:39:00Z', 'Rosetta touches down on the comet']],
  },
  {
    slug: 'parker-solar-probe', name: 'Parker Solar Probe', naif: -96, model: 'parker', color: '#ffb35c',
    summary: 'Launched 12 August 2018. Seven Venus flybys shrink its orbit until it passes 6.1 million km above the Sun at 190 km/s.',
    encounters: [...planets(299), [10, 0.2 * AU]],
    predictedAfter: '2026-09-30T00:00:00Z',
  },
  {
    slug: 'osiris-rex', name: 'OSIRIS-REx', naif: -64, model: 'osirisrex', color: '#a0b4ff',
    summary: 'Launched 8 September 2016. To asteroid Bennu for a sample, back to Earth in 2023, and on to Apophis as OSIRIS-APEX.',
    encounters: [...planets(399)],
    visits: [2101955],
    extra: [['2018-12-03T17:00:00Z', 'Arrives at asteroid Bennu'], ['2020-10-20T22:08:00Z', 'Touches Bennu and collects its sample'], ['2021-05-10T20:23:00Z', 'Leaves Bennu for Earth'], ['2023-09-24T14:52:00Z', 'The sample capsule lands in Utah']],
    predictedAfter: '2025-09-08T00:00:00Z',
  },
  {
    slug: 'artemis-1', name: 'Artemis I', naif: -1023, model: 'orion', color: '#ff8f7f',
    summary: 'Launched 16 November 2022. Orion, uncrewed, swings 130 km over the Moon into a distant retrograde orbit and back.',
    encounters: [[301, 100000], [399, 1e6]],
  },
  {
    slug: 'artemis-2', name: 'Artemis II', naif: -1024, model: 'orion', color: '#ff6f8f',
    summary: 'Launched 1 April 2026. Four astronauts around the far side of the Moon and home on a free-return path.',
    encounters: [[301, 100000], [399, 1e6]],
  },
  {
    slug: 'juice', name: 'JUICE', naif: -28, model: 'juice', color: '#9fd8ff',
    summary: 'Launched 14 April 2023. The first Moon-then-Earth double flyby, then Venus and Earth again on the way to Jupiter in 2031.',
    encounters: [...planets(299, 399), [301, 1e6]],
    predictedAfter: '2026-09-22T00:00:00Z',
  },
  {
    slug: 'lucy', name: 'Lucy', naif: -49, model: 'lucy', color: '#ffe0a0',
    summary: 'Launched 16 October 2021. Earth flybys send it to the Trojan asteroids that share Jupiter’s orbit.',
    encounters: [...planets(399), [20052246, 100000]],
    visits: [20052246],
    extra: [['2023-11-01T16:54:00Z', 'Flies past asteroid Dinkinesh and finds its moon Selam']],
    predictedAfter: '2025-09-08T00:00:00Z',
  },
  {
    slug: 'near-shoemaker', name: 'NEAR Shoemaker', naif: -93, model: 'near', color: '#ffc4e0',
    summary: 'Launched 17 February 1996. Past asteroid Mathilde to Eros: the first spacecraft to orbit an asteroid, and to land on one.',
    encounters: [...planets(399)],
    visits: [2000433],
    extra: [['1998-12-23T18:41:00Z', 'An engine burn fails; NEAR flies 3,830 km past Eros instead of stopping'], ['2000-02-14T15:33:00Z', 'Enters orbit around Eros, a year late'], ['2001-02-12T19:44:00Z', 'Touches down on Eros at 1.6 m/s, the first landing on an asteroid']],
  },
  {
    slug: 'deep-impact', name: 'Deep Impact', naif: -140, model: 'deepimpact', color: '#ffb0a0',
    summary: 'Launched 12 January 2005. Fired a 370 kg impactor into comet Tempel 1 and watched the crater-forming blast from 500 km.',
    encounters: [[1000093, 100000]],
    visits: [1000093],
    extra: [['2005-07-03T06:00:00Z', 'Releases the impactor toward Tempel 1'], ['2005-07-04T05:44:58Z', 'The impactor strikes Tempel 1 at 10.3 km/s']],
  },
  {
    slug: 'hayabusa2', name: 'Hayabusa2', naif: -37, model: 'hayabusa2', color: '#a8ffd8',
    summary: 'Launched 3 December 2014. A year and a half at asteroid Ryugu: rovers, a crater it made itself, two touchdowns for samples, home in 2020.',
    encounters: [...planets(399)],
    visits: [2162173],
    extra: [['2018-06-27T00:35:00Z', 'Arrives at Ryugu, 20 km above it'], ['2018-09-21T04:06:00Z', 'Drops the MINERVA-II1 rovers, the first to hop on an asteroid'], ['2018-10-03T01:57:00Z', 'Releases the MASCOT lander'], ['2019-02-21T22:29:00Z', 'First touchdown: a bullet fired into the ground, sample collected'], ['2019-04-05T02:06:00Z', 'Fires a 2 kg copper projectile into Ryugu to dig a crater'], ['2019-07-11T01:06:00Z', 'Second touchdown, beside the new crater'], ['2019-11-13T01:05:00Z', 'Leaves Ryugu for Earth'], ['2020-12-05T17:30:00Z', 'The sample capsule lands in Woomera, Australia']],
  },
  {
    slug: 'dart', name: 'DART', naif: -135, model: 'dart', color: '#ffdf70',
    summary: 'Launched 24 November 2021. Steered itself into Dimorphos, the moon of asteroid Didymos, to see if an impact could move an asteroid.',
    encounters: [],
    visits: [120065803, 2065803],
    extra: [['2022-09-11T23:14:00Z', 'Releases LICIACube to film the impact'], ['2022-09-26T23:14:24Z', 'Strikes Dimorphos at 6.1 km/s, shortening its orbit by 33 minutes']],
  },
];
