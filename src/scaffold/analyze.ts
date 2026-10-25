// Issues 1-5: choose a target on plate P, test it with FEA, and fall back to
// (multi-)trapezoidal scaffolding. Follows Steps 1-5 of the paper's
// "Can we use existing features instead of scaffolding?" section.
import {
  Pt, Ring, MultiPoly, union, difference, intersection, rect, openRing, pointInMulti, bbox,
  distToBoundary, multiArea,
} from './geom';
import { buildMesh, buildSystem, solve, elementVonMises, Mesh, System } from './fea';

export interface PlateSpec {
  id: string;
  name: string;
  blurb: string;
  figure?: string;
  issues: number[];
  L: number; // joint length; the P-A joint runs along y = 0 from x = 0 to x = L
  pins: number;
  outline: Pt[]; // simple polygon, must contain the edge (0,0)-(L,0)
  holes: Pt[][];
}

export interface Params {
  T: number; // material thickness (= pin depth)
  E: number;
  nu: number;
  pinForce: number; // N needed to drive one tight pin home
  sigmaAllow: number; // MPa, plate body
  sigmaCrush: number; // MPa, denting / delamination at the struck target
  effMin: number;
  malletFace: number; // mm, contact width cap
  scaffoldTop: number; // mm, width of the scaffolding target (paper: ~3 cm)
  margin: number; // mm the scaffolding rises above the plate
}

export const DEFAULT_PARAMS: Params = {
  T: 6,
  E: 9000,
  nu: 0.3,
  pinForce: 150,
  sigmaAllow: 24,
  sigmaCrush: 14,
  effMin: 0.5,
  malletFace: 30,
  scaffoldTop: 30,
  margin: 8,
};

export interface Target {
  a: Pt;
  b: Pt;
  p: Pt; // centre of the contact patch
  d: Pt; // strike direction (into the material)
  width: number;
  reachable: boolean;
  r: number[]; // share of the impact reaching each pin (reaction / applied force)
  eff: number; // n * min(r), in [0, 1]
}

export interface Failure {
  issue: number;
  text: string;
}

export interface Strike {
  targets: number[];
  groups: number[][];
  eff: number;
  Freq: number;
  pressure: number;
  sigmaMax: number;
  sigmaAt: Pt | null;
  ok: boolean;
  fails: Failure[];
}

export interface StressField {
  x0: number;
  y0: number;
  h: number;
  nx: number;
  cells: Int32Array;
  vm: Float32Array;
}

export interface Stage {
  solid: MultiPoly;
  targets: Target[];
  strike: Strike;
  field: StressField;
  cells: number;
}

export interface ScaffoldResult {
  k: number;
  trapezoids: Ring[];
  pieces: MultiPoly;
  tabs: Pt[];
  stage: Stage;
  tried: { k: number; ok: boolean; eff: number }[];
}

export interface Analysis {
  plate: MultiPoly;
  pinsMP: MultiPoly;
  pinX: [number, number][];
  base: Stage;
  scaffold: ScaffoldResult | null;
  ms: number;
}

export function pinSpans(L: number, n: number): [number, number][] {
  const seg = L / (2 * n + 1);
  return Array.from({ length: n }, (_, k) => [(2 * k + 1) * seg, (2 * k + 2) * seg] as [number, number]);
}

export function plateSolid(spec: PlateSpec): MultiPoly {
  return difference([[spec.outline]], ...spec.holes.map((h) => [[h]] as MultiPoly));
}

// ---------------------------------------------------------------------------

interface Ctx {
  spec: PlateSpec;
  P: Params;
  pinX: [number, number][];
}

/** Step 1: one or more candidate targets on every exposed outline segment */
function candidateTargets(plate: MultiPoly, all: MultiPoly, ctx: Ctx): Omit<Target, 'r' | 'eff'>[] {
  const out: Omit<Target, 'r' | 'eff'>[] = [];
  for (const poly of plate)
    for (const ring of poly) {
      const o = openRing(ring);
      for (let i = 0; i < o.length; i++) {
        const a = o[i], b = o[(i + 1) % o.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1.5) continue;
        if (Math.abs(a[1]) < 1e-6 && Math.abs(b[1]) < 1e-6) continue; // the P-A joint itself
        const tx = (b[0] - a[0]) / len, ty = (b[1] - a[1]) / len;
        let d: Pt = [-ty, tx];
        const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (!pointInMulti(mid[0] + d[0] * 0.3, mid[1] + d[1] * 0.3, plate)) d = [ty, -tx];
        if (d[1] > -0.15) continue; // must push towards the joint
        const k = 2 * Math.max(0, Math.round((len / 25 - 1) / 2)) + 1; // odd, so the centre is a candidate
        const w = Math.min(len / k, ctx.P.malletFace);
        for (let s = 0; s < k; s++) {
          const c = (s + 0.5) / k;
          const p: Pt = [a[0] + (b[0] - a[0]) * c, a[1] + (b[1] - a[1]) * c];
          const pa: Pt = [p[0] - (tx * w) / 2, p[1] - (ty * w) / 2];
          const pb: Pt = [p[0] + (tx * w) / 2, p[1] + (ty * w) / 2];
          out.push({ a: pa, b: pb, p, d, width: w, reachable: reachable(p, d, [tx, ty], all) });
        }
      }
    }
  return out;
}

