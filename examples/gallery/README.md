<!--
SPDX-FileCopyrightText: 2026 Michael Kofler
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Gallery — kofem.org/examples/

Everything on the public [examples gallery](https://kofem.org/examples/).

- `site/` is served verbatim at `/examples/`: the gallery page (`index.html`),
  its manifest `examples.json`, and the `<id>.vtu` (plus optional `<id>.step`)
  that "Open in KoFEM web" loads through `/app/?example=<id>`. Vite serves it in
  dev and copies it into `dist/examples/` on build (`web/vite.config.ts`).
- The generators here write `site/`. Never hand-edit a `.vtu` or
  `examples.json`; change the generator and re-run it:

| Generator                       | Examples                        | Run (in `web/`)                              |
| ------------------------------- | ------------------------------- | -------------------------------------------- |
| `generate.mjs` + `examples.mjs` | the hex-mesh benchmarks         | `bun run examples:generate`                  |
| `generate-plate-hole-shell.mjs` | plate with a hole, shells       | `bun run examples:generate-plate-hole-shell` |
| `generate-mbb-topopt.mjs`       | MBB beam, topology optimization | `bun run examples:generate-mbb-topopt`       |

## The MBB beam (topology optimization)

`generate-mbb-topopt.mjs` builds the classical MBB minimum-compliance benchmark
with KoFEM's own pipeline only — no structured grid, no external mesher:

1. writes the design domain as a STEP file (`step-prism.mjs`): a 300 × 50 × 10 mm
   block whose bottom and top edges are split, so the pin pad, the roller pad
   and the load pad are their own CAD faces;
2. tessellates it and meshes it with Netgen using the app's exact mesher
   options (5 mm max element size → ~8k tets);
3. optimizes it with `optimize_topology` (volume fraction 0.5, p = 3,
   r_min = 10 mm) and fails if it does not converge or no topology emerges.

It ships `mbb-beam-topopt.step` next to the `.vtu`, so the example opens in the
Optimize step ready to run **and** can be re-meshed (re-meshing clears the
support/load groups, as for any model — re-pick the three pad faces). The app
reproduces the generator's run exactly: 192.8 → 47.8 N·mm in 66 iterations,
~40 s in the browser.

The half-model regression benchmark on a structured hex grid lives in
`examples/validation/topopt/cases/mbb-beam.mjs`.
