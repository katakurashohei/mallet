# Mallet-Based Assembly: interactive demo

Web demo for *Mallet-Based Assembly: Enabling Load-Bearing Laser-Cut Models* (UIST '25).

```
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/ (relative paths, deployable to any sub-path)
```

## What's inside

- **Trapezoidal scaffolding (issues 1–5)**, `src/scaffold/`
  - `fea.ts`: 2D plane-stress FEA (bilinear quads on a grid, banded Cholesky).
  - `analyze.ts`: Steps 1–5 from the paper. It places candidate targets, computes each pin's share of the impact
    (one solve per pin via Maxwell–Betti reciprocity), checks contact pressure and body stress, and otherwise
    generates (multi-)trapezoidal scaffolding with break-away tabs. Runs in a Web Worker.
  - `presets.ts`: six plates modelled after Figs. 2, 7, 10 and 12 (the cavity is a C-shape).
- **Constrain-before-insertion (issues 6–10)**, `src/assembly/`
  - `model.ts`: plates as 3D polygons. Box joints and T-joint slots are detected from the geometry, and
    directional-blocking removal cones are derived from the finger and slot geometry.
  - `planner.ts`: Dijkstra over the bitmask lattice of assembly states. Step penalties cover an
    unconstrained non-90° joint, a concave joint closed early, an unstable (hinged) assembly and rotary insertion.
  - `presets.ts`: box (Fig. 28), ramp (Fig. 17), 3D L-shape, voxel chair and slanted box (Fig. 18), all closed (manifold) boxes.
  - `scaffold3d.ts` / `useScaffolds.ts`: "With scaffolding" in 3D. Every in-plane insertion step is projected to a 2D plate
    and run through the scaffolding FEA. Plates that fail get their trapezoids in 3D, which break off once the plate is home.
    Face-struck and rotary insertions get none.

`npx tsx scripts/probe.ts` and `npx tsx scripts/probe-plan.ts` print the analyses for every preset, which helps
when tuning thresholds and weights.

Thresholds (pin force, plywood strength, dent threshold) and penalty weights are illustrative. The paper does
not specify them; adjust them in `DEFAULT_PARAMS` / `DEFAULT_WEIGHTS` or with the sliders in the UI.

## Deploy

Pushing to `main` builds and publishes the site via GitHub Actions (`.github/workflows/deploy.yml`).
In the repository settings, set *Pages → Source* to **GitHub Actions**. Because the user site
`katakurashohei.github.io` has the custom domain `katakurashohei.me`, this repository's Pages site
appears at https://katakurashohei.me/mallet/.
