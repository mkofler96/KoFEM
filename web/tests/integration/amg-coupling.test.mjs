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
// along the way. Then quadratic elements, against the MFEM solid solve at
// order 2 (the engine's coupled solve is linear only, see below), and what
// AMG refuses: a hinged point-to-point joint, which leaves a mechanism (the
// MFEM path's Gauss–Seidel CG still converges on it when the load does not
// excite the mechanism).

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildCoupledEngineInputs,
  mapMixedResult,
} from "../../src/lib/solve/coupled.ts";
import {
  amgUnavailableReason,
  solveCoupledSolidInRust,
} from "../../src/lib/solve/amg.ts";
import { buildSolidEngineInputs } from "../../src/lib/solve/solid.ts";
import { buildVertexIndexer } from "../../src/lib/solveMeshPacking.ts";
import { loadEngine, loadFem } from "../support/wasm.mjs";

const WALL_BRACKET_STEP = new URL(
  "../../../test_files/Wall Bracket.stp",
  import.meta.url,
);

// One engine instance runs every MFEM solve here, and the Rust module every
// AMG solve. The coupled model builder (shell idealisation) runs in the Rust
// module too.
let engine = null;
let fem = null;
beforeAll(async () => {
  fem = await loadFem();
  engine = await loadEngine();
});

// The solver log is not needed for these checks.
const discard = () => undefined;

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

