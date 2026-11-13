// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Constraint ("MPC") ties through the app's solve path (KOF-318): weldTies
// finds the tied nodes, the Rust module weighs them (dual mortar on linear
// elements) and eliminates them in solveSolidInRust — what the solver worker
// does. The C++ engine has no tie path, so the checks are against exact
// solutions rather than an oracle.
//
// The model is two boxes separated by a 0.5 mm gap and meshed independently
// with DIFFERENT divisions, so no node of one faces a node of the other — the
// case a node-merge cannot join without distorting the mesh. Checked for
// hexahedra and tetrahedra, linear and quadratic, with both preconditioners:
//   - the constraints found (count, weights, projection distance, extent),
//     by projection and by the Rust mortar weights;
//   - the solve converges on the UNCHANGED mesh (no node merged or moved),
//     and every tied node moves with the face it is tied to;
//   - the load crosses the tie: pulled by a force, the end moves by F·L/(E·A);
//     pulled by a displacement, the tie sits halfway;
//   - the patch test: a uniform traction gives a uniform stress across the
//     non-matching mortar tie, to solver tolerance;
//   - a tied node that is also fixed keeps its boundary condition.

import { beforeAll, describe, expect, test } from "bun:test";
import { tieConstraints } from "../../src/lib/tieConstraints.ts";
import {
  rustMortarWeights,
  tieWeighting,
} from "../../src/lib/solve/tieMortar.ts";
import { solveSolidInRust } from "../../src/lib/solve/amg.ts";
import { buildCoupledEngineInputs } from "../../src/lib/solve/coupled.ts";
import {
  expandTiedDisplacements,
  weldTies,
} from "../../src/lib/solve/solid.ts";
import { boxHexMesh } from "../../../examples/validation/lib/mesh.mjs";
import { loadFem } from "../support/wasm.mjs";

let fem = null;
beforeAll(async () => {
  fem = await loadFem();
});

const GAP = 0.5;
const LENGTH = 10;
const SIDE = 4;
const YOUNG = 210000;
const FORCE = 8000; // N, total, pulling box B in +x
const PULL = 0.05; // mm, the same pull as a prescribed end displacement
const STRESS = 100; // MPa, the patch test's traction
const ID_OFFSET = 1000;

const neverAsk = () => {
  throw new Error("the continuation prompt must not appear");
};

// A hexahedron as six tetrahedra around its 0–6 diagonal (Kuhn split), which
// conforms across a structured grid.
const KUHN = [
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
  [0, 5, 1, 6],
];

// Box A (x ∈ [0, 10], 2×2 cross-section divisions) and box B (x ∈ [10.5, 20.5],
// `divisionsB` across), as store-shaped nodes and elements.
function gappedBoxes(elementType, divisionsB) {
  const boxA = boxHexMesh(LENGTH, SIDE, SIDE, 5, 2, 2);
  const boxB = boxHexMesh(LENGTH, SIDE, SIDE, 5, divisionsB, divisionsB);
  const nodes = [];
  boxA.vertices.forEach((v, i) =>
    nodes.push({ id: i, x: v[0], y: v[1], z: v[2] }),
  );
  boxB.vertices.forEach((v, i) =>
    nodes.push({
      id: ID_OFFSET + i,
      x: v[0] + LENGTH + GAP,
      y: v[1],
      z: v[2],
    }),
  );
  const elements = [];
  const add = (hex, offset, propertyId) => {
    const ids = hex.map((n) => offset + n);
    if (elementType === "CHEXA") {
      elements.push({
        id: elements.length + 1,
        type: "CHEXA",
        nodeIds: ids,
        propertyId,
      });
      return;
    }
    for (const tet of KUHN)
      elements.push({
        id: elements.length + 1,
        type: "CTETRA",
        nodeIds: tet.map((k) => ids[k]),
        propertyId,
      });
  };
  boxA.hexahedra.forEach((hex) => add(hex, 0, 1));
  boxB.hexahedra.forEach((hex) => add(hex, ID_OFFSET, 2));
  return { nodes, elements };
}

const onPlane = (nodes, x) =>
  nodes.filter((node) => Math.abs(node.x - x) < 1e-9).map((node) => node.id);

