// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Solve times of the all-solid solve, MFEM (Gauss–Seidel CG) against the Rust
// module with AMG and with Gauss–Seidel, on Netgen meshes of the STEP files in
// test_files/. A benchmark, not a test: it prints one table and checks only
// that the three solvers agree.
//
// Load case (the KOF-300 sweep): clamp the vertices in the first 2 % of the
// longest axis, and pull the last 2 % along the shortest axis with 1 kN in
// total, steel. The app's own builders make both solvers' inputs
// (buildSolidEngineInputs for MFEM, solveSolidInRust for Rust AMG). Each
// solver stops at a relative tolerance of 1e-6: MFEM in its preconditioned
// norm, Rust on the force residual ‖f − K·u‖/‖f‖ (crates/kofem-fem/src/cg.rs).
// Times include assembly and preconditioner setup; meshing is excluded.
//
// Usage (from web/):
//   bun tests/bench_solid_solvers.mjs "<step file>:<element size>:<order>" ...
// e.g. bun tests/bench_solid_solvers.mjs "Wall Bracket.stp:20:1" "Wall Bracket.stp:20:2"
// Set BENCH_SKIP=mfem,rust-gs to leave solvers out (the slow ones on big models),
// and BENCH_BUDGET=<iterations> to stop each solve there (default 200000); a
// solve that stops unconverged is reported with its time and iterations.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { buildVertexIndexer } from "../src/lib/solveMeshPacking.ts";
import { buildSolidEngineInputs } from "../src/lib/solve/solid.ts";
import { solveSolidInRust } from "../src/lib/solve/amg.ts";
import { loadFemModule } from "../src/lib/femModule.ts";
import {
  ElasticModel,
  SolveOptions,
  Ties,
} from "../src/wasm/fem/kofem_wasm.js";

const here = dirname(fileURLToPath(import.meta.url));
const enginePkg = join(here, "../src/wasm/pkg");
const { default: createModule } = await import(
  join(enginePkg, "kofem_wasm_emcc.js")
);
const wasmBinary = readFileSync(join(enginePkg, "kofem_wasm_emcc.wasm")).buffer;
await loadFemModule();
const fem = { ElasticModel, SolveOptions, Ties };

const cases = process.argv.slice(2);
if (cases.length === 0)
  throw new Error('usage: bench_solid_solvers.mjs "<step>:<size>:<order>" ...');
const skip = new Set(
  (process.env.BENCH_SKIP ?? "").split(",").filter((name) => name !== ""),
);
const TOLERANCE = 1e-6;
const BUDGET = Number(process.env.BENCH_BUDGET ?? "200000");
if (!Number.isSafeInteger(BUDGET) || BUDGET <= 0)
  throw new Error(`BENCH_BUDGET must be a positive integer, got ${BUDGET}`);

async function meshModel(file, size) {
  const lines = [];
  const mesher = await createModule({
    wasmBinary,
    print: (line) => lines.push(line),
    printErr: (line) => lines.push(line),
  });
  mesher.tessellate_step(
    new Uint8Array(readFileSync(join(here, "../../test_files", file))),
    JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
  );
  const mesh = mesher.generate_fem_mesh(
    JSON.stringify({
      max_element_size: size,
      min_element_size: size / 10,
      grading: 0.3,
      second_order: false,
      elementsperedge: 2.0,
      elementspercurve: 2.0,
      optsteps_2d: 3,
      optsteps_3d: 3,
    }),
  );
  if (!mesh.vertices) throw new Error(`meshing ${file} failed`);
  const nodes = Array.from({ length: mesh.vertices.length / 3 }, (_, i) => ({
    id: i,
    x: mesh.vertices[3 * i],
    y: mesh.vertices[3 * i + 1],
    z: mesh.vertices[3 * i + 2],
  }));
  const elements = Array.from(
    { length: mesh.tetrahedra.length / 4 },
    (_, e) => ({
      id: e,
      type: "CTETRA",
      nodeIds: Array.from(mesh.tetrahedra.subarray(4 * e, 4 * e + 4)),
      propertyId: 1,
    }),
  );
  const used = new Set(elements.flatMap((element) => element.nodeIds));
  const coordinate = (node, axis) => [node.x, node.y, node.z][axis];
  const low = [0, 1, 2].map((axis) =>
    Math.min(...nodes.map((node) => coordinate(node, axis))),
  );
  const high = [0, 1, 2].map((axis) =>
    Math.max(...nodes.map((node) => coordinate(node, axis))),
  );
  const extent = [0, 1, 2].map((axis) => high[axis] - low[axis]);
  const longest = extent.indexOf(Math.max(...extent));
  const shortest = extent.indexOf(Math.min(...extent));
  const along = (node) =>
    (coordinate(node, longest) - low[longest]) / extent[longest];
  const clamped = nodes.filter(
    (node) => used.has(node.id) && along(node) <= 0.02,
  );
  const pulled = nodes.filter(
    (node) => used.has(node.id) && along(node) >= 0.98,
  );
  return {
    nodes,
    elements,
    materials: [
      { id: 1, name: "Steel", young: 210000, poisson: 0.3, density: 7.85e-9 },
    ],
    properties: [{ id: 1, materialId: 1 }],
    constraints: clamped.flatMap((node) =>
      [0, 1, 2].map((dof) => ({ nodeId: node.id, dof })),
    ),
    loads: pulled.map((node) => ({
      nodeId: node.id,
      dof: shortest,
      value: 1000 / pulled.length,
    })),
    surfaceLoads: [],
  };
}

