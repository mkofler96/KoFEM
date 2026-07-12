#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for the edge-picking algorithm (#386).
//
// A flat shell sheet is one face-pick region, so grabbing its rim needs edge
// picking. These tests verify:
//   - boundary edges are the mesh edges used by exactly one facet
//   - clicking near a straight rim selects that whole side and stops at corners
//   - clicking an interior triangle falls back to the nearest rim edge
//   - clicking a smoothly-tessellated closed loop selects the whole loop
//
// Run: bun tests/test_edge_pick.mjs   (from the web/ directory)

import {
  buildBoundaryMeshTopo,
  extractBoundaryEdges,
  pickEdgeNodeIds,
  pickFaceNodeIds,
} from "../src/lib/facePick.ts";
import {
  plateWithHoleShellMesh,
  nodesWhere,
} from "../../examples/validation/lib/mesh.mjs";

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0,
  failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// ── Grid-plate mesh ─────────────────────────────────────────────────────────
//
// NX×NY quad grid split into two triangles per cell, lying flat in z = 0.
// Node id = j*(NX+1) + i at position (i, j, 0). The boundary is the outer
// rectangle: bottom (j=0), top (j=NY), left (i=0), right (i=NX).

const NX = 4;
const NY = 3;
const nid = (i, j) => j * (NX + 1) + i;

const gridPos = [];
for (let j = 0; j <= NY; j++) {
  for (let i = 0; i <= NX; i++) gridPos[nid(i, j)] = [i, j, 0];
}

// Triangle order: cells in (j outer, i inner), triangle A then B per cell.
// triIdx(cell A) = 2*(j*NX + i), triIdx(cell B) = 2*(j*NX + i) + 1.
const gridTris = [];
for (let j = 0; j < NY; j++) {
  for (let i = 0; i < NX; i++) {
    const v00 = nid(i, j),
      v10 = nid(i + 1, j),
      v01 = nid(i, j + 1),
      v11 = nid(i + 1, j + 1);
    gridTris.push([v00, v10, v11]); // A
    gridTris.push([v00, v11, v01]); // B
  }
}
const triA = (i, j) => 2 * (j * NX + i);
const gridGetPos = (id) => gridPos[id];
const gridTopo = buildBoundaryMeshTopo(gridTris, gridGetPos);

// ── Test 1: boundary-edge extraction (used-once) ─────────────────────────────

console.log("\nTest 1: boundary edges = edges used by exactly one facet");

const gridBoundary = extractBoundaryEdges(gridTopo);
// Rectangle perimeter: NX bottom + NX top + NY left + NY right segments.
assert(
  "boundary-edge count matches the rectangle perimeter",
  gridBoundary.length === 2 * NX + 2 * NY,
);
const gridBoundaryNodes = new Set(gridBoundary.flat());
// Interior nodes (not on any rim) must not appear in any boundary edge.
assert(
  "interior node is not on any boundary edge",
  !gridBoundaryNodes.has(nid(2, 1)),
);

// ── Test 2: straight rim pick stops at corners ───────────────────────────────

console.log("\nTest 2: clicking a straight rim selects that side only");

// Click the midpoint of the bottom edge of cell (2,0) — triangle A.
const bottomExpected = new Set([
  nid(0, 0),
  nid(1, 0),
  nid(2, 0),
  nid(3, 0),
  nid(4, 0),
]);
const bottomPick = pickEdgeNodeIds(
  [2.5, 0, 0],
  triA(2, 0),
  gridTopo,
  gridGetPos,
);
assert(
  "bottom rim: exactly the bottom row selected",
  setsEqual(bottomPick, bottomExpected),
);
assert(
  "bottom rim: does not turn up a side (no left/right-only node)",
  !bottomPick.has(nid(0, 1)) && !bottomPick.has(nid(4, 1)),
);

// Click the left edge (cell (0,1) triangle B carries the left rim segment).
const leftExpected = new Set([nid(0, 0), nid(0, 1), nid(0, 2), nid(0, 3)]);
const leftPick = pickEdgeNodeIds(
  [0, 1.5, 0],
  triA(0, 1) + 1, // triangle B of cell (0,1)
  gridTopo,
  gridGetPos,
);
assert(
  "left rim: exactly the left column selected",
  setsEqual(leftPick, leftExpected),
);

// ── Test 3: interior click falls back to the nearest rim ─────────────────────

console.log("\nTest 3: interior-triangle click falls back to nearest rim edge");

// Cell (2,1) is fully interior (no boundary edge); a click near the bottom rim
// should still grab the bottom row via the global nearest-edge fallback.
const fallbackPick = pickEdgeNodeIds(
  [2.5, 0, 0],
  triA(2, 1),
  gridTopo,
  gridGetPos,
);
assert(
  "interior click near bottom selects the bottom row",
  setsEqual(fallbackPick, bottomExpected),
);

// ── Fan mesh (closed smooth loop) ────────────────────────────────────────────
//
// A center node fanned out to N rim nodes on a circle. Every rim edge is used
// by one triangle (boundary); every spoke is shared by two (interior). The rim
// is a regular N-gon whose per-vertex turn (360/N) is below EDGE_TURN_LIMIT for
// N = 16, so one click should walk the whole loop.

console.log("\nTest 4: smooth closed loop selects the whole rim");

const SEGS = 16;
const RADIUS = 10;
const fanPos = [[0, 0, 0]];
for (let i = 0; i < SEGS; i++) {
  const theta = (2 * Math.PI * i) / SEGS;
  fanPos.push([RADIUS * Math.cos(theta), RADIUS * Math.sin(theta), 0]);
}
const fanTris = [];
for (let i = 0; i < SEGS; i++) {
  fanTris.push([0, 1 + i, 1 + ((i + 1) % SEGS)]);
}
const fanGetPos = (id) => fanPos[id];
const fanTopo = buildBoundaryMeshTopo(fanTris, fanGetPos);

