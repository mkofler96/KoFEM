// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Rust mixed solid + shell solve (crates/kofem-fem prepare_mixed_static,
// KOF-308) against the C++ engine's solve_coupled, which stays the oracle
// until MFEM leaves the build. Both take the SAME { mesh, coupling, bcs,
// matJson } arguments; the Rust side runs through solveCoupledInRust, the
// function the solver worker calls. Displacements and von Mises stresses
// (solid tets and shell facets) must agree to the solvers' tolerance.
//
// Models:
//   - a hand-mixed store model built by buildCoupledEngineInputs: a block of
//     two solid materials (per-body) with an explicit CTRIA3 wall standing on
//     it, a clamp, a prescribed displacement, point forces, a moment on a
//     shell node, a pressure on the block and a kinematic reference-point
//     coupling loaded by a moment;
//   - the KOF-215 planar transition study (fixtures/shell-junction.mjs, the
//     model of engine/tests/shell_solid_footprint_study.cpp): a 2 mm wall on
//     a block, cut into a retained solid section and a shell, tied by shell
//     footprint couplings, loaded in its plane along z and x — also checked
//     against the all-solid reference of test_shell_footprint.mjs;
//   - test_files/fin_two_parts.step with the fin marked Shell, idealised at
//     mesh time (the stored CTRIA3 + CTETRA model) and at solve time
//     (prepareAutoCoupledSolve), as the worker solves both;
//   - the crane-holder shell showcase (examples/shell-coupling): the thin
//     holder as shells, tied to the solid pin and hook;
//   - every preconditioner of the Rust solve on one model, and payloads both
//     must refuse.
//
// Usage:  bash ../scripts/build-fem-wasm.sh && bun tests/test_coupled_rust.mjs
//         (from web/; the C++ engine comes from scripts/fetch-wasm-engine.sh)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { loadFemModule } from "../src/lib/femModule.ts";
import {
  buildCoupledEngineInputs,
  mapMixedResult,
} from "../src/lib/solve/coupled.ts";
import { solveCoupledInRust } from "../src/lib/solve/coupledRust.ts";
import {
  buildMeshTimeShellModel,
  prepareAutoCoupledSolve,
} from "../src/lib/solve/autoShell.ts";
import {
  buildExplicitCoupledModel,
  buildShellTransitionModel,
  couplingMpcCodes,
  extractThinWallShells,
} from "../src/lib/shellize.ts";
import { Couplings, MixedModel } from "../src/wasm/fem/kofem_wasm.js";
import { shellJunction } from "./fixtures/shell-junction.mjs";
import {
  buildCoupledModel as buildCraneModel,
  dropCouplingsOnFixedNodes as dropCraneCouplings,
  extractThinWallShells as extractCraneShells,
  meshStep,
  shellWallTets,
  surfaceVertices,
} from "../../examples/shell-coupling/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const enginePkg = join(here, "../src/wasm/pkg");

// The shell idealisation and the mixed solve run in the Rust module.
await loadFemModule();
const fem = { MixedModel, Couplings };
const { default: createModule } = await import(
  join(enginePkg, "kofem_wasm_emcc.js")
);
const silent = () => undefined;
const engine = await createModule({
  wasmBinary: readFileSync(join(enginePkg, "kofem_wasm_emcc.wasm")).buffer,
  print: silent,
  printErr: silent,
});

