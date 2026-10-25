// Plates are planar polygons (their mid-surfaces). Joints are detected from the
// geometry: an edge of plate P lying on plate Q's boundary is a box joint
// (corner); an edge lying inside Q's face is a T-joint / slot (P's tabs go
// through Q), which is what the paper calls a concave joint.
export type V3 = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));

export interface PlateDef {
  name: string;
  poly: V3[];
}

export interface ModelDef {
  id: string;
  name: string;
  figure?: string;
  blurb: string;
  plates: PlateDef[];
  /** the order a maker would naively follow (the user-study control condition) */
  naive: number[];
  /** tie-break order for the planner among equally good sequences (defaults to naive) */
  prefer?: number[];
}

export interface Plate extends PlateDef {
  id: number;
  n: V3;
  c: V3;
}

export interface Joint {
  a: number;
  b: number;
  kind: 'box' | 'slot';
  /** for slots: the plate whose tabs go through the other */
  tab?: number;
  /** for slots: normal of the slotted plate */
  slotNormal?: V3;
  e0: V3;
  e1: V3;
  dir: V3;
  /** in-plane direction of each plate pointing towards the joint edge */
  toward: Record<number, V3>;
  angle: number; // degrees between the plates
  right: boolean;
  concave: boolean;
}

export interface Model {
  def: ModelDef;
  plates: Plate[];
  joints: Joint[];
  adj: number[][]; // joint indices per plate
  /** plates whose outline is a concave (non-convex) polygon */
  nonConvex: boolean[];
}

const EPS = 0.5;

function planeOf(poly: V3[]): { n: V3; c: V3 } {
  const c = mul(poly.reduce(add, [0, 0, 0] as V3), 1 / poly.length);
  let n: V3 = [0, 0, 0];
  for (let i = 0; i < poly.length; i++) n = add(n, cross(sub(poly[i], c), sub(poly[(i + 1) % poly.length], c)));
  return { n: norm(n), c };
}

/** 2D coords of a point in the plate's plane */
function basis(p: Plate) {
  const u = norm(sub(p.poly[1], p.poly[0]));
  const v = cross(p.n, u);
  return (q: V3): [number, number] => [dot(sub(q, p.poly[0]), u), dot(sub(q, p.poly[0]), v)];
}

function onSeg(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) < EPS;
}

function inPoly(p: [number, number], poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function isNonConvex(p: Plate): boolean {
  const n = p.poly.length;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = p.poly[i], b = p.poly[(i + 1) % n], c = p.poly[(i + 2) % n];
    const t = dot(cross(sub(b, a), sub(c, b)), p.n);
    if (Math.abs(t) < 1e-6) continue;
    if (sign === 0) sign = Math.sign(t);
    else if (Math.sign(t) !== sign) return true;
  }
  return false;
}

