// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Re-run the existing topology-optimization benchmarks through the real WASM
// engine and compare them with the committed record; never transcribe measured
// values into the articles. --report records a new snapshot.
//
//   bun theory/optimization/capture-evidence.mjs            # check (from web/)
//   bun theory/optimization/capture-evidence.mjs --report   # record
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadOptimizer } from "../../../examples/validation/topopt/lib/optimize.mjs";
import mbbBeam from "../../../examples/validation/topopt/cases/mbb-beam.mjs";
import meshIndependence from "../../../examples/validation/topopt/cases/cantilever-mesh-independence.mjs";
import { buildCantilever } from "../../../examples/validation/topopt/cases/cantilever-3d.mjs";
import {
  pearson,
  projectToCoarse,
  solidIoU,
} from "../../../examples/validation/topopt/lib/topopt.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = new URL(
  "../../public/theory/optimization.json",
  import.meta.url,
);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const engine = readFileSync(
  new URL("../../src/wasm/pkg/.engine-id", import.meta.url),
  "utf8",
).trim();
const expectedEngine = execFileSync("bash", ["scripts/engine-version.sh"], {
  cwd: root,
  encoding: "utf8",
}).trim();
assert.equal(
  engine,
  expectedEngine,
  "WASM does not match engine sources; fetch/build it before checking evidence",
);

// Record every optimize_topology call a case makes, so the record keeps the
// raw iteration history rather than the case's formatted metric strings.
const optimize = await loadOptimizer();
let calls = [];
const recording = (mesh, materials, bcs, settings) => {
  const result = optimize(mesh, materials, bcs, settings);
  calls.push({ mesh, settings, result });
  return result;
};
const summary = ({ mesh, settings, result }) => {
  const { history, converged, density } = result;
  const compliance = history.map((entry) => entry.compliance);
  return {
    elements: density.length,
    settings,
    iterations: history.length,
    converged,
    initialCompliance: compliance[0],
    finalCompliance: compliance.at(-1),
    minimumCompliance: Math.min(...compliance),
    finalVolumeFraction: history.at(-1).volume,
    finalMaxChange: history.at(-1).max_change,
    solidElements: density.filter((value) => value > 0.9).length,
    voidElements: density.filter((value) => value < 0.1).length,
    meshDims: mesh.dims,
  };
};
const runCase = (testCase) => {
  calls = [];
  const { checks, layout } = testCase.run(recording);
  for (const check of checks)
    assert.ok(check.pass, `${testCase.name}: ${check.label}`);
  return { calls: [...calls], checks, layout };
};

const mbb = runCase(mbbBeam);
assert.equal(mbb.calls.length, 1);
const independence = runCase(meshIndependence);
assert.equal(independence.calls.length, 2);
const [coarse, fine] = independence.calls;
const projected = projectToCoarse(
  fine.result.density,
  fine.mesh.dims,
  coarse.result.density,
  coarse.mesh.dims,
);
const cantilever = buildCantilever(10, 5, 5);
const measured = {
  mbb: {
    ...summary(mbb.calls[0]),
    checks: mbb.checks.map(({ label }) => label),
    layout: mbb.layout,
  },
  meshIndependence: {
    box: { L: 2, H: 1, D: 1 },
    coarse: summary(coarse),
    fine: summary(fine),
    complianceDifferencePercent:
      (100 *
        Math.abs(
          fine.result.history.at(-1).compliance -
            coarse.result.history.at(-1).compliance,
        )) /
      coarse.result.history.at(-1).compliance,
    densityCorrelation: pearson(coarse.result.density, projected),
    solidIoU: solidIoU(coarse.result.density, projected),
    checks: independence.checks.map(({ label }) => label),
  },
};
assert.deepEqual(coarse.settings, cantilever.settings);

if (process.argv.includes("--report")) {
  // The linked revision must contain the engine and benchmark code that ran.
  git(
    "diff",
    "--exit-code",
    "HEAD",
    "--",
    "engine",
    "examples/validation/topopt",
  );
  const record = {
    sourceRevision: git("rev-parse", "HEAD"),
    recordedAt: new Date().toISOString(),
    engine,
    execution:
      "Real WASM optimize_topology (SIMP, MMA, sensitivity filter) on the existing structured-hex benchmarks; normalized E = 1, ν = 0.3 and unit load",
    commands: [
      "node examples/validation/topopt/run.mjs",
      "cd web && bun theory/optimization/capture-evidence.mjs --report",
    ],
    ...measured,
  };
  writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Recorded topology-optimization evidence (${engine}).`);
} else {
  const record = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(
    record.engine,
    engine,
    "engine changed; review and re-record evidence",
  );
  // The engine is deterministic; compare the measured values tightly.
  const close = (actual, expected, key) =>
    assert.ok(
      Math.abs(actual - expected) <= 1e-9 * Math.max(Math.abs(expected), 1),
      `${key}: ${actual} != ${expected}`,
    );
  const compare = (actual, expected, path) => {
    if (typeof expected === "number") close(actual, expected, path);
    else if (expected !== null && typeof expected === "object")
      for (const key of Object.keys(expected))
        compare(actual[key], expected[key], `${path}.${key}`);
    else assert.equal(actual, expected, path);
  };
  compare(
    measured,
    { mbb: record.mbb, meshIndependence: record.meshIndependence },
    "record",
  );
  console.log(
    "MBB and cantilever mesh-independence optimizations match the record.",
  );
}
