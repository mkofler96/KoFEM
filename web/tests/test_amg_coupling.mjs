// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// All-solid models with surface-to-point couplings must give the same result
// through the Rust AMG solver as through the MFEM engine's coupled solve. Both
// read the SAME inputs, built by the app's own buildCoupledEngineInputs from a
// store-shaped model, exactly as the solver worker does.
//
// Cases: kinematic and distributing couplings loaded by forces and moments at
// the reference point, a fixed kinematic reference point (a bolted root), a
// rigid point-to-point connection between two separately meshed beams, a tie
// across a gap together with a coupling, and a Netgen mesh of the wall
// bracket — with two materials, prescribed displacements and surface loads
// along the way. Then what AMG refuses: a hinged point-to-point joint, which
// leaves a mechanism (the MFEM path's Gauss–Seidel CG still converges on it
// when the load does not excite the mechanism), and quadratic elements.
//
// Usage:  bash ../scripts/build-fem-wasm.sh && bun tests/test_amg_coupling.mjs
//         (from web/; the MFEM engine comes from scripts/fetch-wasm-engine.sh)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { loadFemModule } from "../src/lib/femModule.ts";
import {
  buildCoupledEngineInputs,
  mapMixedResult,
} from "../src/lib/solve/coupled.ts";
import {
  amgUnavailableReason,
  solveCoupledSolidWithAmg,
} from "../src/lib/solve/amg.ts";
import {
  Couplings,
  ElasticModel,
  SolveOptions,
} from "../src/wasm/fem/kofem_wasm.js";

const here = dirname(fileURLToPath(import.meta.url));
const enginePkg = join(here, "../src/wasm/pkg");

// The coupled model builder (shell idealisation) runs in the Rust module too.
await loadFemModule();
const { default: createModule } = await import(
  join(enginePkg, "kofem_wasm_emcc.js")
);
const wasmBinary = readFileSync(join(enginePkg, "kofem_wasm_emcc.wasm")).buffer;
const fem = { Couplings, ElasticModel, SolveOptions };
// Swallows the engine's console output; these tests print their own report.
const silent = () => undefined;
const quiet = () => ({ wasmBinary, print: silent, printErr: silent });
const engine = await createModule(quiet());

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const neverAsk = () => {
  throw new Error("the continuation prompt must not appear");
};

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
const MATERIALS = [STEEL, ALUMINIUM];
const PROPERTIES = [
  { id: 1, materialId: 1 },
  { id: 2, materialId: 2 },
];

// ── Fixtures ──────────────────────────────────────────────────────────────────

const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];

// Store-shaped box [x0, x0+L] × [0,h] × [0,h] of Kuhn tets, appended to
// `nodes`/`elements` with ids from `idBase`; tets whose first corner lies
// below `split` along x belong to body 1, the rest to body 2.
function addBeam(model, { x0, length, height, nx, nt = 2, split = Infinity }) {
  const index = new Map();
  const at = (i, j, k) => {
    const key = `${i},${j},${k}`;
    let id = index.get(key);
    if (id === undefined) {
      id = 1000 + model.nodes.length;
      index.set(key, id);
      model.nodes.push({
        id,
        x: x0 + (i * length) / nx,
        y: (j * height) / nt,
        z: (k * height) / nt,
      });
    }
    return id;
  };
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nt; j++)
      for (let k = 0; k < nt; k++) {
        const corner = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) =>
          at(i + (bits & 1), j + ((bits >> 1) & 1), k + ((bits >> 2) & 1)),
        );
        const body = x0 + ((i + 0.5) * length) / nx < split ? 1 : 2;
        for (const tet of KUHN)
          model.elements.push({
            id: model.elements.length + 1,
            type: "CTETRA",
            nodeIds: tet.map((c) => corner[c]),
            propertyId: body,
          });
      }
}

function emptyModel() {
  return {
    nodes: [],
    elements: [],
    materials: MATERIALS,
    properties: PROPERTIES,
    constraints: [],
    loads: [],
    surfaceLoads: [],
    couplings: [],
    tieGroups: [],
  };
}