function tieBetween(nodes, extent, searchDistance) {
  return [
    {
      name: "Tie1",
      facesA: [{ nodeIds: onPlane(nodes, LENGTH) }],
      facesB: [{ nodeIds: onPlane(nodes, LENGTH + GAP) }],
      extent,
      searchDistance,
      method: "mpc",
    },
  ];
}

const PROJECTION = { kind: "projection" };

describe("the nodes a constraint tie finds", () => {
  const { nodes, elements } = gappedBoxes("CHEXA", 3);

  test("the finer face follows the coarser one, straight across the gap", () => {
    const { constraints, reports } = tieConstraints(
      nodes,
      elements,
      tieBetween(nodes, "region", 0.6),
      PROJECTION,
    );
    // Box B's face is the finer one (4×4 nodes against 3×3), so it follows.
    expect(constraints).toHaveLength(16);
    expect(reports[0].nPaired).toBe(16);
    for (const constraint of constraints) {
      expect(constraint.slaveId).toBeGreaterThanOrEqual(ID_OFFSET);
      expect(constraint.masterIds.every((id) => id < ID_OFFSET)).toBe(true);
      const sum = constraint.weights.reduce((total, w) => total + w, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-12);
      expect(constraint.weights.every((w) => w > 0)).toBe(true);
      expect(Math.abs(constraint.distance - GAP)).toBeLessThan(1e-9);
      const slave = nodes.find((node) => node.id === constraint.slaveId);
      expect(Math.abs(constraint.point[1] - slave.y)).toBeLessThan(1e-9);
      expect(Math.abs(constraint.point[2] - slave.z)).toBeLessThan(1e-9);
    }
  });

  test("the search distance limits a region tie; a full tie ignores it", () => {
    const short = tieConstraints(
      nodes,
      elements,
      tieBetween(nodes, "region", 0.1),
      PROJECTION,
    );
    expect(short.constraints).toHaveLength(0);
    const full = tieConstraints(
      nodes,
      elements,
      tieBetween(nodes, "full", 0),
      PROJECTION,
    );
    expect(full.constraints).toHaveLength(16);
  });

  test("matching meshes tie node to node", () => {
    const matching = gappedBoxes("CHEXA", 2);
    for (const weighting of [
      PROJECTION,
      { kind: "mortar", weights: rustMortarWeights(fem) },
    ]) {
      const { constraints } = tieConstraints(
        matching.nodes,
        matching.elements,
        tieBetween(matching.nodes, "full", 0),
        weighting,
      );
      expect(constraints).toHaveLength(9);
      for (const constraint of constraints) {
        expect(constraint.masterIds).toHaveLength(1);
        expect(Math.abs(constraint.weights[0] - 1)).toBeLessThan(1e-12);
      }
    }
  });

  test("the Rust mortar weights sum to one and reproduce a linear field", () => {
    const { constraints } = tieConstraints(
      nodes,
      elements,
      tieBetween(nodes, "full", 0),
      tieWeighting(1, fem),
    );
    expect(constraints).toHaveLength(16);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const constraint of constraints) {
      const sum = constraint.weights.reduce((total, w) => total + w, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-12);
      const slave = byId.get(constraint.slaveId);
      for (const axis of ["y", "z"]) {
        const followed = constraint.masterIds.reduce(
          (total, id, k) => total + constraint.weights[k] * byId.get(id)[axis],
          0,
        );
        expect(Math.abs(followed - slave[axis])).toBeLessThan(1e-9);
      }
    }
  });

  test("a shell facet on a picked surface is skipped, not refused", () => {
    const facetA = onPlane(nodes, LENGTH).slice(0, 3);
    const withShell = [
      ...elements,
      { id: 99999, type: "CTRIA3", nodeIds: facetA, propertyId: 3 },
    ];
    const { constraints } = tieConstraints(
      nodes,
      withShell,
      tieBetween(nodes, "full", 0),
      PROJECTION,
    );
    expect(constraints).toHaveLength(16);
  });
});

// ── Solve ─────────────────────────────────────────────────────────────────────
const materials = [
  { id: 1, name: "Steel", young: YOUNG, poisson: 0.3, density: 7.85e-9 },
];
const properties = [
  { id: 1, materialId: 1 },
  { id: 2, materialId: 1 },
];

