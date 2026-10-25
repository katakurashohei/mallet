// Issues 6-10: constrain-before-insertion. Search the lattice of assembly
// states (sets of plates) with Dijkstra; every step costs 1 plus penalties for
// the issues it is subject to (paper, "Algorithm: Searching the Space of
// Assembly Sequences").
import { Model, V3, commonDirection, removalCone, cross, len, norm, sub } from './model';

export interface Weights {
  angle: number; // 6: unconstrained non-90° joint
  concave: number; // 9: concave joint closed while still unconstrained
  unstable: number; // 10: striking into a non-rigid assembly that P joins at several joints
  unstableVise: number; // 10: non-rigid assembly, but a vise can hold the one plate P goes into
  rotary: number; // rotary insertion (needs the sweep carved out of A)
}

export const DEFAULT_WEIGHTS: Weights = { angle: 10, concave: 14, unstable: 8, unstableVise: 2, rotary: 3 };

export type IssueTag = 'angle' | 'concave' | 'unstable' | 'rotary' | 'align';

export interface StepIssue {
  tag: IssueTag;
  issue: number;
  cost: number;
  text: string;
  fix: string;
}

export interface Step {
  plate: number;
  from: number; // mask before
  to: number;
  neighbors: number[];
  joints: number[];
  dir: V3 | null; // insertion (strike) direction; null => rotary
  rotary: boolean;
  /** joint to pivot about for rotary insertion */
  pivot?: number;
  cost: number;
  issues: StepIssue[];
}

export interface Plan {
  steps: Step[];
  cost: number;
  feasible: boolean;
}

const popcount = (m: number) => {
  let c = 0;
  while (m) { m &= m - 1; c++; }
  return c;
};

function jointsTo(model: Model, p: number, mask: number) {
  return model.adj[p].map((k) => model.joints[k]).filter((j) => mask & (1 << (j.a === p ? j.b : j.a)));
}

/** all joint edges between plate p and the plates in mask are parallel */
function allParallel(model: Model, p: number, mask: number): boolean {
  const js = jointsTo(model, p, mask);
  return js.every((j) => len(cross(js[0].dir, j.dir)) < 0.05);
}

/**
 * all joint edges lie on one line => p can still swing about it. (Two parallel
 * but separate edges hold p, as long as what they attach to is rigid; that
 * part is checked by isUnstable.)
 */
function hingedOnOneLine(model: Model, p: number, mask: number): boolean {
  const js = jointsTo(model, p, mask);
  if (!allParallel(model, p, mask)) return false;
  const o = js[0].e0, d = js[0].dir;
  return js.every((j) => len(cross(sub(j.e0, o), d)) < 1 && len(cross(sub(j.e1, o), d)) < 1);
}

/** a plate whose joints are all parallel can rotate about them: A is a mechanism */
export function isUnstable(model: Model, mask: number): boolean {
  if (popcount(mask) < 3) return false;
  for (let p = 0; p < model.plates.length; p++) if (mask & (1 << p) && allParallel(model, p, mask)) return true;
  return false;
}