const near = (a, b) => Math.abs(a - b) < 1e-6;
const idsWhere = (model, predicate) =>
  model.nodes.filter(predicate).map((node) => node.id);

// A reference point is a store node that no element uses.
function addPoint(model, x, y, z) {
  const id = 1000 + model.nodes.length;
  model.nodes.push({ id, x, y, z });
  return id;
}

const clampAll = (ids) =>
  ids.flatMap((nodeId) => [0, 1, 2].map((dof) => ({ nodeId, dof })));

// ── Compare one model through both solvers ────────────────────────────────────

const maxDifference = (lhs, rhs) => {
  let peak = 0;
  let difference = 0;
  for (let i = 0; i < lhs.length; i++) {
    peak = Math.max(peak, Math.abs(lhs[i]));
    difference = Math.max(difference, Math.abs(lhs[i] - rhs[i]));
  }
  return { peak, relative: difference / peak };
};

async function compare(label, model) {
  console.log(`\n${label}`);
  const reason = amgUnavailableReason({
    elements: model.elements,
    properties: model.properties,
    elementOrder: 1,
    couplingCount: model.couplings.length,
  });
  check("AMG accepts the model", reason === null, reason ?? "");
  const lines = [];
  const inputs = buildCoupledEngineInputs(model, (line) => lines.push(line));
  let started = performance.now();
  const mfemRaw = engine.solve_coupled(
    inputs.mesh,
    inputs.coupling,
    inputs.bcs,
    inputs.matJson,
  );
  const mfemSeconds = (performance.now() - started) / 1000;
  if ("error" in mfemRaw) {
    check("MFEM solves the model", false, mfemRaw.error);
    return;
  }
  started = performance.now();
  const rustRaw = await solveCoupledSolidWithAmg(
    fem,
    inputs,
    undefined,
    neverAsk,
    (line) => lines.push(line),
  );
  const rustSeconds = (performance.now() - started) / 1000;
  for (const line of lines) console.log(`    ${line}`);
  const mfem = mapMixedResult(model, inputs.model, mfemRaw);
  const rust = mapMixedResult(model, inputs.model, rustRaw);
  const displacement = maxDifference(mfem.displacements, rust.displacements);
  const stress = maxDifference(mfem.vonMises, rust.vonMises);
  console.log(
    `    max |u| ${displacement.peak.toExponential(4)} mm, AMG − MFEM ` +
      `${displacement.relative.toExponential(2)}; max von Mises ` +
      `${stress.peak.toExponential(4)} MPa, AMG − MFEM ${stress.relative.toExponential(2)}; ` +
      `MFEM ${mfemSeconds.toFixed(2)} s, AMG ${rustSeconds.toFixed(2)} s`,
  );
  // Both stop at a 1e-6 relative tolerance (MFEM in its preconditioned norm,
  // AMG on the force residual); the fields must agree to well within that.
  check(
    "displacements agree",
    displacement.peak > 0 && displacement.relative < 1e-5,
    `${displacement.relative}`,
  );
  check(
    "von Mises stresses agree",
    stress.relative < 1e-4,
    `${stress.relative}`,
  );
}

const LENGTH = 100;
const HEIGHT = 20;

// A two-material cantilever clamped at x = 0 with a reference point at the
// centre of its tip face, coupled to that face.
function tipCoupled(kind) {
  const model = emptyModel();
  addBeam(model, { x0: 0, length: LENGTH, height: HEIGHT, nx: 12, split: 50 });
  const point = addPoint(model, LENGTH, HEIGHT / 2, HEIGHT / 2);
  model.constraints = clampAll(idsWhere(model, (node) => near(node.x, 0)));
  model.couplings = [
    {
      name: "Tip",
      kind,
      dofs: [0, 1, 2, 3, 4, 5],
      refNodeId: point,
      faces: [
        {
          nodeIds: idsWhere(
            model,
            (node) => node.id !== point && near(node.x, LENGTH),
          ),
        },
      ],
    },
  ];
  model.loads = [
    { nodeId: point, dof: 1, value: -3000 },
    { nodeId: point, dof: 0, value: 800 },
    { nodeId: point, dof: 3, value: 40000 },
    { nodeId: point, dof: 5, value: -25000 },
  ];
  return { model, point };
}