/** can a mallet head swing in along -d without hitting the part? */
function reachable(p: Pt, d: Pt, t: Pt, solid: MultiPoly): boolean {
  for (const off of [-9, 0, 9]) {
    for (let s = 1; s <= 55; s += 1.5) {
      const x = p[0] + t[0] * off - d[0] * s;
      const y = p[1] + t[1] * off - d[1] * s;
      if (pointInMulti(x, y, solid)) return false;
    }
  }
  return true;
}

function nearestActiveNode(mesh: Mesh, x: number, y: number): number {
  const W = mesh.nx + 1;
  const ci = Math.round((x - mesh.x0) / mesh.h), cj = Math.round((y - mesh.y0) / mesh.h);
  let best = -1, bd = Infinity;
  for (let dj = -2; dj <= 2; dj++)
    for (let di = -2; di <= 2; di++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i > mesh.nx || j > mesh.ny) continue;
      const id = mesh.nodeId[j * W + i];
      if (id < 0) continue;
      const dd = Math.hypot(mesh.nodeX[id] - x, mesh.nodeY[id] - y);
      if (dd < bd) { bd = dd; best = id; }
    }
  return best;
}

function patchNodes(mesh: Mesh, t: { a: Pt; b: Pt; width: number }): number[] {
  const set = new Set<number>();
  const steps = Math.max(2, Math.ceil(t.width / (mesh.h / 3)));
  for (let s = 0; s <= steps; s++) {
    const c = s / steps;
    const id = nearestActiveNode(mesh, t.a[0] + (t.b[0] - t.a[0]) * c, t.a[1] + (t.b[1] - t.a[1]) * c);
    if (id >= 0) set.add(id);
  }
  return [...set];
}

interface Solved {
  mesh: Mesh;
  sys: System;
  pinNodes: number[][];
  influence: Float64Array[];
}

function solveInfluence(solid: MultiPoly, ctx: Ctx): Solved {
  const mesh = buildMesh(solid, -ctx.P.T);
  const pinNodes: number[][] = ctx.pinX.map(() => []);
  for (let i = 0; i <= mesh.nx; i++) {
    const id = mesh.nodeId[i]; // row j = 0: pin tips
    if (id < 0) continue;
    const x = mesh.nodeX[id];
    const k = ctx.pinX.findIndex(([x0, x1]) => x >= x0 - mesh.h * 0.6 && x <= x1 + mesh.h * 0.6);
    if (k >= 0) pinNodes[k].push(id);
  }
  const supportDofs = pinNodes.flat().flatMap((id) => [2 * id, 2 * id + 1]);
  const sys = buildSystem(mesh, { E: ctx.P.E, nu: ctx.P.nu, t: ctx.P.T }, supportDofs);
  // Maxwell-Betti: push pin i up by a unit displacement; the displacement this
  // causes at a target tells us which share of an impact there reaches pin i.
  const influence = pinNodes.map((nodes) => {
    const rhs = new Float64Array(mesh.nNodes * 2);
    for (const id of nodes) rhs[2 * id + 1] = sys.penalty;
    return solve(sys.factor, rhs);
  });
  return { mesh, sys, pinNodes, influence };
}

function shares(S: Solved, t: { a: Pt; b: Pt; width: number; d: Pt }): number[] {
  const nodes = patchNodes(S.mesh, t);
  const w = 1 / Math.max(1, nodes.length);
  return S.influence.map((v) => {
    let s = 0;
    for (const id of nodes) s += w * (t.d[0] * v[2 * id] + t.d[1] * v[2 * id + 1]);
    return -s;
  });
}

/** the most a person can deliver with a mallet (paper: up to 4500 N) */
export const MAX_BLOW = 4500;

