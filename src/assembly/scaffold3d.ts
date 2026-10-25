// Trapezoidal scaffolding for the 3D assembly: every in-plane insertion step is
// turned into a 2D plate (the same PlateSpec demo 01 uses), checked with the
// FEA, and, if no existing edge works, the scaffolding comes back as 3D faces.
import type { PlateSpec, Analysis, Failure } from '../scaffold/analyze';
import type { Pt } from '../scaffold/geom';
import { Model, V3, add, sub, mul, dot, norm, cross, len } from './model';
import type { Step } from './planner';

export interface Frame3 {
  O: V3; // origin: one end of the leading joint edge
  e: V3; // x axis: along the leading joint edge
  w: V3; // y axis: from the joint into the plate (opposite the strike)
}

export interface ScaffoldJob {
  key: string;
  spec: PlateSpec;
  frame: Frame3;
  /** the plate that is struck and carries the scaffolding */
  plate: number;
  /** direction of the blow */
  dir: V3;
  /** true: P rests on the bench and assembly A is hammered onto it via `plate` */
  onA: boolean;
}

/**
 * Which plate the mallet hits. If P is struck on an edge, that is P. If P could
 * only be struck on its face, turn the job over instead: P rests on the bench
 * and assembly A is hammered onto it, via the plate of A that receives P edge-on.
 */
export function strikeTarget(model: Model, step: Step): { plate: number; dir: V3; joints: number[]; onA: boolean } | null {
  if (!step.dir || step.rotary || step.joints.length === 0) return null;
  const P = model.plates[step.plate];
  if (Math.abs(dot(step.dir, P.n)) <= 0.2) return { plate: P.id, dir: step.dir, joints: step.joints, onA: false };
  let best: { plate: number; k: number; l: number } | null = null;
  for (const k of step.joints) {
    const j = model.joints[k];
    const q = j.a === P.id ? j.b : j.a;
    if (Math.abs(dot(model.plates[q].n, step.dir)) > 0.2 || Math.abs(dot(j.dir, step.dir)) > 0.1) continue;
    const l = len(sub(j.e1, j.e0));
    if (!best || l > best.l) best = { plate: q, k, l };
  }
  if (!best) return null;
  return { plate: best.plate, dir: mul(step.dir, -1), joints: [best.k], onA: true };
}

export interface Scaffold3D {
  needed: boolean;
  /** the plate fails because of a long joint (issue 4) */
  longJoint: boolean;
  /** scaffolding exists but is hidden by the user (long-joint toggle) */
  hidden?: boolean;
  polys: V3[][];
  tabs: V3[];
  fails: Failure[];
}

const to3 = (f: Frame3, [x, y]: Pt): V3 => add(f.O, add(mul(f.e, x), mul(f.w, y)));

function area2(pts: Pt[]) {
  let a = 0;
  pts.forEach(([x0, y0], i) => {
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  });
  return a / 2;
}

/**
 * The FEA job for one step, or null when no plate can be struck edge-on
 * (rotary insertions get no scaffolding).
 */
export function scaffoldJob(model: Model, step: Step): ScaffoldJob | null {
  const target = strikeTarget(model, step);
  if (!target) return null;
  const P = model.plates[target.plate];
  const dir = target.dir;
  // leading joint: an edge across the strike direction, furthest forward
  const across = target.joints.map((k) => model.joints[k]).filter((j) => Math.abs(dot(j.dir, dir)) < 0.1);
  if (!across.length) return null;
  const ahead = (j: (typeof across)[0]) => dot(mul(add(j.e0, j.e1), 0.5), dir);
  const lead = across.reduce((a, b) => (ahead(b) > ahead(a) ? b : a));

  let e = norm(sub(lead.e1, lead.e0));
  let O = lead.e0;
  let w = mul(dir, -1);
  w = norm(sub(sub(w, mul(e, dot(w, e))), mul(P.n, dot(w, P.n))));
  const project = (O_: V3, e_: V3) => P.poly.map((q): Pt => [dot(sub(q, O_), e_), dot(sub(q, O_), w)]);
  let pts = project(O, e);
  if (area2(pts) < 0) {
    // mirror so the outline runs counter-clockwise with the joint along +x
    e = mul(e, -1);
    O = lead.e1;
    pts = project(O, e);
  }
  const L = len(sub(lead.e1, lead.e0));
  const start = pts.findIndex(([x, y]) => Math.hypot(x, y) < 0.5);
  if (start < 0) return null;
  const outline = [...pts.slice(start), ...pts.slice(0, start)].map(([x, y]): Pt => [
    Math.round(x * 100) / 100,
    Math.round(y * 100) / 100,
  ]);
  if (Math.hypot(outline[1][0] - L, outline[1][1]) > 0.5) return null;
  if (outline.some(([, y]) => y < -0.5)) return null; // plate must lie behind its leading edge
  const pins = Math.max(2, Math.round((L / 22 - 1) / 2));
  const key = `${model.def.id}|${P.id}|${dir.map((v) => v.toFixed(2)).join(',')}`;
  return {
    key,
    plate: P.id,
    dir,
    onA: target.onA,
    frame: { O, e, w },
    spec: { id: key, name: P.name, blurb: '', issues: [], L, pins, outline, holes: [] },
  };
}

export function toScaffold3D(job: ScaffoldJob, a: Analysis): Scaffold3D {
  const needed = !a.base.strike.ok && !!a.scaffold;
  // long joints (issue 4) can be hidden in the 3D demo, see AssemblyPlanner
  const longJoint = a.base.strike.fails.some((f) => f.issue === 4);
  if (!needed) return { needed: false, longJoint, polys: [], tabs: [], fails: a.base.strike.fails };
  const polys = a.scaffold!.pieces.map((poly) => {
    const ring = poly[0];
    const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
    return open.map((p) => to3(job.frame, p));
  });
  return { needed, longJoint, polys, tabs: a.scaffold!.tabs.map((p) => to3(job.frame, p)), fails: a.base.strike.fails };
}

/** normal of a planar 3D polygon (Newell's method) */
export function polyNormal(poly: V3[]): V3 {
  let n: V3 = [0, 0, 0];
  for (let i = 0; i < poly.length; i++) n = add(n, cross(poly[i], poly[(i + 1) % poly.length]));
  return norm(n);
}
