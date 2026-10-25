import type { ModelDef, PlateDef, V3 } from './model';

/** the six faces of the parallelepiped spanned by a, b, c at origin o */
function hexahedron(o: V3, a: V3, b: V3, c: V3) {
  const P = (i: number, j: number, k: number): V3 => [
    o[0] + a[0] * i + b[0] * j + c[0] * k,
    o[1] + a[1] * i + b[1] * j + c[1] * k,
    o[2] + a[2] * i + b[2] * j + c[2] * k,
  ];
  return {
    bottom: [P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0)],
    top: [P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)],
    front: [P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1)],
    back: [P(0, 1, 0), P(1, 1, 0), P(1, 1, 1), P(0, 1, 1)],
    left: [P(0, 0, 0), P(0, 1, 0), P(0, 1, 1), P(0, 0, 1)],
    right: [P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1)],
  };
}

const cube = hexahedron([0, 0, 0], [120, 0, 0], [0, 120, 0], [0, 0, 120]);
const slanted = hexahedron([0, 0, 0], [120, 0, 0], [35, 115, 0], [30, 25, 105]);

/**
 * Closed prism: a side profile in the x-z plane (no collinear points),
 * extruded along y. Gives the two profile-shaped sides plus one rectangular
 * plate per profile edge, i.e. a manifold closed-box structure.
 */
function prism(profile: [number, number][], depth: number, edgeNames: string[], sideNames: [string, string]): PlateDef[] {
  const at = ([x, z]: [number, number], y: number): V3 => [x, y, z];
  const plates: PlateDef[] = [
    { name: sideNames[0], poly: profile.map((q) => at(q, 0)) },
    { name: sideNames[1], poly: profile.map((q) => at(q, depth)) },
  ];
  profile.forEach((q, i) => {
    const r = profile[(i + 1) % profile.length];
    plates.push({ name: edgeNames[i], poly: [at(q, 0), at(r, 0), at(r, depth), at(q, depth)] });
  });
  return plates;
}

// 3D L-shape: 100 mm cells, 150 mm deep. Plates 0-1 sides, 2-7 around the profile.
const lShape = prism(
  [[0, 0], [200, 0], [200, 100], [100, 100], [100, 200], [0, 200]],
  150,
  ['Bottom', 'End', 'Ledge', 'Riser', 'Top', 'Back'],
  ['Side front', 'Side back'],
);

// Voxel chair: 100 mm voxels (back leg + backrest, seat, front leg), 300 mm wide.
const chair = prism(
  [[0, 0], [100, 0], [100, 100], [200, 100], [200, 0], [300, 0], [300, 200], [100, 200], [100, 400], [0, 400]],
  300,
  ['Back foot', 'Back leg inside', 'Seat underside', 'Front leg inside', 'Front foot', 'Front', 'Seat', 'Backrest front', 'Backrest top', 'Back'],
  ['Side left', 'Side right'],
);

// Stool, modelled upside-down as it is assembled: the top lies on the bench and
// the \u03a0-shaped front/back panels (two legs, a cavity between them) point up.
const stool = prism(
  [[0, 0], [300, 0], [300, 260], [240, 260], [240, 60], [60, 60], [60, 260], [0, 260]],
  200,
  ['Top', 'Right side', 'Right foot', 'Right leg inside', 'Underside', 'Left leg inside', 'Left foot', 'Left side'],
  ['Front panel', 'Back panel'],
);

export const MODEL_PRESETS: ModelDef[] = [
  {
    id: 'cube',
    name: 'Box',
    figure: 'Fig. 28',
    blurb: 'Six plates, all at 90°. A floor with two opposite walls makes a U shape that wobbles when struck. The planner builds a rigid corner first.',
    plates: [
      { name: 'Bottom', poly: cube.bottom },
      { name: 'Front', poly: cube.front },
      { name: 'Back', poly: cube.back },
      { name: 'Left', poly: cube.left },
      { name: 'Right', poly: cube.right },
      { name: 'Top', poly: cube.top },
    ],
    naive: [0, 1, 2, 3, 4, 5],
  },
  {
    id: 'ramp',
    name: 'Ramp',
    figure: 'Fig. 17',
    blurb: 'A wedge whose sloped plate meets the base and back at non-90° angles. Fitting it to just one plate leaves its angle unconstrained, so the planner waits until three plates hold it. The triangular side is a leaning plate: hammered edge-first onto the base, its tilted edge is a poor target, so it needs trapezoidal scaffolding.',
    plates: [
      { name: 'Base', poly: [[0, 0, 0], [140, 0, 0], [140, 120, 0], [0, 120, 0]] },
      { name: 'Slope', poly: [[140, 0, 0], [140, 120, 0], [0, 120, 90], [0, 0, 90]] },
      { name: 'Back', poly: [[0, 0, 0], [0, 120, 0], [0, 120, 90], [0, 0, 90]] },
      { name: 'Side L', poly: [[0, 0, 0], [140, 0, 0], [0, 0, 90]] },
      { name: 'Side R', poly: [[0, 120, 0], [140, 120, 0], [0, 120, 90]] },
    ],
    naive: [0, 1, 2, 3, 4],
  },

  {
    id: 'lshape',
    name: '3D L-shape',
    blurb: 'An L-shaped closed box. Its inner corner (Ledge\u2013Riser) is a concave joint, and the L-shaped sides are concave polygons that cannot go in once that corner is closed. The planner inserts both sides first, then rotates the Riser in last about the concave edge.',
    plates: lShape,
    naive: [2, 3, 4, 5, 6, 7, 0, 1],
  },
  {
    id: 'chair',
    name: 'Voxel chair',
    blurb: 'A chair built from 100 mm voxels, assembled as one closed box with three concave inner corners: under the seat and where the seat meets the backrest. The concave-polygon sides must go in before any concave corner is closed, so the planner inserts both sides first. Each concave corner is then closed by rotating one plate in about its concave edge: the Seat, the Seat underside and the Front leg inside.',
    plates: chair,
    naive: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1],
  },
  {
    id: 'stool',
    name: 'Stool',
    blurb: 'A stool, assembled upside-down. Its front and back panels are \u03a0-shaped: two legs with a big cavity between them. A panel is hammered edge-first onto the top, but the mallet can only reach the feet, and the cavity splits the impact between the two legs. The FEA fails and trapezoidal scaffolding fills the cavity.',
    plates: stool,
    // naive: build the frame around the profile first, panels last
    naive: [2, 3, 9, 8, 7, 6, 5, 4, 0, 1],
    prefer: [2, 0, 3, 9, 4, 8, 7, 6, 5, 1],
  },
  {
    id: 'slanted',
    name: 'Slanted box',
    figure: 'Fig. 18',
    blurb: 'Every joint is non-90°, so some pair has to go first with nothing to constrain it. This is a pathological case: the fallback is tapered pins, so 3+ plates can be held loosely first (Fig. 19).',
    plates: [
      { name: 'Bottom', poly: slanted.bottom },
      { name: 'Front', poly: slanted.front },
      { name: 'Left', poly: slanted.left },
      { name: 'Back', poly: slanted.back },
      { name: 'Right', poly: slanted.right },
      { name: 'Top', poly: slanted.top },
    ],
    naive: [0, 1, 3, 2, 4, 5],
  },
];