/** some point strictly inside a (possibly non-convex) plate */
function interiorPoint(p: Plate): V3 {
  const to2 = basis(p);
  const q2 = p.poly.map(to2);
  const xs = q2.map((q) => q[0]), ys = q2.map((q) => q[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const u = norm(sub(p.poly[1], p.poly[0]));
  const v = cross(p.n, u);
  for (let k = 1; k < 40; k++)
    for (let i = 1; i < k; i++)
      for (let j = 1; j < k; j++) {
        const pt: [number, number] = [x0 + ((x1 - x0) * i) / k, y0 + ((y1 - y0) * j) / k];
        if (inPoly(pt, q2) && !q2.some((_, m) => onSeg(pt, q2[m], q2[(m + 1) % q2.length])))
          return add(p.poly[0], add(mul(u, pt[0]), mul(v, pt[1])));
      }
  return p.c;
}

/** flip faces so every normal points out of the closed solid (ray-parity test) */
function orientOutward(plates: Plate[]) {
  const ray = norm([0.2113, 0.4519, 0.8664]);
  const flat = plates.map((p) => ({ p, to2: basis(p), q2: p.poly.map(basis(p)) }));
  // decide every flip before applying any: basis() depends on the vertex order
  const flip = plates.map((p) => {
    const x = add(interiorPoint(p), mul(p.n, 1));
    let hits = 0;
    for (const r of flat) {
      const den = dot(ray, r.p.n);
      if (Math.abs(den) < 1e-9) continue;
      const t = dot(sub(r.p.c, x), r.p.n) / den;
      if (t <= 1e-6) continue;
      if (inPoly(r.to2(add(x, mul(ray, t))), r.q2)) hits++;
    }
    return hits % 2 === 1;
  });
  plates.forEach((p, i) => {
    if (!flip[i]) return;
    p.poly = [...p.poly].reverse();
    p.n = mul(p.n, -1);
  });
}

export function buildModel(def: ModelDef): Model {
  const plates: Plate[] = def.plates.map((p, id) => ({ ...p, id, ...planeOf(p.poly) }));
  orientOutward(plates);
  const joints: Joint[] = [];
  const seen = new Set<string>();
  for (const P of plates)
    for (const Q of plates) {
      if (P === Q) continue;
      const to2 = basis(Q);
      const q2 = Q.poly.map(to2);
      for (let i = 0; i < P.poly.length; i++) {
        const a = P.poly[i], b = P.poly[(i + 1) % P.poly.length];
        if (Math.abs(dot(sub(a, Q.c), Q.n)) > EPS || Math.abs(dot(sub(b, Q.c), Q.n)) > EPS) continue;
        const a2 = to2(a), b2 = to2(b), m2 = to2(mul(add(a, b), 0.5));
        const onBoundary = q2.some((_, k) => onSeg(m2, q2[k], q2[(k + 1) % q2.length]));
        const inside = inPoly(m2, q2);
        if (!onBoundary && !inside) continue;
        if (!onBoundary && !(inPoly(a2, q2) || q2.some((_, k) => onSeg(a2, q2[k], q2[(k + 1) % q2.length])))) continue;
        void b2;
        const key = onBoundary ? [Math.min(P.id, Q.id), Math.max(P.id, Q.id)].join('-') : `${P.id}>${Q.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const dir = norm(sub(b, a));
        const mid = mul(add(a, b), 0.5);
        // in-plane direction from the plate's material towards the edge
        // (tested against the polygon, so non-convex plates work too)
        const toward = (pl: Plate): V3 => {
          const w = norm(cross(pl.n, dir));
          const probe = basis(pl)(add(mid, mul(w, 1)));
          return inPoly(probe, pl.poly.map(basis(pl))) ? mul(w, -1) : w;
        };
        const tP = toward(P), tQ = toward(Q);
        // reflex edge of the solid: Q rises out of P's outer side
        const reflex = onBoundary && dot(mul(tQ, -1), P.n) > 1e-6;
        let angle: number;
        if (onBoundary) angle = (Math.acos(Math.max(-1, Math.min(1, dot(mul(tP, -1), mul(tQ, -1))))) * 180) / Math.PI;
        else angle = (Math.asin(Math.min(1, Math.abs(dot(tP, Q.n)))) * 180) / Math.PI;
        joints.push({
          a: P.id, b: Q.id,
          kind: onBoundary ? 'box' : 'slot',
          tab: onBoundary ? undefined : P.id,
          slotNormal: onBoundary ? undefined : Q.n,
          e0: a, e1: b, dir,
          toward: { [P.id]: tP, [Q.id]: tQ },
          angle,
          right: Math.abs(angle - 90) < 2,
          concave: !onBoundary || reflex,
        });
      }
    }
  const adj: number[][] = plates.map(() => []);
  joints.forEach((j, k) => { adj[j.a].push(k); adj[j.b].push(k); });
  return { def, plates, joints, adj, nonConvex: plates.map(isNonConvex) };
}

/**
 * Directions in which plate p can be pulled out of joint j (directional
 * blocking, as in assembly-by-disassembly). Returned as the generators of a
 * planar cone: one ray or a wedge between two rays.
 */
export function removalCone(j: Joint, p: number): V3[] {
  const other = j.a === p ? j.b : j.a;
  const tp = j.toward[p], tq = j.toward[other];
  if (j.kind === 'box') {
    // Fingers interleave along the edge, so P moves perpendicular to it. P's
    // fingers must not push into Q (d·tq >= 0) and Q's fingers must not be
    // dragged through P (d·tp <= 0): the wedge between those two boundaries.
    const g1 = cross(j.dir, tq);
    const g2 = cross(j.dir, tp);
    return [norm(dot(g1, tp) < 0 ? g1 : mul(g1, -1)), norm(dot(g2, tq) > 0 ? g2 : mul(g2, -1))];
  }
  // slot: laser-cut through the slotted plate, so the tab only slides along its normal
  const n = j.slotNormal!;
  const out = dot(n, j.toward[j.tab!]) > 0 ? mul(n, -1) : n; // towards the tab's body
  return [j.tab === p ? out : mul(out, -1)];
}

function inCone(d: V3, g: V3[]): boolean {
  if (g.length === 1) return dot(d, g[0]) > 1 - 1e-6;
  const n = cross(g[0], g[1]);
  const nn = dot(n, n);
  if (nn < 1e-12) return dot(d, g[0]) > 1 - 1e-6 || dot(d, g[1]) > 1 - 1e-6;
  if (Math.abs(dot(d, n)) > 1e-6 * Math.sqrt(nn)) return false;
  const al = dot(cross(d, g[1]), n) / nn;
  const be = dot(cross(g[0], d), n) / nn;
  return al > -1e-6 && be > -1e-6;
}

/** a direction lying in every cone, or null if the plate is interlocked */
export function commonDirection(cones: V3[][]): V3 | null {
  // candidates in order of preference: wedge boundaries (clean, axis-like
  // insertions), wedge bisectors, then lines where two wedge planes meet
  const cand: V3[] = [];
  for (const g of cones) cand.push(g[0]);
  for (const g of cones) if (g.length === 2) cand.push(g[1]);
  for (const g of cones) if (g.length === 2) cand.push(norm(add(g[0], g[1])));
  for (let i = 0; i < cones.length; i++)
    for (let k = i + 1; k < cones.length; k++) {
      if (cones[i].length < 2 || cones[k].length < 2) continue;
      const l = cross(cross(cones[i][0], cones[i][1]), cross(cones[k][0], cones[k][1]));
      if (len(l) < 1e-9) continue;
      cand.push(norm(l), mul(norm(l), -1));
    }
  for (const d0 of cand) {
    const d = norm(d0);
    if (cones.every((g) => inCone(d, g))) return d;
  }
  return null;
}
