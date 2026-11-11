// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Constraint ("MPC") tie test (#357). Two boxes separated by a 0.5 mm gap and
// meshed independently with DIFFERENT divisions, so no node of one faces a node
// of the other — the case a node-merge cannot join without distorting the mesh.
// Box A is clamped; box B is pulled. The constraint tie makes each node of the
// finer face follow the point of the coarser face it projects onto, and the
// engine eliminates those nodes from the system.
//
// Checked for hexahedra and tetrahedra, linear and quadratic:
//   - the constraints found (count, weights, projection distance, extent);
//   - the solve converges on the UNCHANGED mesh (no node merged or moved);
//   - the solution satisfies every constraint: a tied node moves with the face
//     it projects onto;
//   - the load crosses the tie: pulled by a force, the end moves by F·L/(E·A);
//     pulled by a displacement, the tie sits halfway;
//   - a tied node that is also fixed keeps its boundary condition.
//
// Usage:  bun tests/test_tie_constraints.mjs   (from the web/ directory)

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { tieConstraints } from "../src/lib/tieConstraints.ts";
import { weldTies, buildSolidEngineInputs } from "../src/lib/solve/solid.ts";
import { boxHexMesh } from "../../examples/validation/lib/mesh.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPkg = join(__dirname, "../src/wasm/pkg");
const wasmBinary = readFileSync(join(wasmPkg, "kofem_wasm_emcc.wasm")).buffer;
const { default: createModule } = await import(
  join(wasmPkg, "kofem_wasm_emcc.js")
);

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const GAP = 0.5;
const LENGTH = 10;
const SIDE = 4;
const YOUNG = 210000;
const FORCE = 8000; // N, total, pulling box B in +x
const PULL = 0.05; // mm, the same pull as a prescribed end displacement
const ID_OFFSET = 1000;

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

