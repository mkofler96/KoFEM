// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Generates the classical MBB beam topology-optimization example from its
// recipe (recipes/mbb-beam-topopt.mjs), built as a user builds it in the GUI:
// import the block, split the pads, mesh with Netgen, put the supports and the
// load on the pads, run the optimizer (examples/validation/lib/pipeline.mjs,
// which calls the app's own code). What the page shows is what the app makes.
//
//   mbb-beam-topopt.step       — the plain 300 × 50 × 10 mm block a user
//                                imports, linked from the page;
//   mbb-beam-topopt.model.step — the block after the recipe's four splits,
//                                whose CAD faces the analysis file's supports
//                                and load name, so the model can be re-meshed;
//   mbb-beam-topopt.vtu        — the analysis "Open in KoFEM" loads: the Netgen
//                                mesh, the tessellation and CAD face ids, the
//                                support and load groups and the optimization
//                                settings. It opens in the Optimize step, ready
//                                to run;
//   mbb-beam-topopt.png        — the figure on /examples/mbb-beam-topopt/: the
//                                OPTIMIZED design, the boundary of every tet
//                                with density ≥ 0.5;
//   showcase/mbb-beam-topopt.json — the numbers on that page: settings, the
//                                compliance history, the mesh, and `fe`, the
//                                final compliance the Results panel shows.
//
// The MBB (Messerschmitt-Bölkow-Blohm) beam is the canonical minimum-compliance
// benchmark (Olhoff et al. 1991; Sigmund 2001, "A 99 line topology optimization
// code"; Andreassen et al. 2011, "88 lines"): a simply-supported beam with a
// central load, 6 : 1 span-to-height, half the material to spend. The whole beam
// is modelled — pin at the bottom-left, roller at the bottom-right, load at the
// top of mid-span — rather than the symmetric half, so the model reads as drawn
// in the textbooks. The regression-locked half-model on a structured hex grid is
// examples/validation/topopt/cases/mbb-beam.mjs.
//
//   cd web && bun run examples:generate-mbb-topopt
//
// web/tests/examples-by-hand.spec.ts walks the recipe through the UI and gets
// the published final compliance; web/tests/mbb-by-hand.spec.ts checks that
// the supports and the load survive a re-mesh. Netgen is not bit-reproducible
// across engine builds, so a re-run can move the numbers on the page slightly;
// regenerate the pages afterwards (bun run validate:report).

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import recipes from "./recipes/index.mjs";
import { F, H, L, LOAD_PAD, PAD, T } from "./recipes/mbb-beam-topopt.mjs";
import { buildFromRecipe } from "../validation/lib/pipeline.mjs";
import { buildAnalysisFile } from "../validation/lib/app-model.mjs";
import { resultFigure } from "../validation/lib/render.mjs";
import { writeShowcase } from "../validation/catalog.mjs";
import {
  modelStepPath,
  writeModelStep,
} from "../validation/lib/model-step.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "site");
const ID = "mbb-beam-topopt";
const TITLE = "MBB beam — topology optimization";
const recipe = recipes[ID];

const build = await buildFromRecipe(ID, recipe);
const { settings, density, history, seconds } = build.optimization;
const nTets = build.elements.length;
const nNodes = build.nodes.length;

// The pipeline has checked convergence; the example also has to reach its
// volume and show a clear topology.
const c0 = history[0].compliance;
const cN = history.at(-1).compliance;
const volN = history.at(-1).volume;
if (cN !== build.fe)
  throw new Error(
    `final compliance ${cN} differs from the read-out ${build.fe}`,
  );
if (Math.abs(volN - settings.constraints.volumeFraction) > 0.01)
  throw new Error(
    `volume fraction ${volN} missed the ${settings.constraints.volumeFraction} target`,
  );
const nSolid = density.filter((r) => r > 0.9).length;
const nVoid = density.filter((r) => r < 0.1).length;
if (nSolid < 0.2 * nTets || nVoid < 0.2 * nTets)
  throw new Error(
    `no clear topology emerged (${nSolid} solid, ${nVoid} void of ${nTets})`,
  );