let failures = 0;
function check(name, condition, detail = "") {
  console.log(
    `  [${condition ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!condition) failures++;
}

const neverAsk = () => {
  throw new Error("the CG budget ran out — no continuation in this test");
};

const maxDifference = (lhs, rhs) => {
  let peak = 0;
  let difference = 0;
  for (let i = 0; i < lhs.length; i++) {
    peak = Math.max(peak, Math.abs(lhs[i]));
    difference = Math.max(difference, Math.abs(lhs[i] - rhs[i]));
  }
  return { peak, relative: peak > 0 ? difference / peak : difference };
};

// Solve one argument set with C++ and with Rust; compare and report.
// Returns both raw results (the C++ one first), or null when one failed.
async function compare(label, args, { preconditioner = "amg" } = {}) {
  console.log(`\n${label}`);
  let started = performance.now();
  const cpp = engine.solve_coupled(
    args.mesh,
    args.coupling,
    args.bcs,
    args.matJson,
  );
  const cppSeconds = (performance.now() - started) / 1000;
  if ("error" in cpp) {
    check("C++ solves the model", false, cpp.error);
    return null;
  }
  const lines = [];
  started = performance.now();
  let rust;
  try {
    rust = await solveCoupledInRust(
      fem,
      args,
      preconditioner,
      undefined,
      neverAsk,
      (line) => lines.push(line),
    );
  } catch (error) {
    check("Rust solves the model", false, String(error));
    return null;
  }
  const rustSeconds = (performance.now() - started) / 1000;
  for (const line of lines) console.log(`    ${line}`);
  const displacement = maxDifference(cpp.displacements, rust.displacements);
  const solidStress = maxDifference(cpp.von_mises_tets, rust.von_mises_tets);
  const shellStress = maxDifference(cpp.von_mises_tris, rust.von_mises_tris);
  console.log(
    `    max |u| ${displacement.peak.toExponential(4)}, Rust − C++ ${displacement.relative.toExponential(2)}; ` +
      `max solid vM ${solidStress.peak.toExponential(4)}, Rust − C++ ${solidStress.relative.toExponential(2)}; ` +
      `max shell vM ${shellStress.peak.toExponential(4)}, Rust − C++ ${shellStress.relative.toExponential(2)}; ` +
      `C++ ${cppSeconds.toFixed(2)} s (${cpp.iterations} it), Rust ${rustSeconds.toFixed(2)} s (${rust.iterations} it, ${preconditioner})`,
  );
  check(
    "the same number of results",
    cpp.displacements.length === rust.displacements.length &&
      cpp.von_mises_tets.length === rust.von_mises_tets.length &&
      cpp.von_mises_tris.length === rust.von_mises_tris.length,
  );
  // Both stop on a 1e-10 relative force residual; the fields must agree to
  // well within what that leaves.
  check(
    "displacements agree",
    displacement.peak > 0 && displacement.relative < 1e-6,
    `${displacement.relative}`,
  );
  check(
    "solid von Mises stresses agree",
    solidStress.relative < 1e-5,
    `${solidStress.relative}`,
  );
  check(
    "shell von Mises stresses agree",
    shellStress.relative < 1e-5,
    `${shellStress.relative}`,
  );
  return { cpp, rust };
}

const STEEL = {
  id: 1,
  name: "Steel",
  young: 210000,
  poisson: 0.3,
  density: 7.85e-9,
};
const ALUMINIUM = {
  id: 2,
  name: "Aluminium",
  young: 70000,
  poisson: 0.33,
  density: 2.7e-9,
};

const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];
const near = (lhs, rhs) => Math.abs(lhs - rhs) < 1e-6;

// ── 1. A hand-mixed store model ──────────────────────────────────────────────
// Block [0, 40]×[0, 20]×[0, 10] of Kuhn tets (5 mm cells), steel for x < 20
// (body 1) and aluminium beyond (body 2), with a 2 mm CTRIA3 wall (body 3) on
// its top along y = 10, x ∈ [0, 40], z ∈ [10, 40]. The wall's bottom edge
// coincides with block nodes; the builder ties it to the block.
function handMixedModel() {
  const nodes = [];
  const elements = [];
  const index = new Map();
  const node = (x, y, z) => {
    const key = `${x},${y},${z}`;
    let id = index.get(key);
    if (id === undefined) {
      id = nodes.length + 1;
      index.set(key, id);
      nodes.push({ id, x, y, z });
    }
    return id;
  };
  const cell = 5;
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 4; j++)
      for (let k = 0; k < 2; k++) {
        const corner = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) =>
          node(
            cell * (i + (bits & 1)),
            cell * (j + ((bits >> 1) & 1)),
            cell * (k + ((bits >> 2) & 1)),
          ),
        );
        for (const tet of KUHN)
          elements.push({
            id: elements.length + 1,
            type: "CTETRA",
            nodeIds: tet.map((c) => corner[c]),
            propertyId: i < 4 ? 1 : 2,
          });
      }
  // Wall nodes are their own (not merged with the block's): the coupled
  // builder joins the two domains.
  const wallIds = new Set();
  const wall = (i, k) => {
    const key = `wall ${i},${k}`;
    let id = index.get(key);
    if (id === undefined) {
      id = nodes.length + 1;
      index.set(key, id);
      wallIds.add(id);
      nodes.push({ id, x: cell * i, y: 10, z: 10 + cell * k });
    }
    return id;
  };
  for (let i = 0; i < 8; i++)
    for (let k = 0; k < 6; k++) {
      const quad = [
        wall(i, k),
        wall(i + 1, k),
        wall(i + 1, k + 1),
        wall(i, k + 1),
      ];
      for (const tri of [
        [0, 1, 2],
        [0, 2, 3],
      ])
        elements.push({
          id: elements.length + 1,
          type: "CTRIA3",
          nodeIds: tri.map((c) => quad[c]),
          propertyId: 3,
        });
    }
  const reference = nodes.length + 1;
  nodes.push({ id: reference, x: 45, y: 10, z: 5 });
  const ids = (predicate) =>
    nodes
      .filter((n) => n.id !== reference && !wallIds.has(n.id) && predicate(n))
      .map((n) => n.id);
  const constraints = ids((n) => near(n.z, 0) && n.x <= 20).flatMap((nodeId) =>
    [0, 1, 2].map((dof) => ({ nodeId, dof })),
  );
  const drive = ids((n) => near(n.x, 35) && near(n.y, 0) && near(n.z, 0))[0];
  constraints.push({ nodeId: drive, dof: 2, prescribedValue: -0.002 });
  const wallTop = [...wallIds].filter((id) => near(nodes[id - 1].z, 40));
  const loads = [
    ...wallTop.map((nodeId) => ({
      nodeId,
      dof: 1,
      value: 50 / wallTop.length,
    })),
    ...wallTop.map((nodeId) => ({
      nodeId,
      dof: 0,
      value: 120 / wallTop.length,
    })),
    { nodeId: wallTop[0], dof: 3, value: 200 },
    { nodeId: reference, dof: 3, value: 5000 },
  ];
  // Pressure on the block's +y face.
  const pressureFaces = [];
  for (const element of elements) {
    if (element.type !== "CTETRA") continue;
    for (const face of [
      [0, 1, 2],
      [0, 1, 3],
      [0, 2, 3],
      [1, 2, 3],
    ]) {
      const faceIds = face.map((c) => element.nodeIds[c]);
      if (faceIds.every((id) => near(nodes[id - 1].y, 20)))
        pressureFaces.push(faceIds);
    }
  }
  const endFace = ids((n) => near(n.x, 40));
  return {
    nodes,
    elements,
    materials: [STEEL, ALUMINIUM],
    properties: [
      { id: 1, materialId: 1 },
      { id: 2, materialId: 2 },
      { id: 3, materialId: 1, thickness: 2, discretization: "shell" },
    ],
    constraints,
    loads,
    surfaceLoads: [{ type: "pressure", faces: pressureFaces, pressure: 1.5 }],
    couplings: [
      {
        name: "End",
        kind: "kinematic",
        dofs: [0, 1, 2, 3, 4, 5],
        refNodeId: reference,
        faces: [{ nodeIds: endFace }],
      },
    ],
    tieGroups: [],
  };
}

{
  const model = handMixedModel();
  const lines = [];
  const inputs = buildCoupledEngineInputs(model, (line) => lines.push(line));
  const codes = couplingMpcCodes({
    ref: Array.from(inputs.coupling.ref),
    mpc: Array.from(inputs.coupling.mpc),
  });
  console.log(
    `\nhand-mixed model: ${inputs.mesh.tets.length / 4} tets, ${inputs.mesh.triangles.length / 3} facets, ` +
      `coupling kinds ${JSON.stringify([...new Set(codes)].sort())}`,
  );
  const both = await compare(
    "Hand-mixed block + wall: two solid materials, clamp, drive, forces, moments, pressure, RBE2",
    inputs,
  );
  if (both) {
    const mapped = mapMixedResult(model, inputs.model, both.rust);
    check(
      "the result maps onto every store node and element",
      mapped.displacements.length === 3 * model.nodes.length &&
        mapped.vonMises.length === model.elements.length &&
        mapped.vonMises.every(Number.isFinite),
    );
    // Per-body materials: the same model with one solid material must
    // differ — the attributes reach the Rust solid.
    const single = {
      ...model,
      properties: model.properties.map((p) => ({ ...p, materialId: 1 })),
    };
    const singleInputs = buildCoupledEngineInputs(single, () => undefined);
    const steelOnly = await solveCoupledInRust(
      fem,
      singleInputs,
      "amg",
      undefined,
      neverAsk,
      () => undefined,
    );
    const softer = maxDifference(
      steelOnly.displacements,
      both.rust.displacements,
    );
    check(
      "per-body solid materials change the result",
      softer.relative > 1e-2,
      `${softer.relative}`,
    );
  }
}

// ── 2. The KOF-215 planar transition study ───────────────────────────────────
// The arguments of test_shell_footprint.mjs: the junction fixture, its wall
// cut into a retained solid section (refinement 2, wall rows of `wallStep`
// mm) and a shell tied by footprint couplings; clamp z = 0, load the wall top
// in its plane along `axis`. Two solid materials (wall body, block body).
function junctionArgs(candidate, axis) {
  const point = (index) => candidate.pool.slice(3 * index, 3 * index + 3);
  const fixed = [];
  const tips = [];
  for (let index = 0; index < candidate.pool.length / 3; index++) {
    if (Math.abs(point(index)[2]) < 1e-8)
      for (let component = 0; component < 3; component++)
        fixed.push(6 * index + component);
    if (Math.abs(point(index)[2] - 36) < 1e-8) tips.push(index);
  }
  const weights = tips.map((index) => {
    const [coordX, coordY] = point(index);
    const along = near(coordX, 0) || near(coordX, 60) ? 0.5 : 1;
    const across = near(coordY, 19) || near(coordY, 21) ? 0.5 : 1;
    return along * across;
  });
  const sum = weights.reduce((total, value) => total + value, 0);
  return {
    tips,
    forces: weights.map((value) => (100 * value) / sum),
    args: {
      mesh: {
        vertices: Float64Array.from(candidate.pool),
        tets: Int32Array.from(candidate.tets),
        triangles: Int32Array.from(candidate.triangles),
        thicknesses: Float64Array.from(candidate.thicknesses),
        attributes: Int32Array.from(
          candidate.tetBody.map((body) => (body === 1 ? 1 : 2)),
        ),
      },
      coupling: {
        ref: Int32Array.from(candidate.coupling.ref),
        offsets: Int32Array.from(candidate.coupling.offsets),
        solid: Int32Array.from(candidate.coupling.solid),
        mpc: Int32Array.from(couplingMpcCodes(candidate.coupling)),
        dof_mask: Int32Array.from(candidate.coupling.ref.map(() => 0x3f)),
        weights: candidate.coupling.weights
          ? Float64Array.from(candidate.coupling.weights)
          : undefined,
        relaxation: 1,
      },
      bcs: {
        fixed_dofs: Int32Array.from(fixed),
        prescribed_dofs: new Int32Array(0),
        prescribed_vals: new Float64Array(0),
        load_dofs: Int32Array.from(tips.map((index) => 6 * index + axis)),
        load_vals: Float64Array.from(
          weights.map((value) => (100 * value) / sum),
        ),
      },
      matJson: JSON.stringify({
        solid: [
          { young_modulus: 210000, poisson_ratio: 0.3 },
          { young_modulus: 210000, poisson_ratio: 0.3 },
        ],
        shell: { young_modulus: 210000, poisson_ratio: 0.3 },
      }),
    },
  };
}

// Peak block stress and load-weighted tip displacement of a junction result.
function junctionMeasures(candidate, result, tips, forces, axis) {
  const block = candidate.tetBody.flatMap((body, index) =>
    body === 2 ? [result.von_mises_tets[index]] : [],
  );
  const tip = tips.reduce(
    (total, index, load) =>
      total + (forces[load] * result.displacements[3 * index + axis]) / 100,
    0,
  );
  return { peak: Math.max(...block), tip };
}

for (const wallStep of [3, 4]) {
  const original = shellJunction(2, wallStep);
  const shells = extractThinWallShells(original, {
    shellBodyIds: new Set([1]),
  });
  const { model: generated } = buildShellTransitionModel(original, shells);
  const candidate = buildExplicitCoupledModel(
    generated.pool,
    generated.tets,
    generated.triangles,
    generated.thicknesses,
  );
  candidate.tetBody = generated.tetBody;
  const reference = {
    pool: original.V,
    tets: original.tet,
    tetBody: original.body,
    triangles: [],
    thicknesses: [],
    coupling: { ref: [], offsets: [0], solid: [] },
  };
  for (const axis of [2, 0]) {
    const { args, tips, forces } = junctionArgs(candidate, axis);
    const both = await compare(
      `KOF-215 transition, wall rows ${wallStep} mm, load along ${"xyz"[axis]}`,
      args,
    );
    if (!both) continue;
    // The study's own measure: the mixed model against the all-solid mesh.
    const solidCase = junctionArgs(reference, axis);
    const solid = engine.solve_coupled(
      solidCase.args.mesh,
      solidCase.args.coupling,
      solidCase.args.bcs,
      solidCase.args.matJson,
    );
    const expected = junctionMeasures(
      reference,
      solid,
      solidCase.tips,
      solidCase.forces,
      axis,
    );
    const actual = junctionMeasures(candidate, both.rust, tips, forces, axis);
    console.log(
      `    Rust mixed / all-solid: junction peak ${(actual.peak / expected.peak).toFixed(4)}, ` +
        `tip ${(actual.tip / expected.tip).toFixed(4)}`,
    );
    check(
      "the Rust junction peak is within 1 % of the all-solid reference",
      Math.abs(actual.peak / expected.peak - 1) < 0.01,
    );
    check(
      "the Rust tip displacement is within 2 % of the all-solid reference",
      Math.abs(actual.tip / expected.tip - 1) < 0.02,
    );
  }
}

// ── 3. fin_two_parts.step, the fin marked Shell ──────────────────────────────
// A 2 mm fin (body 2) on a solid base block (body 1). Base bottom clamped,
// fin tip pushed out of plane and along it.
function finStoreModel() {
  const meshed = meshStep(
    engine,
    join(here, "../../test_files/fin_two_parts.step"),
    { maxElementSize: 4 },
  );
  const nodes = [];
  for (let i = 0; i < meshed.V.length / 3; i++)
    nodes.push({
      id: i + 1,
      x: meshed.V[3 * i],
      y: meshed.V[3 * i + 1],
      z: meshed.V[3 * i + 2],
    });
  const elements = [];
  for (let e = 0; e < meshed.tet.length / 4; e++)
    elements.push({
      id: e + 1,
      type: "CTETRA",
      nodeIds: meshed.tet.slice(4 * e, 4 * e + 4).map((vertex) => vertex + 1),
      propertyId: meshed.body[e],
    });
  const surfaceTriangles = [];
  for (let t = 0; t < meshed.surfTri.length / 3; t++)
    surfaceTriangles.push([0, 1, 2].map((k) => meshed.surfTri[3 * t + k] + 1));
  return {
    nodes,
    elements,
    surfaceTriangles,
    surfaceFaceIds: Array.from(meshed.surfFace),
  };
}

function finLoads(nodes) {
  const zs = nodes.map((n) => n.z);
  const bottom = Math.min(...zs);
  const top = Math.max(...zs);
  const constraints = nodes
    .filter((n) => near(n.z, bottom))
    .flatMap((n) => [0, 1, 2].map((dof) => ({ nodeId: n.id, dof })));
  const tip = nodes.filter((n) => Math.abs(n.z - top) < 0.5);
  const loads = tip.flatMap((n) => [
    { nodeId: n.id, dof: 1, value: 40 / tip.length },
    { nodeId: n.id, dof: 0, value: 100 / tip.length },
  ]);
  return { constraints, loads };
}

{
  const fin = finStoreModel();
  const properties = [
    { id: 1, materialId: 1, discretization: "solid" },
    { id: 2, materialId: 2, discretization: "shell" },
  ];
  console.log(
    `\nfin_two_parts.step: ${fin.nodes.length} nodes, ${fin.elements.length} tets`,
  );
  // Mesh time: the stored CTRIA3 + CTETRA model, solved as the worker's
  // mixed path does.
  const mixed = buildMeshTimeShellModel(
    fin.nodes,
    fin.elements,
    fin.surfaceTriangles,
    fin.surfaceFaceIds,
    new Set([2]),
    properties,
    () => undefined,
  );
  check("meshing idealises the fin", mixed !== null);
  if (mixed) {
    const model = {
      nodes: mixed.nodes,
      elements: mixed.elements,
      materials: [STEEL, ALUMINIUM],
      properties: mixed.properties,
      ...finLoads(mixed.nodes),
      surfaceLoads: [],
      couplings: [],
      tieGroups: [],
    };
    await compare(
      "fin_two_parts, idealised at mesh time (stored mixed model)",
      buildCoupledEngineInputs(model, () => undefined),
    );
  }
  // Solve time: the all-tet model with the fin marked Shell.
  const auto = prepareAutoCoupledSolve(
    {
      nodes: fin.nodes,
      elements: fin.elements,
      materials: [STEEL, ALUMINIUM],
      properties,
      ...finLoads(fin.nodes),
      surfaceLoads: [],
      couplings: [],
      tieGroups: [],
      surfaceTriangles: fin.surfaceTriangles,
      surfaceFaceIds: fin.surfaceFaceIds,
    },
    new Set([2]),
    () => undefined,
  );
  check("the solve-time idealisation applies", auto !== null);
  if (auto)
    await compare("fin_two_parts, idealised at solve time (auto-shell)", auto);
}

// ── 4. The crane-holder shell showcase ───────────────────────────────────────
// examples/shell-coupling/crane-holder-shell.mjs: the holder's thin walls as
// shells (relaxed MPC seams), the pin/eye clearance tied by distributing
// couplings, the mounting face clamped, two hook faces loaded.
{
  const mesh = meshStep(
    engine,
    join(here, "../../test_files/full-crane-hook.step"),
    { maxElementSize: 6 },
  );
  const shells = extractCraneShells(mesh);
  const wallTets = shellWallTets(mesh, shells);
  const { byBody, byFace } = surfaceVertices(mesh);
  const model = buildCraneModel(mesh, shells, wallTets, {
    ties: [
      {
        verticesA: [...byBody.get(2)],
        verticesB: [...byFace.get(65)],
        maxSeparation: 3.0,
      },
    ],
  });
  const fixedLocal = new Set();
  for (let t = 0; t < shells.shellTris.length / 3; t++)
    if (shells.shellTriSrc[t] === 7)
      for (let k = 0; k < 3; k++) fixedLocal.add(shells.shellTris[3 * t + k]);
  const fixed = [];
  for (const local of fixedLocal)
    for (let c = 0; c < 6; c++) fixed.push(6 * model.shellPool[local] + c);
  const loadNodes = new Map([
    [66, new Set()],
    [67, new Set()],
  ]);
  for (let t = 0; t < mesh.surfFace.length; t++) {
    const set = loadNodes.get(mesh.surfFace[t]);
    if (!set) continue;
    for (let k = 0; k < 3; k++) {
      const pool = model.solidPool.get(mesh.surfTri[3 * t + k]);
      if (pool !== undefined) set.add(pool);
    }
  }
  const loadDofs = [];
  const loadVals = [];
  for (const set of loadNodes.values())
    for (const pool of set) {
      loadDofs.push(6 * pool + 1);
      loadVals.push(-1000 / set.size);
    }
  const coupling = dropCraneCouplings(model.coupling, fixed);
  const steel = { young_modulus: 210000, poisson_ratio: 0.3 };
  await compare("Crane holder shell showcase", {
    mesh: {
      vertices: Float64Array.from(model.pool),
      tets: Int32Array.from(model.tets),
      triangles: Int32Array.from(model.triangles),
      thicknesses: Float64Array.from(model.thicknesses),
    },
    coupling: {
      ref: Int32Array.from(coupling.ref),
      offsets: Int32Array.from(coupling.offsets),
      solid: Int32Array.from(coupling.solid),
      mpc: Int32Array.from(coupling.mpc),
      dof_mask: Int32Array.from(coupling.ref.map(() => 0x3f)),
      relaxation: 1,
    },
    bcs: {
      fixed_dofs: Int32Array.from(fixed),
      prescribed_dofs: new Int32Array(0),
      prescribed_vals: new Float64Array(0),
      load_dofs: Int32Array.from(loadDofs),
      load_vals: Float64Array.from(loadVals),
    },
    matJson: JSON.stringify({ solid: steel, shell: steel }),
  });
}

// ── 5. Every preconditioner, and refusals ────────────────────────────────────
{
  const model = handMixedModel();
  const inputs = buildCoupledEngineInputs(model, () => undefined);
  for (const preconditioner of ["incomplete-cholesky", "gauss-seidel"])
    await compare(`Hand-mixed model with ${preconditioner}`, inputs, {
      preconditioner,
    });

  console.log("\nRefusals");
  const refuses = async (label, args, pattern) => {
    const cpp = engine.solve_coupled(
      args.mesh,
      args.coupling,
      args.bcs,
      args.matJson,
    );
    let message = "";
    try {
      await solveCoupledInRust(
        fem,
        args,
        "amg",
        undefined,
        neverAsk,
        () => undefined,
      );
    } catch (error) {
      message = String(error);
    }
    check(
      `${label}: both refuse`,
      "error" in cpp && pattern.test(message),
      `C++: ${"error" in cpp ? cpp.error : "solved"}; Rust: ${message || "solved"}`,
    );
  };
  // A support on a shell node that a seam coupling makes dependent.
  const seamReference =
    inputs.coupling.ref[Array.from(inputs.coupling.mpc).indexOf(1)];
  if (seamReference === undefined) {
    check("the hand-mixed model has a relaxed-MPC seam", false);
  } else {
    await refuses(
      "a support on a seam-dependent shell node",
      {
        ...inputs,
        bcs: {
          ...inputs.bcs,
          fixed_dofs: Int32Array.from([
            ...inputs.bcs.fixed_dofs,
            6 * seamReference,
          ]),
        },
      },
      /lies on a node that follows a coupling/,
    );
  }
  await refuses(
    "a material index outside the solid materials",
    {
      ...inputs,
      mesh: {
        ...inputs.mesh,
        attributes: Int32Array.from(inputs.mesh.attributes, () => 3),
      },
    },
    /selects solid material 3, outside 1\.\.2/,
  );
  await refuses(
    "an unknown coupling kind",
    {
      ...inputs,
      coupling: {
        ...inputs.coupling,
        mpc: Int32Array.from(inputs.coupling.mpc, () => 7),
      },
    },
    /unknown kind 7/,
  );
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll Rust-vs-C++ coupled checks passed.");
