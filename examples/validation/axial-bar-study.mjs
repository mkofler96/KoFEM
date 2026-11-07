// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Real WASM evidence for /theory/verification/axial-bar/. No solver math here.
// --report records a new snapshot; the default run checks it and the bands.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import axialBar, { axialBarModel } from "./cases/axial-bar.mjs";
import { solveModel } from "./lib/app-model.mjs";
import { meshStats } from "./lib/mesh.mjs";
import { loadSolver } from "./lib/solver.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const output = new URL(
  "../../web/public/theory/axial-bar.json",
  import.meta.url,
);
const engine = readFileSync(
  new URL("../../web/src/wasm/pkg/.engine-id", import.meta.url),
  "utf8",
).trim();
const expectedEngine = execFileSync("bash", ["scripts/engine-version.sh"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
assert.equal(
  engine,
  expectedEngine,
  "WASM does not match engine sources; fetch/build it before recording evidence",
);
const solve = await loadSolver();
const inputs = Object.fromEntries(
  axialBar.page.inputs.map(([symbol, value]) => [symbol, value]),
);
const [width, height] = inputs["W × H"].split(" × ").map(Number);
const referenceStress = inputs.P / (width * height);
const setup = {
  inputs: axialBar.page.inputs,
  supports: axialBar.page.supports,
  load: axialBar.page.loads,
  displacementMeasure: axialBar.page.measured,
  stressMeasure:
    "Unsmoothed element-centre von Mises values, centres in 400 ≤ x ≤ 600 mm; equal-volume mean, minimum and maximum",
  regionMm: [400, 600],
  referenceDisplacementMm: axialBar.reference,
  referenceStressMpa: referenceStress,
  displacementTolerancePct: axialBar.tolPct,
  stressTolerancePct: 0.5,
  solver: {
    method: "MFEM CG",
    preconditioner: "GSSmoother",
    relativeTolerance: 1e-6,
    absoluteTolerance: 0,
    initialIterationBudget: 5000,
  },
};
const errorPct = (value, reference) => (100 * (value - reference)) / reference;
const runs = [];
for (const [grid, order] of [
  [[10, 2, 2], 1],
  [[20, 4, 4], 1],
  [[40, 8, 8], 1],
  [[10, 2, 2], 2],
]) {
  const model = axialBarModel(axialBar.name, grid, order);
  const result = solveModel(solve, model);
  assert.equal(result.displacements.length, 3 * model.mesh.vertices.length);
  assert.equal(result.von_mises.length, model.mesh.hexahedra.length);
  assert.ok(
    [...result.displacements, ...result.von_mises].every(Number.isFinite),
    "non-finite solver output",
  );
  const displacementMm = axialBar.measure(model, result);
  const samples = model.mesh.hexahedra.flatMap((hex, index) => {
    const centre =
      hex.reduce((sum, vertex) => sum + model.mesh.vertices[vertex][0], 0) / 8;
    return centre >= setup.regionMm[0] && centre <= setup.regionMm[1]
      ? [result.von_mises[index]]
      : [];
  });
  assert.ok(samples.length > 0, "stress region contains no centres");
  const stressMeanMpa =
    samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const displacementErrorPct = errorPct(displacementMm, axialBar.reference);
  const stressWorstErrorPct = Math.max(
    ...samples.map((value) => Math.abs(errorPct(value, referenceStress))),
  );
  assert.ok(
    Math.abs(displacementErrorPct) <= setup.displacementTolerancePct,
    `order ${order}, ${grid}: displacement error ${displacementErrorPct}% exceeds ${setup.displacementTolerancePct}%`,
  );
  assert.ok(
    stressWorstErrorPct <= setup.stressTolerancePct,
    `order ${order}, ${grid}: stress error ${stressWorstErrorPct}% exceeds ${setup.stressTolerancePct}%`,
  );
  runs.push({
    grid,
    role:
      order === 2
        ? "diagnostic: Q2 clamp face-centre DOFs remain free"
        : "order-1 refinement with fully fixed end",
    ...meshStats(model.mesh, order),
    displacementMm,
    displacementErrorPct,
    stressSamples: samples.length,
    stressMeanMpa,
    stressMinMpa: Math.min(...samples),
    stressMaxMpa: Math.max(...samples),
    stressWorstErrorPct,
  });
}
const publicData = JSON.parse(
  readFileSync(
    new URL("../../web/public/examples/results.json", import.meta.url),
    "utf8",
  ),
);
const publicCase = publicData.cases.find((entry) => entry.id === axialBar.id);
assert.ok(publicCase, "public example record lacks axial-bar");
const baseline = runs.find((run) => run.order === 1 && run.elements === 320);
assert.ok(baseline, "study lacks the public example mesh");
assert.ok(
  Math.abs(baseline.displacementMm - publicCase.fe) <=
    1e-4 * Math.abs(publicCase.fe),
  "study and public example displacement disagree; investigate before regenerating",
);
console.table(
  runs.map(
    ({
      grid,
      order,
      dofs,
      displacementMm,
      displacementErrorPct,
      stressMeanMpa,
      stressWorstErrorPct,
    }) => ({
      grid: grid.join(" × "),
      order,
      dofs,
      displacementMm,
      displacementErrorPct,
      stressMeanMpa,
      stressWorstErrorPct,
    }),
  ),
);
if (process.argv.includes("--report")) {
  const data = {
    generated: new Date().toISOString(),
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim(),
    engine,
    command: "bun examples/validation/axial-bar-study.mjs --report",
    setup,
    runs,
  };
  mkdirSync(new URL(".", output), { recursive: true });
  writeFileSync(output, JSON.stringify(data, null, 2) + "\n");
  console.log(
    `Recorded ${runs.length} axial-bar solves (${engine}). Regenerate Theory pages.`,
  );
} else {
  const published = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(
    published.engine,
    engine,
    "engine changed; review and regenerate evidence",
  );
  assert.deepEqual(
    published.setup,
    setup,
    "study inputs, measures or tolerances changed",
  );
  assert.equal(published.runs.length, runs.length);
  for (const [index, run] of runs.entries()) {
    for (const [key, value] of Object.entries(run)) {
      const recorded = published.runs[index][key];
      if (typeof value === "number" && !Number.isInteger(value)) {
        assert.ok(
          Number.isFinite(recorded) &&
            Math.abs(value - recorded) <= 1e-4 * Math.max(1, Math.abs(value)),
          `stale ${index}.${key}: recorded ${recorded}, now ${value}`,
        );
      } else assert.deepEqual(recorded, value, `stale ${index}.${key}`);
    }
  }
  console.log(
    "4/4 axial-bar displacement and interior stress bands passed; published evidence matches. Q2 is diagnostic, not equivalent-clamp convergence evidence.",
  );
}
