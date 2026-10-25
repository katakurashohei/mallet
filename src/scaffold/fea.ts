// Minimal 2D plane-stress FEA on a regular grid of bilinear quads.
// The paper uses a custom numpy FEA; we keep the same idea (linear elastic,
// supports at the pins) but solve with a banded Cholesky so that one
// factorisation serves every load case.
import { MultiPoly, pointInMulti, bbox, multiArea } from './geom';

export interface Material {
  E: number; // MPa
  nu: number;
  t: number; // plate thickness, mm
}

export interface Mesh {
  h: number;
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  cellActive: Uint8Array;
  nodeId: Int32Array; // (nx+1)*(ny+1), -1 if inactive
  nNodes: number;
  nodeX: Float64Array;
  nodeY: Float64Array;
  elems: Int32Array; // 4 node ids per active cell
  elemCell: Int32Array;
  halfBand: number; // in dofs
}

export function buildMesh(solid: MultiPoly, yBottom: number, targetCells = 7000, hMax = 2): Mesh {
  const [bx0, , bx1, by1] = bbox(solid);
  const area = multiArea(solid);
  const h = Math.min(hMax, Math.max(0.8, Math.sqrt(area / targetCells)));
  const x0 = bx0 - h * 0.5;
  const y0 = yBottom; // grid row 0 coincides with the pin tips
  const nx = Math.ceil((bx1 - x0) / h) + 1;
  const ny = Math.ceil((by1 - y0) / h) + 1;
  const cellActive = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++)
      if (pointInMulti(x0 + (i + 0.5) * h, y0 + (j + 0.5) * h, solid)) cellActive[j * nx + i] = 1;

  const W = nx + 1, H = ny + 1;
  const used = new Uint8Array(W * H);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++)
      if (cellActive[j * nx + i]) {
        used[j * W + i] = used[j * W + i + 1] = used[(j + 1) * W + i] = used[(j + 1) * W + i + 1] = 1;
      }
  // number nodes along the shorter grid dimension to keep the band narrow
  const nodeId = new Int32Array(W * H).fill(-1);
  let n = 0;
  if (W <= H) {
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (used[j * W + i]) nodeId[j * W + i] = n++;
  } else {
    for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) if (used[j * W + i]) nodeId[j * W + i] = n++;
  }
  const nodeX = new Float64Array(n), nodeY = new Float64Array(n);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const id = nodeId[j * W + i];
      if (id >= 0) { nodeX[id] = x0 + i * h; nodeY[id] = y0 + j * h; }
    }
  const elemList: number[] = [], cellList: number[] = [];
  let band = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (!cellActive[j * nx + i]) continue;
      const e = [nodeId[j * W + i], nodeId[j * W + i + 1], nodeId[(j + 1) * W + i + 1], nodeId[(j + 1) * W + i]];
      elemList.push(...e);
      cellList.push(j * nx + i);
      band = Math.max(band, Math.max(...e) - Math.min(...e));
    }
  return {
    h, x0, y0, nx, ny, cellActive, nodeId, nNodes: n, nodeX, nodeY,
    elems: Int32Array.from(elemList), elemCell: Int32Array.from(cellList),
    halfBand: 2 * band + 1,
  };
}

// ---- element matrices ------------------------------------------------------

const XI = [-1, 1, 1, -1], ETA = [-1, -1, 1, 1];

function dMatrix(m: Material) {
  const c = m.E / (1 - m.nu * m.nu);
  return [c, c * m.nu, 0, c * m.nu, c, 0, 0, 0, (c * (1 - m.nu)) / 2];
}

/** B matrix (3x8) for a square element of side h at natural coords (xi, eta) */
function bMatrix(xi: number, eta: number, h: number): number[] {
  const B = new Array(24).fill(0);
  for (let a = 0; a < 4; a++) {
    const dNdx = (0.25 * XI[a] * (1 + ETA[a] * eta) * 2) / h;
    const dNdy = (0.25 * ETA[a] * (1 + XI[a] * xi) * 2) / h;
    B[0 * 8 + 2 * a] = dNdx;
    B[1 * 8 + 2 * a + 1] = dNdy;
    B[2 * 8 + 2 * a] = dNdy;
    B[2 * 8 + 2 * a + 1] = dNdx;
  }
  return B;
}

