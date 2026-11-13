// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Tie-connection test (#356). Two hex boxes separated by a 0.5 mm gap and meshed
// independently (distinct node ids, different bodies) — a stand-in for the
// crane-hook pin/eye line contact. Box A is clamped; box B carries a load but
// touches nothing. Without a connection the assembly is disconnected and the
// solve cannot converge; a tie between the two facing surfaces welds their node
// pairs so the solve succeeds and the load reaches box B.
//
// Covers both extents: "region" (only pairs within a search distance) and
// "full" (the whole selected surface, whatever the gap).

import { beforeAll, describe, expect, test } from "bun:test";
import {
  buildTie,
  remapElement,
  assertValidTiedMesh,
  tiedId,
  expandToOriginalNodes,
} from "../../src/lib/tie.ts";
import { boxHexMesh } from "../../../examples/validation/lib/mesh.mjs";
import { loadEngine } from "../support/wasm.mjs";

// ── Build two gapped boxes as store-shaped nodes/elements ─────────────────────
const GAP = 0.5;
const boxA = boxHexMesh(10, 4, 4, 5, 2, 2); // x ∈ [0, 10]
const boxB = boxHexMesh(10, 4, 4, 5, 2, 2); // shifted to x ∈ [10.5, 20.5]

const ID_OFFSET = 1000; // keep box B node ids distinct from box A
const nodes = [];
boxA.vertices.forEach((v, i) =>
  nodes.push({ id: i, x: v[0], y: v[1], z: v[2] }),
);
boxB.vertices.forEach((v, i) =>
  nodes.push({ id: ID_OFFSET + i, x: v[0] + 10 + GAP, y: v[1], z: v[2] }),
);

const elements = [];
boxA.hexahedra.forEach((h) =>
  elements.push({ type: "CHEXA", nodeIds: h.slice(), propertyId: 1 }),
);
boxB.hexahedra.forEach((h) =>
  elements.push({
    type: "CHEXA",
    nodeIds: h.map((n) => ID_OFFSET + n),
    propertyId: 2,
  }),
);

// ── The two facing surfaces the connection joins ──────────────────────────────
// Box A's x = 10 face and box B's x = 10.5 face, as the node-id lists a face
// pick would produce.
const faceNodes = (predicate) => nodes.filter(predicate).map((node) => node.id);
const SURFACE_A = faceNodes((node) => Math.abs(node.x - 10) < 1e-9);
const SURFACE_B = faceNodes((node) => Math.abs(node.x - (10 + GAP)) < 1e-9);

test("each facing surface has its 3×3 nodes", () => {
  expect(SURFACE_A).toHaveLength(9);
  expect(SURFACE_B).toHaveLength(9);
});

const tieBetween = (extent, searchDistance) => [
  {
    name: "Tie1",
    facesA: [{ nodeIds: SURFACE_A }],
    facesB: [{ nodeIds: SURFACE_B }],
    extent,
    searchDistance,
  },
];

// ── The tie welds exactly the 3×3 interface node pairs ───────────────────────
const tie = buildTie(nodes, elements, tieBetween("region", 0.6)); // > GAP, < element size
const tiedElements = elements.map((el) => remapElement(el, tie.repOf));

describe("buildTie", () => {
  test("a region tie welds the nine interface node pairs", () => {
    expect(tie.nWelded).toBe(9);
    expect(tie.reports[0].nPaired).toBe(9);
  });

  test("the tied mesh is valid", () => {
    expect(() => assertValidTiedMesh(nodes, elements, tie)).not.toThrow();
  });

  // A search distance below the gap reaches nothing — the connection welds no
  // pair, which is exactly what the solve path turns into an actionable error.
  test("a 0.1 mm search distance does not span the 0.5 mm gap", () => {
    expect(buildTie(nodes, elements, tieBetween("region", 0.1)).nWelded).toBe(
      0,
    );
  });

  // The full-surface extent has no distance to fall short of: it welds the
  // same nine pairs, whatever the gap.
  test("a full-surface tie welds all nine pairs", () => {
    expect(buildTie(nodes, elements, tieBetween("full", 0)).nWelded).toBe(9);
  });
});

// ── Solve helper (single steel material, box A clamped, box B end-loaded) ─────
const STEEL = JSON.stringify({ young_modulus: 210000, poisson_ratio: 0.3 });

async function solve(useTie) {
  const Module = await loadEngine();
  const applied = useTie ? tie : { nodes, repOf: new Map(), nWelded: 0 };
  const solveNodes = applied.nodes;
  const els = useTie ? tiedElements : elements;

  const vidMap = new Map(solveNodes.map((nd, i) => [nd.id, i]));
  const vid = (nodeId) => {
    const i = vidMap.get(tiedId(applied.repOf, nodeId));
    if (i === undefined) throw new Error(`unknown node ${nodeId}`);
    return i;
  };

  const hexElements = els.filter((e) => e.type === "CHEXA");
  const hexahedra = new Int32Array(8 * hexElements.length);
  hexElements.forEach((e, i) => {
    for (let k = 0; k < 8; k++) hexahedra[8 * i + k] = vid(e.nodeIds[k]);
  });
  const vertices = new Float64Array(3 * solveNodes.length);
  solveNodes.forEach((nd, i) => {
    vertices[3 * i] = nd.x;
    vertices[3 * i + 1] = nd.y;
    vertices[3 * i + 2] = nd.z;
  });

  // Clamp box A's x = 0 face; pull box B's far (x ≈ 20.5) face in +x.
  const fixed = [];
  const loads = [];
  for (const nd of nodes) {
    if (nd.id < ID_OFFSET && Math.abs(nd.x) < 1e-9) fixed.push(vid(nd.id));
    if (nd.id >= ID_OFFSET && Math.abs(nd.x - (20 + GAP)) < 1e-9)
      loads.push({ vertex: vid(nd.id), force: [500, 0, 0] });
  }
  const bcs = JSON.stringify({ fixed_vertices: fixed, point_loads: loads });

  let result;
  try {
    result = Module.solve_linear_elastic(
      { vertices, tetrahedra: new Int32Array(0), hexahedra },
      STEEL,
      bcs,
      1,
    );
  } catch (e) {
    const dec = Module.getExceptionMessage
      ? Module.getExceptionMessage(e)
      : null;
    return { ok: false, error: dec ? dec[1] : String(e) };
  }
  if ("error" in result) return { ok: false, error: result.error };

  const disp = expandToOriginalNodes(
    nodes,
    solveNodes,
    applied.repOf,
    result.displacements,
    3,
  );
  let maxUx = 0;
  for (let i = 0; i < nodes.length; i++)
    maxUx = Math.max(maxUx, Math.abs(disp[3 * i]));
  return { ok: true, maxUx };
}

describe("solving the two boxes", () => {
  let untied;
  let tied;
  beforeAll(async () => {
    untied = await solve(false);
    tied = await solve(true);
  });

  // Without the tie box B is disconnected, so the solve cannot converge.
  test("the untied assembly fails to solve", () => {
    expect(untied.ok, `converged with maxUx=${untied.maxUx}`).toBe(false);
  });

  // With the tie the boxes are joined: the solve converges and box B is loaded.
  test("the tied assembly solves and the load reaches box B", () => {
    expect(tied.ok, `tied assembly must solve, got: ${tied.error}`).toBe(true);
    expect(Number.isFinite(tied.maxUx)).toBe(true);
    expect(tied.maxUx).toBeGreaterThan(0);
  });
});
