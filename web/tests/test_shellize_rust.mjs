// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Rust shell idealisation (crates/kofem-shellize, KOF-297) against the
// TypeScript pipeline it replaces (src/lib/shellize/).
//
// Each case meshes a STEP file with the engine, then builds the mesh-time
// shell model twice — buildShellTransitionModel in TS and in Rust — and
// requires the same result: the same node pool, tets, shell facets and
// thicknesses, surface mesh, and coupling set (references, partners, kinds,
// weights, DOF masks). Index arrays must match exactly; coordinates and
// weights to 1e-9 relative. A case the TS pipeline refuses must be refused by
// Rust with the same message. The explicit coupled model (a stored mixed mesh
// with a declared tie) is compared the same way, tie reports included.
//
// Usage:  bash ../scripts/build-fem-wasm.sh && bun tests/test_shellize_rust.mjs
//         (from web/; the engine comes from scripts/fetch-wasm-engine.sh)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  loadEngine,
  meshStep,
  surfaceVertices,
} from "../../examples/shell-coupling/lib.mjs";
import {
  buildExplicitCoupledModel,
  buildCoupledModel,
  buildShellTransitionModel,
  couplingDofMasks,
  couplingMpcCodes,
  extractThinWallShells,
  shellWallTets,
  tieCouplingProblem,
} from "../src/lib/shellize.ts";

const here = dirname(fileURLToPath(import.meta.url));
const femPkg = join(here, "../src/wasm/fem");
const testFiles = join(here, "../../test_files");

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) console.log(`  [PASS] ${name}`);
  else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// First index where two integer arrays differ, or -1 when they are equal.
function firstDifference(left, right) {
  if (left.length !== right.length) return Math.min(left.length, right.length);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return i;
  return -1;
}

function sameIndices(name, ts, rust) {
  const at = firstDifference(Array.from(ts), Array.from(rust));
  check(
    `${name} identical (${ts.length})`,
    at < 0,
    at < 0
      ? ""
      : `lengths ${ts.length}/${rust.length}, first difference at ${at}: ${ts[at]} vs ${rust[at]}`,
  );
}

function sameValues(name, ts, rust) {
  if (ts.length !== rust.length) {
    check(name, false, `lengths ${ts.length}/${rust.length}`);
    return;
  }
  let worst = 0;
  for (let i = 0; i < ts.length; i++)
    worst = Math.max(
      worst,
      Math.abs(ts[i] - rust[i]) / Math.max(1, Math.abs(ts[i])),
    );
  check(
    `${name} within 1e-9 (${ts.length}, max ${worst.toExponential(1)})`,
    worst <= 1e-9,
  );
}

function sameCoupling(label, ts, rust) {
  sameIndices(`${label} coupling references`, ts.ref, rust.couplingRef);
  sameIndices(`${label} coupling offsets`, ts.offsets, rust.couplingOffsets);
  sameIndices(`${label} coupling partners`, ts.solid, rust.couplingSolid);
  sameIndices(
    `${label} coupling kinds`,
    couplingMpcCodes(ts),
    rust.couplingMpc,
  );
  sameIndices(
    `${label} coupling DOF masks`,
    couplingDofMasks(ts),
    rust.couplingDofMask,
  );
  sameValues(
    `${label} coupling weights`,
    ts.weights ?? ts.solid.map(() => 1),
    rust.couplingWeights,
  );
}