// Lines the MFEM engine prints, read back for its CG iteration count.
const mfemLog = [];

function solveMfem(model, order) {
  return createModule({
    wasmBinary,
    print: (line) => mfemLog.push(line),
    printErr: (line) => mfemLog.push(line),
    // The budget is the engine's cap; stop there rather than ask.
    onCgLimit: async () => 0,
  }).then((engine) => {
    engine.cgIterationLimit = BUDGET;
    const vid = buildVertexIndexer(model.nodes);
    const inputs = buildSolidEngineInputs(model, vid);
    const started = performance.now();
    const raw = engine.solve_linear_elastic(
      inputs.mesh,
      inputs.matJson,
      inputs.bcsJson,
      order,
    );
    const seconds = (performance.now() - started) / 1000;
    if ("error" in raw) throw new Error(`MFEM: ${raw.error}`);
    const iterations = mfemLog
      .map((line) => /(\d+)\s+iterations/.exec(line))
      .filter((match) => match !== null)
      .map((match) => Number(match[1]))
      .pop();
    return { displacements: raw.displacements, seconds, iterations };
  });
}

async function solveRust(model, order, preconditioner) {
  const vid = buildVertexIndexer(model.nodes);
  const lines = [];
  const started = performance.now();
  if (preconditioner === "amg") {
    const result = await solveSolidInRust(
      fem,
      model,
      order,
      "amg",
      vid,
      vid,
      BUDGET,
      () => {
        throw new Error("budget reached");
      },
      (line) => lines.push(line),
    );
    const seconds = (performance.now() - started) / 1000;
    const converged = lines.find((line) => line.startsWith("AMG CG converged"));
    const levels = lines.find((line) =>
      line.startsWith("AMG preconditioner ready"),
    );
    return {
      displacements: result.displacements,
      seconds,
      iterations: Number(/(\d+) iterations/.exec(converged)[1]),
      detail: levels,
    };
  }
  // Rust Gauss–Seidel: the same model, solved directly through the module.
  const { packSolveMesh, groupDirichlet, groupPointLoads } =
    await import("../src/lib/solveMeshPacking.ts");
  const mesh = packSolveMesh(model.nodes, model.elements, [], vid);
  const elastic = new ElasticModel(
    mesh.vertices,
    Uint32Array.from(mesh.tetrahedra),
    new Uint32Array(0),
    new Uint32Array(model.elements.length),
    Float64Array.of(210000, 0.3),
    order,
  );
  elastic.assemble();
  const { fixed_vertices } = groupDirichlet(model.constraints, vid);
  const fixed = Uint32Array.from(
    fixed_vertices.flatMap((vertex) => [0, 1, 2].map((c) => 3 * vertex + c)),
  );
  const forces = new Float64Array(elastic.dofCount);
  for (const { vertex, force } of groupPointLoads(model.loads, vid))
    for (let c = 0; c < 3; c++) forces[3 * vertex + c] += force[c];
  const options = new SolveOptions(
    TOLERANCE,
    BUDGET,
    "gauss-seidel",
    "residual",
  );
  const solution = elastic.solve(
    fixed,
    new Float64Array(fixed.length),
    forces,
    options,
  );
  const seconds = (performance.now() - started) / 1000;
  const result = {
    displacements: solution.displacements.slice(0, 3 * elastic.vertexCount),
    seconds,
    iterations: solution.iterations,
  };
  solution.free();
  options.free();
  elastic.free();
  return result;
}