// ── The constraints a tie finds ───────────────────────────────────────────────
{
  const { nodes, elements } = gappedBoxes("CHEXA", 3);
  const { constraints, reports } = tieConstraints(
    nodes,
    elements,
    tieBetween(nodes, "region", 0.6),
    "projection",
  );
  // Box B's face is the finer one (4×4 nodes against 3×3), so it follows.
  assert(
    constraints.length === 16,
    `expected the 16 nodes of the finer face to be tied, got ${constraints.length}`,
  );
  assert(reports[0].nPaired === 16, "the report counts the tied nodes");
  for (const constraint of constraints) {
    assert(
      constraint.slaveId >= ID_OFFSET,
      `node ${constraint.slaveId} of the coarser face must not follow`,
    );
    assert(
      constraint.masterIds.every((id) => id < ID_OFFSET),
      "a tied node follows nodes of the opposite body only",
    );
    const sum = constraint.weights.reduce((total, w) => total + w, 0);
    assert(Math.abs(sum - 1) < 1e-12, `weights must sum to 1, got ${sum}`);
    assert(
      constraint.weights.every((w) => w > 0),
      "weights are positive",
    );
    assert(
      Math.abs(constraint.distance - GAP) < 1e-9,
      `the projection crosses the ${GAP} mm gap, got ${constraint.distance}`,
    );
    // The projection is the weighted position of the masters, at the same (y, z).
    const slave = nodes.find((node) => node.id === constraint.slaveId);
    assert(
      Math.abs(constraint.point[1] - slave.y) < 1e-9 &&
        Math.abs(constraint.point[2] - slave.z) < 1e-9,
      "a node projects straight across onto the facing plane",
    );
  }

  const tooShort = tieConstraints(
    nodes,
    elements,
    tieBetween(nodes, "region", 0.1),
    "projection",
  );
  assert(
    tooShort.constraints.length === 0,
    "a 0.1 mm search distance must not span the 0.5 mm gap",
  );
  const full = tieConstraints(
    nodes,
    elements,
    tieBetween(nodes, "full", 0),
    "projection",
  );
  assert(
    full.constraints.length === 16,
    `a full-surface tie constrains all 16 nodes, got ${full.constraints.length}`,
  );

  // Matching meshes degenerate to node-to-node ties: one master, weight 1.
  const matching = gappedBoxes("CHEXA", 2);
  const nodeToNode = tieConstraints(
    matching.nodes,
    matching.elements,
    tieBetween(matching.nodes, "full", 0),
    "projection",
  );
  assert(
    nodeToNode.constraints.length === 9 &&
      nodeToNode.constraints.every(
        (constraint) =>
          constraint.masterIds.length === 1 && constraint.weights[0] === 1,
      ),
    "facing nodes are tied one to one",
  );
  // The mortar formulation ties the same 16 nodes. Its weights come from the
  // dual basis, so some are negative, but each set sums to one and reproduces
  // a linear field: Σ w·x_master is the node's own (y, z) on the facing plane.
  const mortar = tieConstraints(
    nodes,
    elements,
    tieBetween(nodes, "full", 0),
    "mortar",
  );
  assert(
    mortar.constraints.length === 16,
    `the mortar tie constrains all 16 nodes, got ${mortar.constraints.length}`,
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const constraint of mortar.constraints) {
    const sum = constraint.weights.reduce((total, w) => total + w, 0);
    assert(Math.abs(sum - 1) < 1e-12, `mortar weights sum to ${sum}`);
    const slave = byId.get(constraint.slaveId);
    for (const axis of ["y", "z"]) {
      const followed = constraint.masterIds.reduce(
        (total, id, k) => total + constraint.weights[k] * byId.get(id)[axis],
        0,
      );
      assert(
        Math.abs(followed - slave[axis]) < 1e-9,
        `mortar weights must reproduce a linear field (${axis}: ${followed} vs ${slave[axis]})`,
      );
    }
  }
  const mortarMatching = tieConstraints(
    matching.nodes,
    matching.elements,
    tieBetween(matching.nodes, "full", 0),
    "mortar",
  );
  assert(
    mortarMatching.constraints.every(
      (constraint) =>
        constraint.masterIds.length === 1 &&
        Math.abs(constraint.weights[0] - 1) < 1e-12,
    ),
    "on matching meshes the mortar tie is node to node",
  );
  // A shell facet on a picked surface (a mixed model) is not a solid face: it
  // is skipped, not a reason to throw while the viewport draws the tie.
  const facetA = onPlane(nodes, LENGTH).slice(0, 3);
  const withShell = [
    ...elements,
    { id: 99999, type: "CTRIA3", nodeIds: facetA, propertyId: 3 },
  ];
  const shellMixed = tieConstraints(
    nodes,
    withShell,
    tieBetween(nodes, "full", 0),
    "mortar",
  );
  assert(
    shellMixed.constraints.length === 16,
    `a shell facet on the surface must not change the tie, got ${shellMixed.constraints.length}`,
  );
  console.log(
    "constraints: 16 node-to-face, 9 node-to-node, mortar consistent, shell facet skipped — ok",
  );
}

// ── Solve ─────────────────────────────────────────────────────────────────────
const materials = [
  { id: 1, name: "Steel", young: YOUNG, poisson: 0.3, density: 7.85e-9 },
];
const properties = [
  { id: 1, materialId: 1 },
  { id: 2, materialId: 1 },
];