// The solver worker's handleSolidSolve on its Rust path. `drive` pulls box
// B's far face: "force" by point loads (meaningful on linear elements, where
// vertex loads are a fair traction), "displacement" by prescribing ux there.
async function solve(
  elementType,
  order,
  { tied = true, fixSlave = false, drive = "force", method = "amg" } = {},
) {
  const { nodes, elements } = gappedBoxes(elementType, 3);
  const tieGroups = tied ? tieBetween(nodes, "region", 0.6) : [];
  const logs = [];
  const log = (line) => logs.push(line);
  const model = weldTies(
    nodes,
    elements,
    tieGroups,
    log,
    tied ? tieWeighting(order, fem) : null,
  );
  const constraints = [];
  for (const id of onPlane(nodes, 0))
    for (let dof = 0; dof < 3; dof++) constraints.push({ nodeId: id, dof });
  const fixedSlave = fixSlave ? model.constraints[0].slaveId : null;
  if (fixedSlave !== null)
    for (let dof = 0; dof < 3; dof++)
      constraints.push({ nodeId: fixedSlave, dof });
  const endIds = onPlane(nodes, 2 * LENGTH + GAP);
  const loads =
    drive === "force"
      ? endIds.map((nodeId) => ({
          nodeId,
          dof: 0,
          value: FORCE / endIds.length,
        }))
      : [];
  if (drive === "displacement")
    for (const nodeId of endIds)
      constraints.push({ nodeId, dof: 0, prescribedValue: PULL });

  const result = await solveSolidInRust(
    fem,
    {
      nodes: model.solveNodes,
      elements: model.tiedElements,
      materials,
      properties,
      constraints,
      loads,
      constraintTies: model.constraints,
    },
    order,
    method,
    model.vid,
    model.vidTied,
    undefined,
    neverAsk,
    log,
  );
  const disp = expandTiedDisplacements(nodes, model, result.displacements);
  const indexOf = new Map(nodes.map((node, i) => [node.id, i]));
  const ux = (id) => disp[3 * indexOf.get(id)];
  // What a tied node must equal on linear elements: the weighted displacement
  // of its masters. A quadratic face needs its edge values, which the result
  // does not carry, so order 2 is checked by the position of the tie alone.
  let worst = 0;
  if (order === 1)
    for (const constraint of model.constraints) {
      if (constraint.slaveId === fixedSlave) continue;
      for (let c = 0; c < 3; c++) {
        const followed = constraint.masterIds.reduce(
          (sum, id, k) =>
            sum + constraint.weights[k] * disp[3 * indexOf.get(id) + c],
          0,
        );
        worst = Math.max(
          worst,
          Math.abs(disp[3 * indexOf.get(constraint.slaveId) + c] - followed),
        );
      }
    }
  const endUx = endIds.reduce((sum, id) => sum + ux(id), 0) / endIds.length;
  const tieUx =
    model.constraints.reduce((sum, c) => sum + ux(c.slaveId), 0) /
    Math.max(1, model.constraints.length);
  return {
    model,
    nodes,
    worst,
    endUx,
    tieUx,
    fixedSlaveUx: fixedSlave === null ? null : ux(fixedSlave),
    logs,
  };
}

// F·L/(E·A) over the two boxes; the gap carries no strain — the tie bridges it.
const EXPECTED = (FORCE * 2 * LENGTH) / (YOUNG * SIDE * SIDE);