// ── Cases ─────────────────────────────────────────────────────────────────────

await compare(
  "Kinematic coupling: force and moment at the reference point",
  tipCoupled("kinematic").model,
);

{
  const { model } = tipCoupled("distributing");
  // A pressure on the top face too, which the coupled path spreads itself.
  const top = [];
  for (const element of model.elements)
    for (const face of [
      [0, 1, 2],
      [0, 1, 3],
      [0, 2, 3],
      [1, 2, 3],
    ]) {
      const ids = face.map((corner) => element.nodeIds[corner]);
      const nodes = ids.map((id) => model.nodes[id - 1000]);
      if (nodes.every((node) => near(node.y, HEIGHT) && node.x > 30))
        top.push(ids);
    }
  model.surfaceLoads = [{ type: "pressure", faces: top, pressure: 2 }];
  await compare(
    "Distributing coupling: force and moment at the reference point, plus a pressure",
    model,
  );
}

{
  // A bolted root: the root face coupled to a point that is clamped in all
  // six DOFs, the tip loaded at a corner and pulled by a prescribed
  // displacement at another.
  const model = emptyModel();
  addBeam(model, { x0: 0, length: LENGTH, height: HEIGHT, nx: 12, split: 70 });
  const point = addPoint(model, 0, HEIGHT / 2, HEIGHT / 2);
  model.couplings = [
    {
      name: "Root",
      kind: "kinematic",
      dofs: [0, 1, 2, 3, 4, 5],
      refNodeId: point,
      faces: [
        {
          nodeIds: idsWhere(
            model,
            (node) => node.id !== point && near(node.x, 0),
          ),
        },
      ],
    },
  ];
  model.constraints = [0, 1, 2, 3, 4, 5].map((dof) => ({ nodeId: point, dof }));
  const corner = idsWhere(
    model,
    (node) =>
      near(node.x, LENGTH) && near(node.y, HEIGHT) && near(node.z, HEIGHT),
  )[0];
  const other = idsWhere(
    model,
    (node) => near(node.x, LENGTH) && near(node.y, 0) && near(node.z, 0),
  )[0];
  model.loads = [{ nodeId: corner, dof: 2, value: -1500 }];
  model.constraints.push({ nodeId: other, dof: 0, prescribedValue: 0.01 });
  await compare("A clamped kinematic reference point holds the root", model);
}

// Two beams [0, L] and [L, 2L], meshed apart, each joint face coupled to its
// own point at the joint, and the points tied by a third coupling.
function jointedBeams(connectorDofs) {
  const model = emptyModel();
  addBeam(model, { x0: 0, length: LENGTH, height: HEIGHT, nx: 10 });
  const firstCount = model.nodes.length;
  addBeam(model, { x0: LENGTH, length: LENGTH, height: HEIGHT, nx: 10 });
  for (const element of model.elements.slice(model.elements.length / 2))
    element.propertyId = 2;
  const inA = (node) => node.id < 1000 + firstCount;
  const pointA = addPoint(model, LENGTH, HEIGHT / 2, HEIGHT / 2);
  const pointB = addPoint(model, LENGTH, HEIGHT / 2, HEIGHT / 2);
  const joint = (side) =>
    idsWhere(
      model,
      (node) =>
        near(node.x, LENGTH) && node.id < 1000 + firstCount * 2 && side(node),
    );
  model.couplings = [
    {
      name: "End A",
      kind: "kinematic",
      dofs: [0, 1, 2, 3, 4, 5],
      refNodeId: pointA,
      faces: [{ nodeIds: joint(inA) }],
    },
    {
      name: "Start B",
      kind: "kinematic",
      dofs: [0, 1, 2, 3, 4, 5],
      refNodeId: pointB,
      faces: [{ nodeIds: joint((node) => !inA(node)) }],
    },
    {
      name: "Joint",
      kind: "kinematic",
      dofs: connectorDofs,
      refNodeId: pointA,
      faces: [{ nodeIds: [pointB] }],
    },
  ];
  model.constraints = clampAll(
    idsWhere(model, (node) => near(node.x, 0) && inA(node)),
  );
  const tip = idsWhere(model, (node) => near(node.x, 2 * LENGTH));
  return { model, tip };
}