/** cost and description of adding plate p to the assembly `mask` (null: impossible) */
export function stepFor(model: Model, mask: number, p: number, W: Weights): Step | null {
  const to = mask | (1 << p);
  if (mask === 0) return { plate: p, from: 0, to, neighbors: [], joints: [], dir: null, rotary: false, cost: 0, issues: [] };
  const joints = model.adj[p].filter((k) => {
    const j = model.joints[k];
    return mask & (1 << (j.a === p ? j.b : j.a));
  });
  if (joints.length === 0) return null; // must attach to the assembly
  // A concave-polygon plate (e.g. an L-shaped side) wraps around the concave
  // corner with its notch; once both plates of that concave joint are in, it
  // can no longer be inserted.
  if (model.nonConvex[p]) {
    const nb = new Set(model.adj[p].map((k) => (model.joints[k].a === p ? model.joints[k].b : model.joints[k].a)));
    const closed = model.joints.some(
      (j) => j.concave && j.kind === 'box' && nb.has(j.a) && nb.has(j.b) && mask & (1 << j.a) && mask & (1 << j.b),
    );
    if (closed) return null;
  }
  const neighbors = joints.map((k) => (model.joints[k].a === p ? model.joints[k].b : model.joints[k].a));
  const removal = commonDirection(joints.map((k) => removalCone(model.joints[k], p)));
  const issues: StepIssue[] = [];
  let rotary = false;
  let pivot: number | undefined;
  if (!removal) {
    // No translation works: rotate P in about its concave edge, closing onto
    // the remaining joints; the pins' sweep is carved out of A (Figs. 25-26).
    // P can only swing about one concave edge: closing two or more concave
    // joints in the same step cannot be done by rotation.
    if (joints.filter((k) => model.joints[k].concave).length >= 2) return null;
    rotary = true;
    // P swings about its concave edge and then closes onto the other joint
    pivot = joints.find((k) => model.joints[k].concave) ?? joints[0];
    // rotary insertion is meant to come last (paper: delay the concave joint
    // until the rest is in place), so every plate still missing costs extra
    const remaining = model.plates.length - popcount(to);
    issues.push({
      tag: 'rotary', issue: 9, cost: W.rotary + 0.5 * remaining,
      text: 'Interlocked: no straight insertion. P is rotated into place',
      fix: 'Carve the pins’ circular sweep (r = √(t²+d²)) out of A (Fig. 26)',
    });
  }
  const loose = hingedOnOneLine(model, p, mask);
  if (loose) {
    const nonRight = joints.filter((k) => !model.joints[k].right);
    if (nonRight.length)
      issues.push({
        tag: 'angle', issue: 6, cost: W.angle,
        text: `Non-90° joint (${model.joints[nonRight[0]].angle.toFixed(0)}°) set by hand with nothing to constrain it`,
        fix: 'Tapered pins on A let plates be held loosely until 3+ plates constrain each other (Fig. 19)',
      });
    const concave = joints.filter((k) => model.joints[k].concave);
    if (concave.length)
      issues.push({
        tag: 'concave', issue: 9, cost: W.concave,
        text: 'Concave joint closed early: any angle error or incomplete intrusion blocks a later plate',
        fix: model.joints[concave[0]].right
          ? 'Extend into a T-joint so the 90° angle and full intrusion are easy (Fig. 23)'
          : 'Deepen the slots by 0.5 mm so it can be hammered home at the very end (Fig. 24)',
      });
  }
  if (isUnstable(model, mask)) {
    const multi = joints.length > 1;
    issues.push({
      tag: 'unstable', issue: 10, cost: multi ? W.unstable : W.unstableVise,
      text: multi
        ? 'Assembly A is not rigid yet and P goes into several plates: the impact knocks A out of shape'
        : 'Assembly A is not rigid yet: the impact may disassemble it',
      fix: multi ? 'Avoid: assemble a rigid corner first' : 'Hold the receiving plate in a vise (Fig. 27b)',
    });
  }
  if (joints.length > 1 && !rotary)
    issues.push({
      tag: 'align', issue: 7, cost: 0,
      text: `P must line up with ${joints.length} joints at once`,
      fix: 'Small tapers (0.75 × 0.4 mm) on A’s pins help align and hold P (Fig. 20)',
    });
  const cost = 1 + issues.reduce((s, i) => s + i.cost, 0);
  return { plate: p, from: mask, to, neighbors, joints, dir: removal ? norm([-removal[0], -removal[1], -removal[2]]) : null, rotary, pivot, cost, issues };
}

// ---- Dijkstra over the assembly lattice --------------------------------------

class Heap {
  private a: [number, number][] = [];
  push(x: [number, number]) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

export interface Lattice {
  /** every visited state with its best cost */
  dist: Map<number, number>;
  prev: Map<number, Step>;
  plan: Plan;
  expanded: number;
}

export function plan(model: Model, W: Weights): Lattice {
  const n = model.plates.length;
  const full = (1 << n) - 1;
  const dist = new Map<number, number>([[0, 0]]);
  const prev = new Map<number, Step>();
  const heap = new Heap();
  heap.push([0, 0]);
  let expanded = 0;
  // among equally good plans prefer the designer's order (bottom first etc.)
  const order = model.def.prefer ?? model.def.naive;
  const rank = (p: number) => Math.max(0, order.indexOf(p));
  while (heap.size) {
    const [d, m] = heap.pop()!;
    if (d > (dist.get(m) ?? Infinity)) continue;
    expanded++;
    if (m === full) break;
    for (let p = 0; p < n; p++) {
      if (m & (1 << p)) continue;
      const s = stepFor(model, m, p, W);
      if (!s) continue;
      const nd = d + s.cost + 1e-4 * rank(p) * (n - popcount(m));
      if (nd < (dist.get(s.to) ?? Infinity) - 1e-9) {
        dist.set(s.to, nd);
        prev.set(s.to, s);
        heap.push([nd, s.to]);
      }
    }
  }
  const steps: Step[] = [];
  let m = full;
  while (m && prev.has(m)) {
    const s = prev.get(m)!;
    steps.unshift(s);
    m = s.from;
  }
  const feasible = dist.has(full);
  const cost = feasible ? steps.reduce((s, x) => s + x.cost, 0) : Infinity;
  return { dist, prev, plan: { steps, cost, feasible }, expanded };
}

/** evaluate a fixed order (e.g. the naive one); stops at the first impossible step */
export function evalOrder(model: Model, order: number[], W: Weights): Plan {
  const steps: Step[] = [];
  let mask = 0, cost = 0;
  for (const p of order) {
    const s = stepFor(model, mask, p, W);
    if (!s) return { steps, cost: Infinity, feasible: false };
    steps.push(s);
    cost += s.cost;
    mask = s.to;
  }
  return { steps, cost, feasible: true };
}
