import pc from 'polygon-clipping';

export type Pt = [number, number];
export type Ring = Pt[];
/** outer ring followed by holes */
export type Poly = Ring[];
export type MultiPoly = Poly[];

export const union = (...g: MultiPoly[]): MultiPoly => {
  const nonEmpty = g.filter((m) => m.length > 0);
  if (nonEmpty.length === 0) return [];
  return pc.union(nonEmpty[0] as any, ...(nonEmpty.slice(1) as any)) as MultiPoly;
};
export const difference = (a: MultiPoly, ...b: MultiPoly[]): MultiPoly => {
  const nonEmpty = b.filter((m) => m.length > 0);
  if (a.length === 0) return [];
  if (nonEmpty.length === 0) return a;
  return pc.difference(a as any, ...(nonEmpty as any)) as MultiPoly;
};
export const intersection = (a: MultiPoly, b: MultiPoly): MultiPoly => {
  if (a.length === 0 || b.length === 0) return [];
  return pc.intersection(a as any, b as any) as MultiPoly;
};

export const rect = (x0: number, y0: number, x1: number, y1: number): MultiPoly => [
  [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
];

/** drop the duplicated closing point polygon-clipping emits */
export const openRing = (r: Ring): Ring =>
  r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r;

export function ringArea(r: Ring): number {
  const o = openRing(r);
  let a = 0;
  for (let i = 0; i < o.length; i++) {
    const [x0, y0] = o[i];
    const [x1, y1] = o[(i + 1) % o.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

export function multiArea(m: MultiPoly): number {
  let a = 0;
  for (const p of m) p.forEach((r, i) => (a += i === 0 ? Math.abs(ringArea(r)) : -Math.abs(ringArea(r))));
  return a;
}

function inRing(x: number, y: number, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInMulti(x: number, y: number, m: MultiPoly): boolean {
  for (const p of m) {
    if (!inRing(x, y, p[0])) continue;
    let inHole = false;
    for (let k = 1; k < p.length; k++) if (inRing(x, y, p[k])) inHole = true;
    if (!inHole) return true;
  }
  return false;
}

export function bbox(m: MultiPoly): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of m)
    for (const r of p)
      for (const [x, y] of r) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y);
        x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
  return [x0, y0, x1, y1];
}

export function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

export function distToBoundary(p: Pt, m: MultiPoly): number {
  let d = Infinity;
  for (const poly of m)
    for (const r of poly) {
      const o = openRing(r);
      for (let i = 0; i < o.length; i++) d = Math.min(d, distToSeg(p, o[i], o[(i + 1) % o.length]));
    }
  return d;
}

export const ringToPath = (r: Ring) =>
  openRing(r).map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join('') + 'Z';
export const multiToPath = (m: MultiPoly) => m.map((p) => p.map(ringToPath).join('')).join('');