function relativeDifference(reference, other) {
  let peak = 0;
  let difference = 0;
  for (let i = 0; i < reference.length; i++) {
    peak = Math.max(peak, Math.abs(reference[i]));
    difference = Math.max(difference, Math.abs(reference[i] - other[i]));
  }
  return difference / peak;
}

const rows = [];
for (const spec of cases) {
  const [file, sizeText, orderText] = spec.split(":");
  const size = Number(sizeText);
  const order = Number(orderText);
  const meshStarted = performance.now();
  const model = await meshModel(file, size);
  const meshSeconds = (performance.now() - meshStarted) / 1000;
  // Vertices plus, at order 2, one node per distinct edge.
  const edges = new Set();
  if (order === 2)
    for (const element of model.elements)
      for (const [a, b] of [
        [0, 1],
        [0, 2],
        [0, 3],
        [1, 2],
        [1, 3],
        [2, 3],
      ]) {
        const [lo, hi] = [element.nodeIds[a], element.nodeIds[b]].sort(
          (x, y) => x - y,
        );
        edges.add(lo * 4294967296 + hi);
      }
  const dofs = 3 * (model.nodes.length + edges.size);
  console.log(
    `\n${file} @ ${size} mm, order ${order}: ${model.nodes.length} vertices, ` +
      `${model.elements.length} tets, ${dofs} DOF (meshed in ${meshSeconds.toFixed(1)} s)`,
  );
  const results = {};
  for (const [name, run] of [
    ["rust-amg", () => solveRust(model, order, "amg")],
    ["rust-gs", () => solveRust(model, order, "gauss-seidel")],
    ["mfem", () => solveMfem(model, order)],
  ]) {
    if (skip.has(name)) continue;
    mfemLog.length = 0;
    const started = performance.now();
    try {
      results[name] = await run();
    } catch (error) {
      const seconds = (performance.now() - started) / 1000;
      const iterations = mfemLog
        .map((line) => /CG iteration\s+(\d+)/.exec(line))
        .filter((match) => match !== null)
        .map((match) => Number(match[1]))
        .pop();
      console.log(
        `  ${name.padEnd(9)} stopped after ${seconds.toFixed(2)} s${iterations ? ` (${iterations} iterations)` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      );
      results[name] = {
        failed: true,
        seconds,
        iterations: iterations ?? BUDGET,
      };
      continue;
    }
    const { seconds, iterations, detail } = results[name];
    console.log(
      `  ${name.padEnd(9)} ${seconds.toFixed(2).padStart(8)} s, ${iterations} CG iterations${detail ? ` (${detail})` : ""}`,
    );
  }
  const solved = (name) =>
    results[name] && !results[name].failed ? results[name] : undefined;
  const reference = solved("mfem") ?? solved("rust-gs");
  for (const name of ["rust-amg", "rust-gs"])
    if (solved(name) && reference && results[name] !== reference)
      console.log(
        `  ${name} against ${solved("mfem") ? "mfem" : "rust-gs"}: max |Δu| / max |u| ${relativeDifference(
          reference.displacements,
          results[name].displacements,
        ).toExponential(2)}`,
      );
  rows.push({ spec, dofs, results });
}

console.log(
  "\n| Model | DOF | MFEM GS | Rust GS | Rust AMG |\n| -- | -- | -- | -- | -- |",
);
for (const { spec, dofs, results } of rows) {
  const cell = (name) =>
    results[name]
      ? `${results[name].failed ? "> " : ""}${results[name].seconds.toFixed(1)} s (${results[name].iterations} it.${results[name].failed ? ", stopped" : ""})`
      : "—";
  console.log(
    `| ${spec} | ${dofs} | ${cell("mfem")} | ${cell("rust-gs")} | ${cell("rust-amg")} |`,
  );
}