{
  const { model, tip } = jointedBeams([0, 1, 2, 3, 4, 5]);
  model.loads = tip.flatMap((nodeId) => [
    { nodeId, dof: 1, value: -400 / tip.length },
    { nodeId, dof: 0, value: 2000 / tip.length },
  ]);
  await compare("A rigid point-to-point connection between two beams", model);
}

{
  // Two bodies across a 0.5 mm gap, joined by a tie (distributing couplings
  // the coupled builder derives), with a distributing coupling at the far tip.
  const model = emptyModel();
  addBeam(model, { x0: 0, length: LENGTH, height: HEIGHT, nx: 10 });
  const firstCount = model.nodes.length;
  addBeam(model, { x0: LENGTH + 0.5, length: LENGTH, height: HEIGHT, nx: 8 });
  for (const element of model.elements.slice(10 * 4 * 6))
    element.propertyId = 2;
  const inA = (node) => node.id < 1000 + firstCount;
  model.tieGroups = [
    {
      name: "Gap",
      facesA: [
        {
          nodeIds: idsWhere(model, (node) => inA(node) && near(node.x, LENGTH)),
        },
      ],
      facesB: [
        {
          nodeIds: idsWhere(
            model,
            (node) => !inA(node) && near(node.x, LENGTH + 0.5),
          ),
        },
      ],
      extent: "full",
      searchDistance: 1,
    },
  ];
  const far = 2 * LENGTH + 0.5;
  const tipIds = idsWhere(model, (node) => near(node.x, far));
  const point = addPoint(model, far, HEIGHT / 2, HEIGHT / 2);
  model.couplings = [
    {
      name: "Tip",
      kind: "distributing",
      dofs: [0, 1, 2, 3, 4, 5],
      refNodeId: point,
      faces: [{ nodeIds: tipIds }],
    },
  ];
  model.constraints = clampAll(idsWhere(model, (node) => near(node.x, 0)));
  model.loads = [
    { nodeId: point, dof: 2, value: -600 },
    { nodeId: point, dof: 4, value: 15000 },
  ];
  await compare("A tie across a gap together with a coupling", model);
}