function elementStiffness(m: Material, h: number): Float64Array {
  const D = dMatrix(m);
  const K = new Float64Array(64);
  const g = 1 / Math.sqrt(3);
  for (const xi of [-g, g])
    for (const eta of [-g, g]) {
      const B = bMatrix(xi, eta, h);
      const detJ = (h * h) / 4;
      for (let r = 0; r < 8; r++)
        for (let c = 0; c < 8; c++) {
          let s = 0;
          for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) s += B[p * 8 + r] * D[p * 3 + q] * B[q * 8 + c];
          K[r * 8 + c] += s * detJ * m.t;
        }
    }
  return K;
}

// ---- banded Cholesky ---------------------------------------------------------

export interface Factor {
  n: number;
  m: number;
  L: Float64Array; // row i stores columns i-m .. i
}

function factorize(A: Float64Array, n: number, m: number): Factor {
  const w = m + 1;
  const L = A; // in place
  for (let i = 0; i < n; i++) {
    const jStart = Math.max(0, i - m);
    for (let j = jStart; j <= i; j++) {
      let s = L[i * w + (j - i + m)];
      const kStart = Math.max(jStart, j - m);
      const ri = i * w - i + m, rj = j * w - j + m;
      for (let k = kStart; k < j; k++) s -= L[ri + k] * L[rj + k];
      if (i === j) L[i * w + m] = Math.sqrt(Math.max(s, 1e-12));
      else L[i * w + (j - i + m)] = s / L[j * w + m];
    }
  }
  return { n, m, L };
}

export function solve(F: Factor, b: Float64Array): Float64Array {
  const { n, m, L } = F;
  const w = m + 1;
  const y = Float64Array.from(b);
  for (let i = 0; i < n; i++) {
    let s = y[i];
    for (let k = Math.max(0, i - m); k < i; k++) s -= L[i * w + (k - i + m)] * y[k];
    y[i] = s / L[i * w + m];
  }
  for (let i = n - 1; i >= 0; i--) {
    y[i] /= L[i * w + m];
    const yi = y[i];
    for (let k = Math.max(0, i - m); k < i; k++) y[k] -= L[i * w + (k - i + m)] * yi;
  }
  return y;
}

export interface System {
  mesh: Mesh;
  mat: Material;
  factor: Factor;
  penalty: number;
  supportDofs: Int32Array;
}

/** assemble K, add penalty springs on the given dofs, factorise */
export function buildSystem(mesh: Mesh, mat: Material, supportDofs: number[]): System {
  const n = mesh.nNodes * 2;
  const m = mesh.halfBand;
  const w = m + 1;
  const A = new Float64Array(n * w);
  const Ke = elementStiffness(mat, mesh.h);
  const dofs = new Int32Array(8);
  const nE = mesh.elems.length / 4;
  for (let e = 0; e < nE; e++) {
    for (let a = 0; a < 4; a++) {
      dofs[2 * a] = 2 * mesh.elems[e * 4 + a];
      dofs[2 * a + 1] = 2 * mesh.elems[e * 4 + a] + 1;
    }
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const i = dofs[r], j = dofs[c];
        if (j > i) continue;
        A[i * w + (j - i + m)] += Ke[r * 8 + c];
      }
  }
  let maxDiag = 0;
  for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, A[i * w + m]);
  const penalty = maxDiag * 1e5;
  for (const d of supportDofs) A[d * w + m] += penalty;
  return { mesh, mat, factor: factorize(A, n, m), penalty, supportDofs: Int32Array.from(supportDofs) };
}

/** von Mises stress at each element centre */
export function elementVonMises(sys: System, u: Float64Array): Float64Array {
  const { mesh, mat } = sys;
  const D = dMatrix(mat);
  const B = bMatrix(0, 0, mesh.h);
  const nE = mesh.elems.length / 4;
  const out = new Float64Array(nE);
  const ue = new Float64Array(8);
  for (let e = 0; e < nE; e++) {
    for (let a = 0; a < 4; a++) {
      const id = mesh.elems[e * 4 + a];
      ue[2 * a] = u[2 * id];
      ue[2 * a + 1] = u[2 * id + 1];
    }
    const eps = [0, 0, 0];
    for (let p = 0; p < 3; p++) for (let c = 0; c < 8; c++) eps[p] += B[p * 8 + c] * ue[c];
    const sx = D[0] * eps[0] + D[1] * eps[1];
    const sy = D[3] * eps[0] + D[4] * eps[1];
    const txy = D[8] * eps[2];
    out[e] = Math.sqrt(sx * sx - sx * sy + sy * sy + 3 * txy * txy);
  }
  return out;
}