// The model through the engine's coupled solve and through Rust, both at
// order 1: why AMG would not take it (null when it does), what MFEM returned,
// and how far the two results are apart.
async function compare(model) {
  const reason = amgUnavailableReason({
    elements: model.elements,
    properties: model.properties,
    elementOrder: 1,
    couplingCount: model.couplings.length,
  });
  const inputs = buildCoupledEngineInputs(model, discard);
  const mfemRaw = engine.solve_coupled(
    inputs.mesh,
    inputs.coupling,
    inputs.bcs,
    inputs.matJson,
  );
  if ("error" in mfemRaw) return { reason, mfemRaw };
  const rustRaw = await solveCoupledSolidInRust(
    fem,
    inputs,
    1,
    "amg",
    undefined,
    neverAsk,
    discard,
  );
  const mfem = mapMixedResult(model, inputs.model, mfemRaw);
  const rust = mapMixedResult(model, inputs.model, rustRaw);
  return {
    reason,
    mfemRaw,
    displacement: maxDifference(mfem.displacements, rust.displacements),
    stress: maxDifference(mfem.vonMises, rust.vonMises),
  };
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

function distributingWithPressure() {
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
  return model;
}

// A bolted root: the root face coupled to a point that is clamped in all
// six DOFs, the tip loaded at a corner and pulled by a prescribed
// displacement at another.
function boltedRoot() {
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
  return model;
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

function rigidJoint() {
  const { model, tip } = jointedBeams([0, 1, 2, 3, 4, 5]);
  model.loads = tip.flatMap((nodeId) => [
    { nodeId, dof: 1, value: -400 / tip.length },
    { nodeId, dof: 0, value: 2000 / tip.length },
  ]);
  return model;
}

// Two bodies across a 0.5 mm gap, joined by a tie (distributing couplings
// the coupled builder derives), with a distributing coupling at the far tip.
function tiedAcrossGap() {
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
  return model;
}

// The wall bracket meshed by Netgen at `maxElementSize` (mm), as a store
// model with two materials (split halfway along its length), and the helpers
// the cases pick nodes with.
async function bracketModel(maxElementSize) {
  const mesher = await loadEngine();
  mesher.tessellate_step(
    new Uint8Array(readFileSync(WALL_BRACKET_STEP)),
    JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5 }),
  );
  const mesh = mesher.generate_fem_mesh(
    JSON.stringify({
      max_element_size: maxElementSize,
      min_element_size: maxElementSize / 10,
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
  return { model, used, surface, along, centroidOf, longest };
}

// The wall bracket, meshed by Netgen: clamped at one end, its far end
// coupled kinematically to a point carrying a force and a moment, and a
// band of its surface coupled distributingly to a second, loaded point.
async function bracketWithTwoCouplings() {
  const { model, used, surface, along, centroidOf, longest } =
    await bracketModel(20);
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
  return model;
}

describe("linear elements", () => {
  describe.each([
    [
      "Kinematic coupling: force and moment at the reference point",
      () => tipCoupled("kinematic").model,
    ],
    [
      "Distributing coupling: force and moment at the reference point, plus a pressure",
      distributingWithPressure,
    ],
    ["A clamped kinematic reference point holds the root", boltedRoot],
    ["A rigid point-to-point connection between two beams", rigidJoint],
    ["A tie across a gap together with a coupling", tiedAcrossGap],
    ["Wall bracket (Netgen mesh) with two couplings", bracketWithTwoCouplings],
  ])("%s", (_label, buildModel) => {
    let outcome = null;
    beforeAll(async () => {
      outcome = await compare(await buildModel());
    });

    test("AMG accepts the model", () => {
      expect(outcome.reason).toBeNull();
    });

    test("MFEM solves the model", () => {
      expect("error" in outcome.mfemRaw, outcome.mfemRaw.error).toBe(false);
    });

    // Both stop at a 1e-6 relative tolerance (MFEM in its preconditioned norm,
    // AMG on the force residual); the fields must agree to well within that.
    test("displacements agree", () => {
      expect(outcome.displacement.peak).toBeGreaterThan(0);
      expect(outcome.displacement.relative).toBeLessThan(1e-5);
    });

    test("von Mises stresses agree", () => {
      expect(outcome.stress.relative).toBeLessThan(1e-4);
    });
  });
});

// ── Quadratic elements ────────────────────────────────────────────────────────
//
// The engine's coupled solve has linear tets only, so a coupled quadratic model
// is checked against the MFEM solid solve at order 2 on the model the coupling
// stands for. A kinematic point that is fixed or driven moves the surface it
// grips as a rigid body — exactly the clamp or the prescribed rigid
// displacement MFEM applies to those vertices and extends to their edge nodes —
// so the two are one discrete problem and must agree to solver precision. A
// distributing point loaded by a force stands for that force spread over the
// face; it puts the load on the face's corner nodes in equal shares (as on
// linear elements) rather than as a uniform traction, which only changes the
// field near the face (Saint-Venant), so away from it the two agree closely.

const QUADRATIC = 2;

// Boundary faces (as tet-face node-id triples) whose nodes all satisfy `on`.
function facesWhere(model, on) {
  const faces = [];
  for (const element of model.elements)
    for (const face of [
      [0, 1, 2],
      [0, 1, 3],
      [0, 2, 3],
      [1, 2, 3],
    ]) {
      const ids = face.map((corner) => element.nodeIds[corner]);
      if (ids.every((id) => on(model.nodes[id - 1000]))) faces.push(ids);
    }
  return faces;
}

async function solveQuadraticCoupled(model) {
  const inputs = buildCoupledEngineInputs(model, discard);
  const raw = await solveCoupledSolidInRust(
    fem,
    inputs,
    QUADRATIC,
    "amg",
    undefined,
    neverAsk,
    discard,
  );
  return mapMixedResult(model, inputs.model, raw);
}

function solveMfemQuadratic(model) {
  const vid = buildVertexIndexer(model.nodes);
  const inputs = buildSolidEngineInputs(model, vid);
  const raw = engine.solve_linear_elastic(
    inputs.mesh,
    inputs.matJson,
    inputs.bcsJson,
    QUADRATIC,
  );
  if ("error" in raw) throw new Error(`MFEM order 2: ${raw.error}`);
  return {
    displacements: raw.displacements,
    vonMises: raw.von_mises,
  };
}

// The coupled model (its reference point is its last node) through Rust at
// order 2, against `equivalent` (the same model without the point) through
// MFEM at order 2: why AMG would not take the coupled model (null when it
// does), and how far the two results are apart.
async function compareQuadratic(coupled, equivalent) {
  const reason = amgUnavailableReason({
    elements: coupled.elements,
    properties: coupled.properties,
    elementOrder: QUADRATIC,
    couplingCount: coupled.couplings.length,
  });
  const rust = await solveQuadraticCoupled(coupled);
  const mfem = solveMfemQuadratic(equivalent);
  const vertices = 3 * equivalent.nodes.length;
  return {
    reason,
    displacement: maxDifference(
      mfem.displacements,
      rust.displacements.subarray(0, vertices),
    ),
    stress: maxDifference(mfem.vonMises, rust.vonMises),
  };
}

// The two-material beam with its root face (x = 0) coupled kinematically to a
// point at its centre, and the same loads on the tip: a corner force,
// pressures on the top and on the bottom and a side (whose faces come wound
// inward from their tets' local face lists), and a total force on the tip
// face.
function rootCoupled() {
  const model = emptyModel();
  addBeam(model, { x0: 0, length: LENGTH, height: HEIGHT, nx: 8, split: 60 });
  const point = addPoint(model, 0, HEIGHT / 2, HEIGHT / 2);
  const root = idsWhere(model, (node) => node.id !== point && near(node.x, 0));
  model.couplings = [
    {
      name: "Root",
      kind: "kinematic",
      dofs: [0, 1, 2, 3, 4, 5],
      refNodeId: point,
      faces: [{ nodeIds: root }],
    },
  ];
  const corner = idsWhere(
    model,
    (node) =>
      near(node.x, LENGTH) && near(node.y, HEIGHT) && near(node.z, HEIGHT),
  )[0];
  model.loads = [
    { nodeId: corner, dof: 1, value: 300 },
    { nodeId: corner, dof: 2, value: -900 },
  ];
  model.surfaceLoads = [
    {
      type: "pressure",
      faces: facesWhere(model, (node) => near(node.y, HEIGHT) && node.x > 40),
      pressure: 1.5,
    },
    {
      type: "pressure",
      faces: [
        ...facesWhere(model, (node) => near(node.y, 0) && node.x > 50),
        ...facesWhere(model, (node) => near(node.z, 0) && node.x > 50),
      ],
      pressure: 0.8,
    },
    {
      type: "force",
      faces: facesWhere(model, (node) => near(node.x, LENGTH)),
      force: [400, 0, -1200],
    },
  ];
  return { model, point, root };
}

// The coupled model without its reference point and coupling.
function withoutPoint(model, point) {
  return {
    ...model,
    nodes: model.nodes.filter((node) => node.id !== point),
    couplings: [],
    constraints: [],
    loads: model.loads.filter((load) => load.nodeId !== point),
  };
}

// The root-coupled beam with its point fixed in all six DOFs, and the same
// beam with its root face clamped instead.
function fixedRoot() {
  const { model, point, root } = rootCoupled();
  model.constraints = [0, 1, 2, 3, 4, 5].map((dof) => ({ nodeId: point, dof }));
  const clamped = withoutPoint(model, point);
  clamped.constraints = clampAll(root);
  return { coupled: model, equivalent: clamped };
}

// The root-coupled beam with its point driven in all six DOFs, and the same
// beam with the rigid displacement that gives prescribed on its root face.
function drivenRoot() {
  const { model, point, root } = rootCoupled();
  const translation = [0.02, -0.01, 0.015];
  const rotation = [0.0005, 0.0004, -0.0003];
  model.constraints = [
    ...translation.map((value, dof) => ({
      nodeId: point,
      dof,
      prescribedValue: value,
    })),
    ...rotation.map((value, axis) => ({
      nodeId: point,
      dof: 3 + axis,
      prescribedValue: value,
    })),
  ];
  // u = d + θ × r at each root vertex, r from the point.
  const centre = model.nodes.find((node) => node.id === point);
  const driven = withoutPoint(model, point);
  driven.constraints = root.flatMap((nodeId) => {
    const node = model.nodes[nodeId - 1000];
    const arm = [node.x - centre.x, node.y - centre.y, node.z - centre.z];
    const turn = [
      rotation[1] * arm[2] - rotation[2] * arm[1],
      rotation[2] * arm[0] - rotation[0] * arm[2],
      rotation[0] * arm[1] - rotation[1] * arm[0],
    ];
    return [0, 1, 2].map((dof) => ({
      nodeId,
      dof,
      prescribedValue: translation[dof] + turn[dof],
    }));
  });
  return { coupled: model, equivalent: driven };
}

// The wall bracket at order 2, its near end held by a kinematic coupling to
// a clamped point, its far end loaded: the same as clamping the near end.
async function bracketHeldAtOneEnd() {
  const { model, used, along, centroidOf } = await bracketModel(40);
  const heldEnd = model.nodes
    .filter((node) => used.has(node.id) && along(node) <= 0.1)
    .map((node) => node.id);
  const far = model.nodes
    .filter((node) => used.has(node.id) && along(node) >= 0.97)
    .map((node) => node.id);
  const point = addPoint(model, ...centroidOf(heldEnd));
  model.couplings = [
    {
      name: "Bolted end",
      kind: "kinematic",
      dofs: [0, 1, 2, 3, 4, 5],
      refNodeId: point,
      faces: [{ nodeIds: heldEnd }],
    },
  ];
  model.constraints = [0, 1, 2, 3, 4, 5].map((dof) => ({ nodeId: point, dof }));
  model.loads = far.flatMap((nodeId) => [
    { nodeId, dof: 0, value: 800 / far.length },
    { nodeId, dof: 1, value: -1500 / far.length },
    { nodeId, dof: 2, value: 600 / far.length },
  ]);
  const clamped = withoutPoint(model, point);
  clamped.constraints = clampAll(heldEnd);
  return { coupled: model, equivalent: clamped };
}

describe("quadratic elements", () => {
  describe.each([
    ["Quadratic: a fixed kinematic point clamps the face it grips", fixedRoot],
    [
      "Quadratic: a driven kinematic point moves its face as a rigid body",
      drivenRoot,
    ],
    [
      "Quadratic wall bracket (Netgen mesh): a clamped kinematic point holds one end",
      bracketHeldAtOneEnd,
    ],
  ])("%s", (_label, buildModels) => {
    let outcome = null;
    beforeAll(async () => {
      const { coupled, equivalent } = await buildModels();
      outcome = await compareQuadratic(coupled, equivalent);
    });

    test("AMG accepts couplings on quadratic elements", () => {
      expect(outcome.reason).toBeNull();
    });

    test("displacements agree", () => {
      expect(outcome.displacement.peak).toBeGreaterThan(0);
      expect(outcome.displacement.relative).toBeLessThan(1e-5);
    });

    test("von Mises stresses agree", () => {
      expect(outcome.stress.relative).toBeLessThan(1e-4);
    });
  });

  // The fixed kinematic point again, at order 1, through the engine's coupled
  // solve and Rust, against the MFEM solid solve. The coupled path spreads the
  // pressure itself, from the winding of each face; the faces come in their
  // tet's local winding (inward on some), so this also checks the pressure
  // pushes into the body on every face, as the solid solve's does.
  describe("Linear: a fixed kinematic point clamps the face it grips, with a pressure", () => {
    // How far each coupled solve is from the clamped solid solve, by its name.
    const differences = {};
    beforeAll(async () => {
      const { coupled: model, equivalent: clamped } = fixedRoot();
      const inputs = buildCoupledEngineInputs(model, discard);
      const engineRaw = engine.solve_coupled(
        inputs.mesh,
        inputs.coupling,
        inputs.bcs,
        inputs.matJson,
      );
      if ("error" in engineRaw) throw new Error(engineRaw.error);
      const rustRaw = await solveCoupledSolidInRust(
        fem,
        inputs,
        1,
        "amg",
        undefined,
        neverAsk,
        discard,
      );
      const vid = buildVertexIndexer(clamped.nodes);
      const solidInputs = buildSolidEngineInputs(clamped, vid);
      const solidRaw = engine.solve_linear_elastic(
        solidInputs.mesh,
        solidInputs.matJson,
        solidInputs.bcsJson,
        1,
      );
      if ("error" in solidRaw) throw new Error(solidRaw.error);
      const vertices = 3 * clamped.nodes.length;
      for (const [name, raw] of [
        ["engine coupled", engineRaw],
        ["AMG coupled", rustRaw],
      ]) {
        const mapped = mapMixedResult(model, inputs.model, raw);
        differences[name] = maxDifference(
          solidRaw.displacements,
          mapped.displacements.subarray(0, vertices),
        );
      }
    });

    test.each(["engine coupled", "AMG coupled"])(
      "%s matches the clamped solid solve",
      (name) => {
        expect(differences[name].peak).toBeGreaterThan(0);
        expect(differences[name].relative).toBeLessThan(1e-5);
      },
    );
  });

  describe("Quadratic: a force at a distributing point against the same force spread over the face", () => {
    let peak = 0;
    let difference = 0;
    let tipRust = null;
    let tipMfem = null;
    beforeAll(async () => {
      // A force at a distributing point on the tip face, against the same
      // total force spread over the face as a surface load.
      const model = emptyModel();
      addBeam(model, {
        x0: 0,
        length: LENGTH,
        height: HEIGHT,
        nx: 8,
        split: 60,
      });
      const tip = idsWhere(model, (node) => near(node.x, LENGTH));
      const point = addPoint(model, LENGTH, HEIGHT / 2, HEIGHT / 2);
      const root = idsWhere(
        model,
        (node) => node.id !== point && near(node.x, 0),
      );
      model.constraints = clampAll(root);
      model.couplings = [
        {
          name: "Tip",
          kind: "distributing",
          dofs: [0, 1, 2, 3, 4, 5],
          refNodeId: point,
          faces: [{ nodeIds: tip }],
        },
      ];
      const force = [500, 200, -1500];
      model.loads = force.map((value, dof) => ({ nodeId: point, dof, value }));
      const spread = withoutPoint(model, point);
      spread.constraints = model.constraints;
      spread.surfaceLoads = [
        {
          type: "force",
          faces: facesWhere(model, (node) => near(node.x, LENGTH)),
          force,
        },
      ];
      const rust = await solveQuadraticCoupled(model);
      const mfem = solveMfemQuadratic(spread);
      // Away from the loaded face (x ≤ 3L/4) the fields agree.
      spread.nodes.forEach((node, index) => {
        if (node.x > 0.75 * LENGTH) return;
        for (let axis = 0; axis < 3; axis++) {
          peak = Math.max(peak, Math.abs(mfem.displacements[3 * index + axis]));
          difference = Math.max(
            difference,
            Math.abs(
              mfem.displacements[3 * index + axis] -
                rust.displacements[3 * index + axis],
            ),
          );
        }
      });
      const mean = (field) =>
        tip.reduce((sum, nodeId) => sum + field[3 * (nodeId - 1000) + 2], 0) /
        tip.length;
      tipRust = mean(rust.displacements);
      tipMfem = mean(mfem.displacements);
    });

    test("away from the face, the displacements agree within 0.5%", () => {
      expect(peak).toBeGreaterThan(0);
      expect(difference / peak).toBeLessThan(5e-3);
    });

    test("the mean tip deflection agrees within 0.5%", () => {
      expect(
        Math.abs(tipRust - tipMfem),
        `${tipRust} against ${tipMfem}`,
      ).toBeLessThan(5e-3 * Math.abs(tipMfem));
    });
  });
});

// ── What AMG refuses ──────────────────────────────────────────────────────────

describe("what AMG refuses", () => {
  // A hinged joint (translations only) leaves beam B free to turn about it.
  // Under an axial pull the load does not excite that mechanism, and the MFEM
  // path's Gauss–Seidel CG converges anyway; the multigrid solve refuses the
  // under-constrained model instead of returning one of its many solutions.
  let inputs = null;
  let mfem = null;
  beforeAll(() => {
    const { model, tip } = jointedBeams([0, 1, 2]);
    model.loads = tip.map((nodeId) => ({
      nodeId,
      dof: 0,
      value: 2000 / tip.length,
    }));
    inputs = buildCoupledEngineInputs(model, discard);
    mfem = engine.solve_coupled(
      inputs.mesh,
      inputs.coupling,
      inputs.bcs,
      inputs.matJson,
    );
  });

  test("MFEM converges on the hinged pair under an axial pull", () => {
    expect("error" in mfem, mfem.error).toBe(false);
  });

  test("AMG refuses the mechanism as not fully constrained", async () => {
    await expect(
      solveCoupledSolidInRust(
        fem,
        inputs,
        1,
        "amg",
        undefined,
        neverAsk,
        discard,
      ),
    ).rejects.toThrow("not fully constrained");
  });

  // The Solve panel's Gauss–Seidel choice is for exactly this case: the Rust
  // Gauss–Seidel CG converges on the load-compatible mechanism, as MFEM does,
  // to the same field.
  test("Rust Gauss–Seidel converges on the mechanism and matches MFEM", async () => {
    const log = [];
    const rust = await solveCoupledSolidInRust(
      fem,
      inputs,
      1,
      "gauss-seidel",
      undefined,
      neverAsk,
      (line) => log.push(line),
    );
    expect(log.join("\n")).toMatch(/Gauss–Seidel CG converged/);
    expect(rust.von_mises_tets).toHaveLength(mfem.von_mises_tets.length);
    // The two solvers may land on different rotations about the hinge (the
    // mechanism), which move the beam but do not strain it: compare stresses.
    let peak = 0;
    let difference = 0;
    mfem.von_mises_tets.forEach((stress, index) => {
      peak = Math.max(peak, Math.abs(stress));
      difference = Math.max(
        difference,
        Math.abs(stress - rust.von_mises_tets[index]),
      );
    });
    expect(difference / peak).toBeLessThan(1e-4);
  });
});
