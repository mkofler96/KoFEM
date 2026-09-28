<!--
SPDX-FileCopyrightText: 2026 Michael Kofler
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Web gallery examples

Generators for the analyses shipped in `web/public/examples/`. Each writes a
`.vtu` plus its entry in `examples.json`; `generate.mjs` runs them all.

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