function strikeStress(S: Solved, targets: Target[], F: number[]) {
  const nE = S.mesh.elems.length / 4;
  const env = new Float64Array(nE);
  let sigmaMax = 0;
  let sigmaAt: Pt | null = null;
  targets.forEach((t, j) => {
    const nodes = patchNodes(S.mesh, t);
    const f = new Float64Array(S.mesh.nNodes * 2);
    for (const id of nodes) {
      f[2 * id] += (F[j] * t.d[0]) / nodes.length;
      f[2 * id + 1] += (F[j] * t.d[1]) / nodes.length;
    }
    const u = solve(S.sys.factor, f);
    const vm = elementVonMises(S.sys, u);
    const h = S.mesh.h;
    for (let e = 0; e < nE; e++) {
      env[e] = Math.max(env[e], vm[e]);
      const cell = S.mesh.elemCell[e];
      const cx = S.mesh.x0 + ((cell % S.mesh.nx) + 0.5) * h;
      const cy = S.mesh.y0 + (Math.floor(cell / S.mesh.nx) + 0.5) * h;
      // ignore the singular spots: pins, the row at the joint, the contact patch
      if (cy < 1.5 * h) continue;
      if (Math.hypot(cx - t.p[0], cy - t.p[1]) < t.width / 2 + 2.5 * h) continue;
      if (vm[e] > sigmaMax) { sigmaMax = vm[e]; sigmaAt = [cx, cy]; }
    }
  });
  const field: StressField = {
    x0: S.mesh.x0, y0: S.mesh.y0, h: S.mesh.h, nx: S.mesh.nx,
    cells: S.mesh.elemCell, vm: Float32Array.from(env),
  };
  return { sigmaMax, sigmaAt, field };
}

function evaluate(S: Solved, targets: Target[], struck: number[], groups: number[][], ctx: Ctx, plateH: number): { strike: Strike; field: StressField } {
  const { P } = ctx;
  const F: number[] = [];
  let effAll = Infinity;
  let pressure = 0;
  struck.forEach((ti, j) => {
    const t = targets[ti];
    const g = groups[j];
    const e = g.length * Math.min(...g.map((i) => t.r[i]));
    effAll = Math.min(effAll, e);
    const Fj = e > 0.02 ? (g.length * P.pinForce) / e : Infinity;
    F.push(Fj);
    pressure = Math.max(pressure, Math.min(Fj, MAX_BLOW) / (t.width * P.T));
  });
  // stresses under the blow the user would actually deliver (capped at a full-force blow)
  const applied = F.map((f) => Math.min(f, MAX_BLOW));
  const { sigmaMax, sigmaAt, field } = strikeStress(S, struck.map((i) => targets[i]), applied);
  const fails: Failure[] = [];
  const t0 = targets[struck[0]];
  const tilt = (Math.acos(Math.min(1, -t0.d[1])) * 180) / Math.PI;
  if (effAll < P.effMin) {
    if (ctx.spec.L >= 3 * plateH && ctx.spec.L >= 180)
      fails.push({ issue: 4, text: `Long joint: one target delivers only ${pct(effAll)} to the farthest pin` });
    else if (ctx.spec.holes.length > 0 || (tilt <= 20 && sigmaMax > P.sigmaAllow))
      fails.push({ issue: 5, text: `Cavities and cutouts weaken every path to the pins: the weakest pin gets ${pct(effAll)} of its share` });
    else if (tilt > 20)
      fails.push({ issue: 2, text: `Target is tilted ${tilt.toFixed(0)}° from the joint – most of the impact is lost` });
    else fails.push({ issue: 3, text: `Target is off-centre: the weakest pin receives ${pct(effAll)} of its share` });
  }
  if (pressure > P.sigmaCrush)
    fails.push({ issue: 1, text: `Target too small: ${pressure.toFixed(0)} MPa contact pressure dents/delaminates it` });
  if (sigmaMax > P.sigmaAllow && !fails.some((f) => f.issue === 5))
    fails.push({ issue: 5, text: `Plate body overstressed (${sigmaMax.toFixed(0)} MPa) – it breaks before the pins go in` });
  const Freq = Math.max(...F);
  return {
    strike: { targets: struck, groups, eff: effAll, Freq, pressure, sigmaMax, sigmaAt, ok: fails.length === 0, fails },
    field,
  };
}

function pct(x: number) {
  return `${Math.max(0, Math.round(x * 100))}%`;
}

function stage(solid: MultiPoly, targetsIn: Omit<Target, 'r' | 'eff'>[], pick: (ts: Target[]) => { struck: number[]; groups: number[][] }, ctx: Ctx, plateH: number): Stage {
  const S = solveInfluence(solid, ctx);
  const n = ctx.pinX.length;
  const targets: Target[] = targetsIn.map((t) => {
    const r = shares(S, t);
    return { ...t, r, eff: t.reachable ? n * Math.min(...r) : -1 };
  });
  const { struck, groups } = pick(targets);
  if (struck.length === 0) {
    const empty: Strike = {
      targets: [], groups: [], eff: 0, Freq: Infinity, pressure: 0, sigmaMax: 0, sigmaAt: null, ok: false,
      fails: [{ issue: 3, text: 'No reachable target on this plate' }],
    };
    return { solid, targets, strike: empty, field: strikeStress(S, [], []).field, cells: S.mesh.elemCell.length };
  }
  const { strike, field } = evaluate(S, targets, struck, groups, ctx, plateH);
  return { solid, targets, strike, field, cells: S.mesh.elemCell.length };
}