{
  // The wall bracket, meshed by Netgen: clamped at one end, its far end
  // coupled kinematically to a point carrying a force and a moment, and a
  // band of its surface coupled distributingly to a second, loaded point.
  const mesher = await createModule(quiet());
  mesher.tessellate_step(
    new Uint8Array(
      readFileSync(join(here, "../../test_files/Wall Bracket.stp")),
    ),
    JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
  );
  const mesh = mesher.generate_fem_mesh(
    JSON.stringify({
      max_element_size: 20,
      min_element_size: 2,
      grading: 0.3,
      second_order: false,
      elementsperedge: 2.0,
      elementspercurve: 2.0,
      optsteps_2d: 3,
      optsteps_3d: 3,
    }),
  );
  mesher.free_geometry_cache();
  const model = emptyModel();
  for (let i = 0; i < mesh.vertices.length / 3; i++)
    model.nodes.push({
      id: 1000 + i,
      x: mesh.vertices[3 * i],
      y: mesh.vertices[3 * i + 1],
      z: mesh.vertices[3 * i + 2],
    });
  const low = [0, 1, 2].map((axis) =>
    Math.min(...model.nodes.map((node) => [node.x, node.y, node.z][axis])),
  );
  const high = [0, 1, 2].map((axis) =>
    Math.max(...model.nodes.map((node) => [node.x, node.y, node.z][axis])),
  );
  const extent = [0, 1, 2].map((axis) => high[axis] - low[axis]);
  const longest = extent.indexOf(Math.max(...extent));
  const along = (node) =>
    ([node.x, node.y, node.z][longest] - low[longest]) / extent[longest];
  for (let e = 0; e < mesh.tetrahedra.length / 4; e++) {
    const nodeIds = Array.from(
      mesh.tetrahedra.subarray(4 * e, 4 * e + 4),
      (vertex) => vertex + 1000,
    );
    const centre =
      nodeIds.reduce((sum, id) => sum + along(model.nodes[id - 1000]), 0) / 4;
    model.elements.push({
      id: e + 1,
      type: "CTETRA",
      nodeIds,
      propertyId: centre < 0.5 ? 1 : 2,
    });
  }
  const used = new Set(model.elements.flatMap((element) => element.nodeIds));
  const surface = new Set(Array.from(mesh.surfaceTriangles, (v) => v + 1000));
  const centroidOf = (ids) =>
    [0, 1, 2].map(
      (axis) =>
        ids.reduce(
          (sum, id) =>
            sum +
            [
              model.nodes[id - 1000].x,
              model.nodes[id - 1000].y,
              model.nodes[id - 1000].z,
            ][axis],
          0,
        ) / ids.length,
    );
  model.constraints = clampAll(
    model.nodes
      .filter((node) => used.has(node.id) && along(node) <= 0.03)
      .map((node) => node.id),
  );
  const farEnd = model.nodes
    .filter((node) => used.has(node.id) && along(node) >= 0.97)
    .map((node) => node.id);
  const band = model.nodes
    .filter(
      (node) =>
        surface.has(node.id) && along(node) >= 0.55 && along(node) <= 0.6,
    )
    .map((node) => node.id);
  const endPoint = addPoint(model, ...centroidOf(farEnd));
  const bandPoint = addPoint(model, ...centroidOf(band));
  model.couplings = [
    {
      name: "End",
      kind: "kinematic",
      dofs: [0, 1, 2, 3, 4, 5],
      refNodeId: endPoint,
      faces: [{ nodeIds: farEnd }],
    },
    {
      name: "Band",
      kind: "distributing",
      dofs: [0, 1, 2, 3, 4, 5],
      refNodeId: bandPoint,
      faces: [{ nodeIds: band }],
    },
  ];
  const across = (longest + 1) % 3;
  model.loads = [
    { nodeId: endPoint, dof: across, value: 1200 },
    { nodeId: endPoint, dof: 3 + longest, value: 30000 },
    { nodeId: bandPoint, dof: (longest + 2) % 3, value: -2500 },
  ];
  console.log(
    `\nwall bracket: ${used.size} nodes, ${model.elements.length} tets, ` +
      `${farEnd.length} + ${band.length} coupled nodes`,
  );
  await compare("Wall bracket (Netgen mesh) with two couplings", model);
}

// ── What AMG refuses ──────────────────────────────────────────────────────────

console.log("\nWhat AMG refuses");
{
  // A hinged joint (translations only) leaves beam B free to turn about it.
  // Under an axial pull the load does not excite that mechanism, and the MFEM
  // path's Gauss–Seidel CG converges anyway; the multigrid solve refuses the
  // under-constrained model instead of returning one of its many solutions.
  const { model, tip } = jointedBeams([0, 1, 2]);
  model.loads = tip.map((nodeId) => ({
    nodeId,
    dof: 0,
    value: 2000 / tip.length,
  }));
  // The solver log is not needed for these refusal checks.
  const discard = () => undefined;
  const inputs = buildCoupledEngineInputs(model, discard);
  const mfem = engine.solve_coupled(
    inputs.mesh,
    inputs.coupling,
    inputs.bcs,
    inputs.matJson,
  );
  check(
    "MFEM converges on the hinged pair under an axial pull",
    !("error" in mfem),
    mfem.error,
  );
  let refusal = "";
  try {
    await solveCoupledSolidWithAmg(fem, inputs, undefined, neverAsk, discard);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  check(
    "AMG refuses the mechanism as not fully constrained",
    refusal.includes("not fully constrained"),
    refusal || "it solved",
  );
}
{
  const { model } = tipCoupled("kinematic");
  const reason = amgUnavailableReason({
    elements: model.elements,
    properties: model.properties,
    elementOrder: 2,
    couplingCount: 1,
  });
  check(
    "quadratic elements with a coupling stay on the MFEM path",
    reason === "it supports surface-to-point couplings on linear elements only",
    String(reason),
  );
}

console.log(
  failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED`,
);
if (failures > 0) process.exit(1);