// ── The figure: the boundary of the solid (ρ ≥ 0.5) design ────────────────────
// A tet face is on the boundary of the thresholded design when exactly one solid
// tet owns it. Vertex colour is the mean density of the solid tets meeting at
// that vertex, which reads as a smooth field rather than per-tet speckle.
const THRESHOLD = 0.5;
const TET_FACES = [
  [0, 2, 1],
  [0, 1, 3],
  [0, 3, 2],
  [1, 2, 3],
];
const owners = new Map();
const densitySum = new Map();
build.elements.forEach(({ nodeIds }, e) => {
  if (density[e] < THRESHOLD) return;
  for (const v of nodeIds) {
    const acc = densitySum.get(v) ?? [0, 0];
    densitySum.set(v, [acc[0] + density[e], acc[1] + 1]);
  }
  for (const def of TET_FACES) {
    const face = def.map((i) => nodeIds[i]);
    const key = [...face].sort((a, b) => a - b).join(",");
    const entry = owners.get(key);
    if (entry) entry.count++;
    else owners.set(key, { face, count: 1 });
  }
});
const positions = [];
const magnitudes = [];
const triangles = [];
const local = new Map();
for (const { face, count } of owners.values()) {
  if (count !== 1) continue;
  for (const v of face) {
    if (!local.has(v)) {
      local.set(v, positions.length / 3);
      const n = build.nodes[v];
      positions.push(n.x, n.y, n.z);
      const [sum, k] = densitySum.get(v);
      magnitudes.push(sum / k);
    }
    triangles.push(local.get(v));
  }
}
const { png, meta: figure } = resultFigure(
  {
    positions,
    displacements: positions.map(() => 0),
    scalars: magnitudes,
    triangles,
  },
  { field: "density", unit: "", view: [-0.3, -0.25, -1], deform: false },
);

writeFileSync(join(outDir, `${ID}.step`), build.stepText);
writeModelStep(modelStepPath(outDir, ID), build.stepBytes);
writeFileSync(join(outDir, `${ID}.vtu`), buildAnalysisFile(build, TITLE));
writeShowcase(
  {
    id: ID,
    name: "MBB beam, topology optimization",
    script: "examples:generate-mbb-topopt",
    headline: `Compliance ${c0.toFixed(1)} → ${cN.toFixed(1)} N·mm in ${history.length} iterations at volume fraction ${volN.toFixed(3)}`,
    inputs: [
      { symbol: "L", value: L, unit: "mm" },
      { symbol: "H", value: H, unit: "mm" },
      { symbol: "t", value: T, unit: "mm" },
      { symbol: "E", value: recipe.material.young, unit: "MPa" },
      { symbol: "ν", value: recipe.material.poisson, unit: "" },
      { symbol: "F", value: F, unit: "N" },
    ],
    mesh: {
      elements: `${nTets.toLocaleString("en-US")} linear 4-node tetrahedra (P1)`,
      nodes: nNodes,
      dofs: 3 * nNodes,
      maxElementSize: build.meshSettings.maxElementSize,
    },
    settings: {
      volumeFraction: settings.constraints.volumeFraction,
      penalty: settings.penalty,
      filterRadius: settings.filterRadius,
      moveLimit: settings.moveLimit,
      maxIterations: settings.maxIterations,
      tolerance: settings.tolerance,
      threshold: THRESHOLD,
    },
    history: history.map((h) => ({
      objective: h.objective,
      volume: h.volume,
      maxChange: h.max_change,
    })),
    solid: nSolid,
    void: nVoid,
    seconds,
    // The page's number: the final compliance, as the Results panel shows it
    // after the run (recipe read-out "compliance").
    fe: cN,
    readout: null,
    figure,
    page: {
      summary:
        "A simply supported beam with half its material to spend. The optimizer carves the block into a truss.",
      model: `Block of span L, height H and thickness t; pads of ${PAD} mm at the supports and ${LOAD_PAD} mm under the load.`,
      supports:
        "Bottom-left pad fixed (Ux, Uy, Uz); bottom-right pad Uy only (a roller).",
      loads: "F in −y as a force on the pad at the top of mid-span.",
      measured:
        "Compliance F·u, the work done by the load, at half the volume.",
      mesh: `Netgen, ${build.meshSettings.maxElementSize} mm maximum element size`,
      source: "Sigmund (2001); Andreassen et al. (2011)",
    },
  },
  png,
);

console.log(
  `${ID}: ${nNodes} nodes, ${nTets} tets; ${history.length} it in ${seconds.toFixed(1)} s, ` +
    `compliance ${c0.toFixed(1)} → ${cN.toFixed(1)}, volume ${volN.toFixed(4)}, ` +
    `${nSolid} solid / ${nVoid} void → ${ID}.{step,model.step,vtu,png} + showcase/${ID}.json`,
);