const fanBoundary = extractBoundaryEdges(fanTopo);
assert(
  "fan: boundary edge count equals rim segment count",
  fanBoundary.length === SEGS,
);

const rimExpected = new Set();
for (let i = 1; i <= SEGS; i++) rimExpected.add(i);
// Click the rim segment carried by triangle 0 ([0, 1, 2]) — midpoint of nodes 1,2.
const mid = [
  (fanPos[1][0] + fanPos[2][0]) / 2,
  (fanPos[1][1] + fanPos[2][1]) / 2,
  0,
];
const rimPick = pickEdgeNodeIds(mid, 0, fanTopo, fanGetPos);
assert("fan: all rim nodes selected", setsEqual(rimPick, rimExpected));
assert("fan: center node not selected", !rimPick.has(0));

// ── Test 5: closed solid boundary has no pickable edges ──────────────────────

console.log("\nTest 5: closed manifold surface yields no boundary edges");

// A tetrahedron's surface is closed — every edge is shared by two facets.
const tetPos = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const tetTris = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 2, 3],
  [1, 2, 3],
];
const tetTopo = buildBoundaryMeshTopo(tetTris, (id) => tetPos[id]);
assert(
  "closed surface: no boundary edges",
  extractBoundaryEdges(tetTopo).length === 0,
);
assert(
  "closed surface: edge pick returns empty",
  pickEdgeNodeIds([0.5, 0.5, 0], 0, tetTopo, (id) => tetPos[id]).size === 0,
);

// ── Test 6: the real plate-with-hole shell mesh (#386 target case) ───────────
//
// The exact mesh the plate-with-hole-shell gallery card ships (same generator
// call as generate-plate-hole-shell.mjs): an annulus from the hole rim out to a
// square outer boundary. It reproduces the motivating problem — a flat shell is
// one face-pick region — and proves edge picking grabs the rim the saved
// analysis loads (the pulled right edge) instead of the whole plate.

console.log("\nTest 6: real plate-with-hole shell mesh");

const HOLE_R = 1000;
const HALF_W = 10000;
const NTH = 64;
const shell = plateWithHoleShellMesh(HOLE_R, HALF_W, 12, NTH, 2);
const shellGetPos = (id) => shell.vertices[id];
const shellTopo = buildBoundaryMeshTopo(shell.triangles, shellGetPos);
const shellBoundary = extractBoundaryEdges(shellTopo);

// Boundary = inner hole rim + outer square, NTH segments each.
assert(
  "shell: boundary loops are the hole rim + outer square",
  shellBoundary.length === 2 * NTH,
);

// Face picking a flat plate flood-fills the whole sheet — the exact problem
// edge picking exists to work around.
const wholePlate = pickFaceNodeIds(0, shellTopo);
assert(
  "shell: face pick selects the whole flat plate",
  wholePlate.size === shell.vertices.length,
);

const midOf = (edge) => [
  (shellGetPos(edge[0])[0] + shellGetPos(edge[1])[0]) / 2,
  (shellGetPos(edge[0])[1] + shellGetPos(edge[1])[1]) / 2,
  0,
];
const ownerTri = (edge) =>
  shellTopo.edgeToTris.get(
    edge[0] < edge[1] ? `${edge[0]},${edge[1]}` : `${edge[1]},${edge[0]}`,
  )[0];

// Click the outer right edge near y = 0 — the pulled edge of the saved analysis.
const rightEdges = shellBoundary.filter(
  (e) =>
    shellGetPos(e[0])[0] >= HALF_W - 1e-6 &&
    shellGetPos(e[1])[0] >= HALF_W - 1e-6,
);
const rightSeed = rightEdges.reduce((best, e) =>
  Math.abs(midOf(e)[1]) < Math.abs(midOf(best)[1]) ? e : best,
);
const rightPick = pickEdgeNodeIds(
  midOf(rightSeed),
  ownerTri(rightSeed),
  shellTopo,
  shellGetPos,
);
// The generator defines the pulled edge as exactly the nodes at x = +b.
const pulledEdge = new Set(
  nodesWhere(shell.vertices, (x) => x >= HALF_W - 1e-6),
);
assert(
  "shell: edge pick reproduces the generator's pulled right edge",
  setsEqual(rightPick, pulledEdge),
);
assert(
  "shell: the pulled edge is a small fraction of the plate",
  rightPick.size > 2 && rightPick.size < shell.vertices.length * 0.1,
);

// Click a hole-rim segment — the smooth loop is walked whole.
const rimEdges = shellBoundary.filter((e) => {
  const r0 = Math.hypot(shellGetPos(e[0])[0], shellGetPos(e[0])[1]);
  const r1 = Math.hypot(shellGetPos(e[1])[0], shellGetPos(e[1])[1]);
  return Math.abs(r0 - HOLE_R) < 1e-6 && Math.abs(r1 - HOLE_R) < 1e-6;
});
const holeRimPick = pickEdgeNodeIds(
  midOf(rimEdges[0]),
  ownerTri(rimEdges[0]),
  shellTopo,
  shellGetPos,
);
const holeRim = new Set(
  nodesWhere(
    shell.vertices,
    (x, y) => Math.abs(Math.hypot(x, y) - HOLE_R) < 1e-6,
  ),
);
assert(
  "shell: edge pick walks the whole hole rim",
  setsEqual(holeRimPick, holeRim),
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