// ---------------------------------------------------------------------------

export function analyze(spec: PlateSpec, P: Params = DEFAULT_PARAMS): Analysis {
  const t0 = performance.now();
  const pinX = pinSpans(spec.L, spec.pins);
  const ctx: Ctx = { spec, P, pinX };
  const plate = plateSolid(spec);
  const pinsMP = union(...pinX.map(([a, b]) => rect(a, -P.T, b, 0.01)));
  const all = union(plate, pinsMP);
  const plateTop = bbox(plate)[3];
  const allIdx = pinX.map((_, i) => i);

  // Steps 1-4: best existing target
  const base = stage(all, candidateTargets(plate, all, ctx), (ts) => {
    let best = -1;
    ts.forEach((t, i) => {
      if (!t.reachable) return;
      if (best < 0 || t.eff > ts[best].eff + 1e-9 || (Math.abs(t.eff - ts[best].eff) < 1e-9 && t.width > ts[best].width)) best = i;
    });
    return best < 0 ? { struck: [], groups: [] } : { struck: [best], groups: [allIdx] };
  }, ctx, plateTop);

  // Step 5: scaffolding, adding trapezoids until every group of pins is served
  let scaffold: ScaffoldResult | null = null;
  if (!base.strike.ok) {
    const tried: ScaffoldResult['tried'] = [];
    const kMax = Math.min(4, spec.pins);
    for (let k = 1; k <= kMax; k++) {
      const s = buildScaffold(spec, plate, pinX, k, P);
      const solid = union(plate, s.pieces, pinsMP);
      const tops = s.trapezoids.map((tr) => {
        const a = tr[3], b = tr[2];
        return { a, b, p: [(a[0] + b[0]) / 2, a[1]] as Pt, d: [0, -1] as Pt, width: b[0] - a[0], reachable: true };
      });
      const st = stage(solid, tops, () => ({ struck: tops.map((_, j) => j), groups: s.groups }), ctx, plateTop);
      tried.push({ k, ok: st.strike.ok, eff: st.strike.eff });
      const cand: ScaffoldResult = { k, trapezoids: s.trapezoids, pieces: s.pieces, tabs: s.tabs, stage: st, tried };
      if (!scaffold || st.strike.ok || st.strike.eff > scaffold.stage.strike.eff) scaffold = cand;
      if (st.strike.ok) break;
    }
  }
  return { plate, pinsMP, pinX, base, scaffold, ms: performance.now() - t0 };
}

function buildScaffold(spec: PlateSpec, plate: MultiPoly, pinX: [number, number][], k: number, P: Params) {
  const n = pinX.length;
  const [, , , top] = bbox(plate);
  const H = top + P.margin;
  const groups: number[][] = [];
  const trapezoids: Ring[] = [];
  for (let j = 0; j < k; j++) {
    const g = Array.from({ length: n }, (_, i) => i).filter((i) => Math.floor((i * k) / n) === j);
    groups.push(g);
    const seg = pinX[0][1] - pinX[0][0];
    const x0 = k === 1 ? 0 : Math.max(0, pinX[g[0]][0] - seg);
    const x1 = k === 1 ? spec.L : Math.min(spec.L, pinX[g[g.length - 1]][1] + seg);
    const c = (x0 + x1) / 2;
    const w = P.scaffoldTop / 2;
    trapezoids.push([[x0, 0], [x1, 0], [c + w, H], [c - w, H]]);
  }
  const trapMP = union(...trapezoids.map((t) => [[t]] as MultiPoly));
  // fill cutouts the trapezoid touches, so the scaffolding comes off in one piece (Fig. 12d)
  const holes = spec.holes.map((h) => [[h]] as MultiPoly).filter((h) => intersection(h, trapMP).length > 0);
  const pieces = difference(union(trapMP, ...holes), plate).filter((p) => multiArea([p]) > 2);
  const tabs = pieces.map((p) => tabFor(p, plate)).filter((t): t is Pt => !!t);
  return { trapezoids, pieces, tabs, groups };
}

/** one break-away tab on the longest edge shared with the plate */
function tabFor(piece: Ring[], plate: MultiPoly): Pt | null {
  let best: Pt | null = null, bl = 0;
  for (const ring of piece) {
    const o = openRing(ring);
    for (let i = 0; i < o.length; i++) {
      const a = o[i], b = o[(i + 1) % o.length];
      const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > bl && Math.abs(m[1]) > 1e-6 && distToBoundary(m, plate) < 1e-3) { bl = len; best = m; }
    }
  }
  return best;
}