function outcome(build) {
  try {
    return { value: build() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const Module = await loadEngine();
const fem = await import(join(femPkg, "kofem_wasm.js"));
fem.initSync({ module: readFileSync(join(femPkg, "kofem_wasm_bg.wasm")) });

const CASES = [
  { step: "crane_holder_only.step", size: 6 },
  { step: "single_fin.step", size: 4 },
  { step: "fin_two_parts.step", size: 6 },
  { step: "I_beam.step", size: 10 },
  { step: "full-crane-hook.step", size: 6 },
  { step: "Wall Bracket.stp", size: 6 },
];

const MAX_WALL = 15;
const meshes = new Map();

for (const { step, size } of CASES) {
  console.log(`\n${step} (max element size ${size} mm)`);
  const meshed = meshStep(Module, join(testFiles, step), {
    maxElementSize: size,
  });
  // Plain arrays, as the app's buildShellizeMesh passes them: the engine hands
  // back the surface mesh as Int32Arrays, and on those the TS clipper's
  // `nodes.map(distance)` would truncate plane distances to integers.
  const mesh = {
    ...meshed,
    surfTri: Array.from(meshed.surfTri),
    surfFace: Array.from(meshed.surfFace),
  };
  meshes.set(step, mesh);
  console.log(
    `  mesh: ${mesh.V.length / 3} vertices, ${mesh.tet.length / 4} tets, ` +
      `${mesh.surfFace.length} surface triangles`,
  );
  // The body the app would shell: the largest wall's, as with no choice made.
  const shellBody = extractThinWallShells(mesh).shellBody;
  if (shellBody < 0) {
    console.log("  no thin wall in TS — Rust must find none either");
    const rust = fem.buildShellTransitionModel(
      Float64Array.from(mesh.V),
      Uint32Array.from(mesh.tet),
      Int32Array.from(mesh.body),
      Uint32Array.from(mesh.surfTri),
      Int32Array.from(mesh.surfFace),
      Int32Array.from([...new Set(mesh.body)]),
      MAX_WALL,
    );
    check("Rust finds no thin wall", rust === undefined);
    continue;
  }

  const startTs = performance.now();
  const ts = outcome(() => {
    const shells = extractThinWallShells(mesh, {
      maxWall: MAX_WALL,
      shellBodyIds: new Set([shellBody]),
    });
    // buildShellTransitionModel clips `shells` in place; keep the result.
    const transition = buildShellTransitionModel(mesh, shells);
    return { shells, ...transition };
  });
  const tsSeconds = (performance.now() - startTs) / 1000;
  const startRust = performance.now();
  const rust = outcome(() =>
    fem.buildShellTransitionModel(
      Float64Array.from(mesh.V),
      Uint32Array.from(mesh.tet),
      Int32Array.from(mesh.body),
      Uint32Array.from(mesh.surfTri),
      Int32Array.from(mesh.surfFace),
      Int32Array.from([shellBody]),
      MAX_WALL,
    ),
  );
  const rustSeconds = (performance.now() - startRust) / 1000;
  console.log(
    `  shell body ${shellBody}: TS ${tsSeconds.toFixed(2)} s, Rust ${rustSeconds.toFixed(2)} s`,
  );

  if (ts.error !== undefined) {
    console.log(`  TS refuses: ${ts.error}`);
    check(
      "Rust refuses with the same message",
      rust.error === ts.error,
      rust.error,
    );
    continue;
  }
  if (rust.error !== undefined || rust.value === undefined) {
    check("Rust builds the model", false, rust.error ?? "no thin wall found");
    continue;
  }
  const { shells, mesh: clipped, model } = ts.value;
  const result = rust.value;
  check("same shell body", result.shellBody === shells.shellBody);
  check("same wall count", result.wallCount === shells.walls.length);
  sameValues("pool coordinates", model.pool, result.pool);
  sameIndices("solid tets", model.tets, result.tets);
  sameIndices("tet bodies", model.tetBody, result.tetBody);
  sameIndices("shell facets", model.triangles, result.triangles);
  sameValues("shell thicknesses", model.thicknesses, result.thicknesses);
  sameIndices("shell pool", model.shellPool, result.shellPool);
  sameIndices(
    "solid pool vertices",
    [...model.solidPool.keys()],
    result.solidPoolVertices,
  );
  sameIndices(
    "solid pool indices",
    [...model.solidPool.values()],
    result.solidPoolIndices,
  );
  sameValues("shell vertices", shells.shellVerts, result.shellVertices);
  sameIndices("shell node sources", shells.shellSrc, result.shellNodeSource);
  sameIndices(
    "shell facet sources",
    shells.shellTriSrc,
    result.shellTriangleSource,
  );
  sameIndices("surface triangles", clipped.surfTri, result.surfaceTriangles);
  sameIndices("surface faces", clipped.surfFace, result.surfaceFaces);
  sameCoupling("mesh-time", model.coupling, result);
  console.log(
    `  ${model.shellPool.length} shell nodes, ${model.triangles.length / 3} facets, ` +
      `${model.tets.length / 4} solid tets, ${model.coupling.ref.length} couplings`,
  );
}

// ── Explicit mixed model with a declared tie (the crane hook's pin/eye) ──────
// The mixed mesh of the crane showcase (examples/shell-coupling): the holder's
// wall tets become shells and its base stays solid. Rebuild the couplings from
// the explicit elements, with the pin/eye tie the showcase declares.
{
  console.log(
    "\nfull-crane-hook.step — explicit mixed model with the pin/eye tie",
  );
  const mesh = meshes.get("full-crane-hook.step");
  const shells = extractThinWallShells(mesh, { maxWall: MAX_WALL });
  const model = buildCoupledModel(mesh, shells, shellWallTets(mesh, shells));
  const { byBody, byFace } = surfaceVertices(mesh);
  const toPool = (vertices) =>
    [...vertices].flatMap((vertex) => {
      const index = model.solidPool.get(vertex);
      return index === undefined ? [] : [index];
    });
  const ties = [
    {
      name: "pin/eye",
      verticesA: toPool(byBody.get(2)),
      verticesB: toPool(byFace.get(65)),
      maxSeparation: 3.0,
    },
    // A tie whose surface B has no node in the pool: both sides must report
    // the same drop and sentence.
    {
      name: "empty side",
      verticesA: toPool(byBody.get(2)),
      verticesB: [],
      maxSeparation: 3.0,
    },
  ];
  const ts = buildExplicitCoupledModel(
    model.pool,
    model.tets,
    model.triangles,
    model.thicknesses,
    { ties },
  );
  const offsets = (lists) => {
    const out = [0];
    for (const list of lists) out.push(out[out.length - 1] + list.length);
    return Uint32Array.from(out);
  };
  const rust = fem.buildExplicitCoupledModel(
    Float64Array.from(model.pool),
    Uint32Array.from(model.tets),
    Uint32Array.from(model.triangles),
    Float64Array.from(model.thicknesses),
    ties.map((tie) => tie.name),
    Uint32Array.from(ties.flatMap((tie) => tie.verticesA)),
    offsets(ties.map((tie) => tie.verticesA)),
    Uint32Array.from(ties.flatMap((tie) => tie.verticesB)),
    offsets(ties.map((tie) => tie.verticesB)),
    Float64Array.from(ties.map((tie) => tie.maxSeparation)),
    new Uint32Array(0),
  );
  sameValues("explicit pool coordinates", ts.pool, rust.pool);
  sameIndices("explicit tets", ts.tets, rust.tets);
  sameIndices("explicit facets", ts.triangles, rust.triangles);
  sameIndices(
    "explicit shell pool indices",
    [...ts.shellPoolIndex],
    rust.shellPoolIndex,
  );
  sameIndices(
    "explicit pool of vertex",
    [...ts.poolOfVertex.values()],
    rust.poolOfVertexValues,
  );
  sameCoupling("explicit", ts.coupling, rust);
  sameIndices(
    "tie coupled counts",
    ts.tieReports.map((report) => report.nCoupled),
    rust.tieCoupled,
  );
  sameIndices(
    "tie partner counts",
    ts.tieReports.map((report) => report.nPartners),
    rust.tiePartners,
  );
  sameValues(
    "tie gaps",
    ts.tieReports.map((report) => report.gap),
    rust.tieGap,
  );
  const tsProblems = ts.tieReports.map(
    (report) => tieCouplingProblem(report) ?? "",
  );
  check(
    "tie problem sentences identical",
    JSON.stringify(tsProblems) === JSON.stringify(rust.tieProblems),
    `${JSON.stringify(tsProblems)} vs ${JSON.stringify(rust.tieProblems)}`,
  );
  check(
    "the empty tie reports why it coupled nothing",
    rust.tieProblems[1].includes("picked surface B has no node"),
    rust.tieProblems[1],
  );
}

console.log(
  failures === 0
    ? "\nRust shellize matches the TS pipeline."
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
