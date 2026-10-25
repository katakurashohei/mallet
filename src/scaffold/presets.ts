import type { PlateSpec } from './analyze';
import type { Pt } from './geom';

const box = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

export const PLATE_PRESETS: PlateSpec[] = [
  {
    id: 'plain',
    name: 'Plain panel',
    blurb: 'A plain rectangle. The top edge is wide, flat and centred over the joint, so no scaffolding is needed.',
    issues: [],
    L: 120, pins: 4,
    outline: box(0, 0, 120, 70),
    holes: [],
  },

  {
    id: 'leaning',
    name: 'Leaning plate',
    figure: 'Fig. 2b / 5',
    blurb: 'The plate leans away from its joint, so there is no flat target above the pins. A strike here is angled and off-centre, so it misses the far pins.',
    issues: [2, 3],
    L: 100, pins: 4,
    outline: [[0, 0], [100, 0], [165, 70], [135, 95], [70, 60]],
    holes: [],
  },
  {
    id: 'spire',
    name: 'Small target',
    figure: 'Fig. 7',
    blurb: 'The only good target is a 4 mm stub. The mallet’s force is concentrated on a tiny area, so the stub dents or delaminates.',
    issues: [1],
    L: 80, pins: 3,
    outline: [[0, 0], [80, 0], [80, 25], [42, 62], [42, 74], [38, 74], [38, 62], [0, 25]],
    holes: [],
  },
  {
    id: 'long',
    name: 'Long joint',
    figure: 'Fig. 10',
    blurb: 'A 300 mm joint with 10 pins. One strike bends the plate before the impact reaches the outer pins, so it needs several targets.',
    issues: [4],
    L: 300, pins: 10,
    outline: box(0, 0, 300, 45),
    holes: [],
  },
  {
    id: 'cavity',
    name: 'Cavity',
    figure: 'Fig. 12a',
    blurb: 'A C-shaped plate. Its cavity cuts the direct path from the top to the joint, so a strike on the top arm goes the long way round through the thin spine and bends the plate apart.',
    issues: [5],
    L: 120, pins: 4,
    outline: [[0, 0], [120, 0], [120, 16], [26, 16], [26, 66], [120, 66], [120, 82], [0, 82]],
    holes: [],
  },

  {
    id: 'cutouts',
    name: 'Many cutouts',
    figure: 'Fig. 12c',
    blurb: 'Decorative cutouts weaken the path to the pins. The scaffolding also fills the holes, so it comes off as a single piece.',
    issues: [5],
    L: 120, pins: 4,
    outline: box(0, 0, 120, 90),
    holes: [0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((c) => box(8 + c * 27, 14 + r * 24, 31 + c * 27, 34 + r * 24))),
  },

];