// `drive` pulls box B's far face: "force" by point loads (meaningful on linear
// elements, where vertex loads are a fair traction), "displacement" by
// prescribing ux there.
async function solve(
  elementType,
  order,
  { tied = true, fixSlave = false, drive = "force" },
) {
  const { nodes, elements } = gappedBoxes(elementType, 3);
  const tieGroups = tied ? tieBetween(nodes, "region", 0.6) : [];
  const logs = [];
  const model = weldTies(nodes, elements, tieGroups, order, (line) =>
    logs.push(line),
  );
  assert(
    model.solveNodes.length === nodes.length,
    "a constraint tie must not merge any node",
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

  const inputs = buildSolidEngineInputs(
    { nodes, elements, materials, properties, constraints, loads },
    model.vid,
    model.vidTied,
    model.constraints,
  );
  const Module = await createModule({
    wasmBinary,
    print: () => {},
    printErr: () => {},
  });
  let result;
  try {
    result = Module.solve_linear_elastic(
      inputs.mesh,
      inputs.matJson,
      inputs.bcsJson,
      order,
    );
  } catch (e) {
    const decoded = Module.getExceptionMessage
      ? Module.getExceptionMessage(e)
      : null;
    return { ok: false, error: decoded ? decoded[1] : String(e) };
  }
  if ("error" in result) return { ok: false, error: result.error };

  const disp = result.displacements;
  const indexOf = new Map(nodes.map((node, i) => [node.id, i]));
  const ux = (id) => disp[3 * indexOf.get(id)];
  // What a tied node must equal on linear elements: the weighted displacement
  // of its masters, with the weights the solve sent. A quadratic face needs
  // its edge values, which the result does not carry, so order 2 is checked by
  // the position of the tie alone.
  const masterField = (constraint, component) =>
    constraint.masterIds.reduce(
      (sum, id, k) =>
        sum + constraint.weights[k] * disp[3 * indexOf.get(id) + component],
      0,
    );
  let worst = 0;
  if (order === 1)
    for (const constraint of model.constraints) {
      if (constraint.slaveId === fixedSlave) continue;
      for (let c = 0; c < 3; c++)
        worst = Math.max(
          worst,
          Math.abs(
            disp[3 * indexOf.get(constraint.slaveId) + c] -
              masterField(constraint, c),
          ),
        );
    }
  const endUx = endIds.reduce((sum, id) => sum + ux(id), 0) / endIds.length;
  const tieUx =
    model.constraints.reduce((sum, c) => sum + ux(c.slaveId), 0) /
    Math.max(1, model.constraints.length);
  return {
    ok: true,
    worst,
    endUx,
    tieUx,
    fixedSlaveUx: fixedSlave === null ? null : ux(fixedSlave),
    logs,
  };
}

// F·L/(E·A) over the two boxes; the gap carries no strain — the tie bridges it.
const EXPECTED = (FORCE * 2 * LENGTH) / (YOUNG * SIDE * SIDE);

const untied = await solve("CHEXA", 1, { tied: false });
assert(!untied.ok, "the untied (disconnected) assembly must fail to solve");
console.log("no tie : failed as expected");

for (const [elementType, order] of [
  ["CHEXA", 1],
  ["CTETRA", 1],
  ["CHEXA", 2],
  ["CTETRA", 2],
]) {
  const label = `${elementType} order ${order}`;
  // Two equal boxes in series: the tie, which bridges the gap rigidly, moves by
  // half the prescribed pull. A tie that held the surface at a few points only
  // would let box B ride along nearly rigidly instead.
  const pulled = await solve(elementType, order, { drive: "displacement" });
  assert(pulled.ok, `${label}: tied assembly must solve, got: ${pulled.error}`);
  assert(
    pulled.logs.some((line) => /constrained 16 node\(s\)/.test(line)),
    `${label}: the solve log reports the tied nodes`,
  );
  assert(
    pulled.worst < 1e-9 * PULL,
    `${label}: every tied node must follow its face, off by ${pulled.worst}`,
  );
  assert(
    Math.abs(pulled.tieUx - PULL / 2) < 0.05 * PULL,
    `${label}: the tie should move by half the pull (${PULL / 2}), got ${pulled.tieUx}`,
  );
  console.log(
    `${label}: tie ux ${pulled.tieUx.toExponential(4)} of ${PULL} pulled, constraint residual ${pulled.worst.toExponential(1)}`,
  );
  if (order !== 1) continue;

  const loaded = await solve(elementType, order, {});
  assert(loaded.ok, `${label}: loaded assembly must solve: ${loaded.error}`);
  assert(
    Math.abs(loaded.endUx - EXPECTED) < 0.05 * EXPECTED,
    `${label}: end displacement ${loaded.endUx} should be F·L/(E·A) = ${EXPECTED} within 5 %`,
  );
  console.log(
    `${label}: end ux ${loaded.endUx.toExponential(4)} under load (F·L/EA ${EXPECTED.toExponential(4)})`,
  );
}

// A tied node that is also fixed keeps its boundary condition.
const pinned = await solve("CHEXA", 1, { fixSlave: true });
assert(
  pinned.ok,
  `a fixed tied node must not break the solve: ${pinned.error}`,
);
assert(pinned.fixedSlaveUx === 0, "the fixed tied node stays fixed");
console.log("fixed tied node: boundary condition kept");

console.log("\nPASS");