describe("the Rust solve of a constraint tie", () => {
  test("without the tie the disconnected assembly does not solve", async () => {
    await expect(solve("CHEXA", 1, { tied: false })).rejects.toThrow();
  });

  test("the tie moves no node", async () => {
    const { model, nodes } = await solve("CHEXA", 1, {
      drive: "displacement",
    });
    expect(model.solveNodes).toHaveLength(nodes.length);
  });

  for (const [elementType, order] of [
    ["CHEXA", 1],
    ["CTETRA", 1],
    ["CHEXA", 2],
    ["CTETRA", 2],
  ])
    for (const method of ["amg", "gauss-seidel"])
      test(`${elementType} order ${order}, ${method}: the pull crosses the tie`, async () => {
        // Two equal boxes in series: the tie, which bridges the gap rigidly,
        // moves by half the prescribed pull. A tie that held the surface at a
        // few points only would let box B ride along nearly rigidly instead.
        const pulled = await solve(elementType, order, {
          drive: "displacement",
          method,
        });
        expect(
          pulled.logs.some((line) => /constrained 16 node\(s\)/.test(line)),
        ).toBe(true);
        expect(
          pulled.logs.some((line) =>
            /^Tie constraints: \d+ tied node/.test(line),
          ),
        ).toBe(true);
        expect(pulled.worst).toBeLessThan(1e-9 * PULL);
        expect(Math.abs(pulled.tieUx - PULL / 2)).toBeLessThan(0.05 * PULL);
        if (order !== 1) return;
        const loaded = await solve(elementType, order, { method });
        expect(Math.abs(loaded.endUx - EXPECTED)).toBeLessThan(0.05 * EXPECTED);
      });

  test("a tied node that is also fixed keeps its boundary condition", async () => {
    const pinned = await solve("CHEXA", 1, { fixSlave: true });
    expect(pinned.fixedSlaveUx).toBe(0);
    expect(
      pinned.logs.some((line) => /also fixed or prescribed/.test(line)),
    ).toBe(true);
  });
});

// The tie patch test: rollers on x = 0, y = 0 and z = 0, a uniform traction on
// box B's far face. The exact stress is uniform; across a non-matching tie only
// the mortar weights transfer it exactly.
describe("the patch test across a non-matching mortar tie", () => {
  for (const elementType of ["CHEXA", "CTETRA"])
    test(`${elementType}: uniform ${STRESS} MPa to solver tolerance`, async () => {
      const { nodes, elements } = gappedBoxes(elementType, 3);
      const model = weldTies(
        nodes,
        elements,
        tieBetween(nodes, "full", 0),
        () => undefined,
        tieWeighting(1, fem),
      );
      const constraints = [];
      for (const node of nodes)
        ["x", "y", "z"].forEach((axis, dof) => {
          if (Math.abs(node[axis]) < 1e-9)
            constraints.push({ nodeId: node.id, dof });
        });
      const far = new Set(onPlane(nodes, 2 * LENGTH + GAP));
      const faces = [];
      for (const element of elements) {
        const onFar = element.nodeIds.filter((id) => far.has(id));
        if (element.type === "CHEXA" && onFar.length === 4) faces.push(onFar);
        if (element.type === "CTETRA" && onFar.length === 3) faces.push(onFar);
      }
      const result = await solveSolidInRust(
        fem,
        {
          nodes: model.solveNodes,
          elements: model.tiedElements,
          materials,
          properties,
          constraints,
          loads: [],
          surfaceLoads: [{ type: "traction", force: [STRESS, 0, 0], faces }],
          constraintTies: model.constraints,
        },
        1,
        "amg",
        model.vid,
        model.vidTied,
        undefined,
        neverAsk,
        () => undefined,
      );
      const worst = Math.max(
        ...Array.from(result.vonMises, (value) => Math.abs(value - STRESS)),
      );
      expect(worst).toBeLessThan(1e-4 * STRESS);
    });
});

// A model with a surface-to-point coupling takes the coupled solve, which joins
// every tie by distributing couplings. A constraint tie there must say so, not
// change its formulation silently.
describe("a constraint tie in a model with a coupling", () => {
  test("is joined by distributing couplings, and the log says so", () => {
    const { nodes, elements } = gappedBoxes("CTETRA", 3);
    const far = onPlane(nodes, 2 * LENGTH + GAP);
    const refNodeId = 9999;
    const logs = [];
    buildCoupledEngineInputs(
      {
        nodes: [
          ...nodes,
          { id: refNodeId, x: 2 * LENGTH + GAP + 1, y: 2, z: 2 },
        ],
        elements,
        materials,
        properties,
        constraints: [],
        loads: [],
        couplings: [
          {
            name: "Coupling1",
            kind: "kinematic",
            dofs: [0, 1, 2, 3, 4, 5],
            refNodeId,
            faces: [{ nodeIds: far }],
          },
        ],
        tieGroups: tieBetween(nodes, "full", 0),
      },
      (line) => logs.push(line),
    );
    expect(
      logs.some((line) =>
        /Tie "Tie1": .*distributing couplings.*constraint \(MPC\)/.test(line),
      ),
    ).toBe(true);
  });
});
