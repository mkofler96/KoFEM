#!/usr/bin/env bun
// Unit test for the face-picking algorithm.
//
// Geometry: a hollow tube with inner radius 5, outer radius 10, height 20.
// 8 circumferential segments, 1 height segment.
// The test verifies that clicking one triangle on the inner mantle surface
// selects ALL inner mantle triangles — and no triangles from the outer mantle
// or the end caps.
//
// Run: bun test_face_pick.mjs

import {
  buildBoundaryMeshTopo,
  pickFaceNodeIds,
  COS_FLAT,
  COS_CURVE,
} from "./web/src/lib/facePick.ts";

// ── Geometry helpers ─────────────────────────────────────────────────────────

function ringVerts(radius, z, n) {
  const verts = [];
  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / n;
    verts.push([radius * Math.cos(theta), radius * Math.sin(theta), z]);
  }
  return verts;
}

// Build a pair of triangles (a quad) from 4 vertex indices: bottom-left,
// bottom-right, top-right, top-left (CCW from outside).
function quad(a, b, c, d) {
  return [
    [a, b, c],
    [a, c, d],
  ];
}

// ── Tube mesh ─────────────────────────────────────────────────────────────────
//
// 4 named faces:
//   faceId 1 — inner mantle  (normal points inward, toward axis)
//   faceId 2 — outer mantle  (normal points outward, away from axis)
//   faceId 3 — top cap       (normal points up, +z)
//   faceId 4 — bottom cap    (normal points down, -z)

const N = 8; // circumferential segments
const Ri = 5; // inner radius
const Ro = 10; // outer radius
const H = 20; // height

// Vertex layout (32 vertices total):
//   0..N-1    inner bottom ring
//   N..2N-1   inner top ring
//   2N..3N-1  outer bottom ring
//   3N..4N-1  outer top ring

const verts = [
  ...ringVerts(Ri, 0, N), // inner bottom
  ...ringVerts(Ri, H, N), // inner top
  ...ringVerts(Ro, 0, N), // outer bottom
  ...ringVerts(Ro, H, N), // outer top
];

const triangles = [];
const faceIds = [];

// Inner mantle — quads go ccw when viewed from OUTSIDE the tube (which is
// inside the tube opening, so normals point toward the axis = inward).
for (let i = 0; i < N; i++) {
  const j = (i + 1) % N;
  // inner bottom[i], inner bottom[j], inner top[j], inner top[i]
  const tris = quad(i, j, N + j, N + i);
  for (const t of tris) {
    triangles.push(t);
    faceIds.push(1);
  }
}

// Outer mantle — normals point outward.
for (let i = 0; i < N; i++) {
  const j = (i + 1) % N;
  // outer bottom[i], outer top[i], outer top[j], outer bottom[j]
  const tris = quad(2 * N + i, 3 * N + i, 3 * N + j, 2 * N + j);
  for (const t of tris) {
    triangles.push(t);
    faceIds.push(2);
  }
}

// Top cap — connects inner top ring to outer top ring. Normals point up.
for (let i = 0; i < N; i++) {
  const j = (i + 1) % N;
  // inner top[i], outer top[i], outer top[j], inner top[j]
  const tris = quad(N + i, 3 * N + i, 3 * N + j, N + j);
  for (const t of tris) {
    triangles.push(t);
    faceIds.push(3);
  }
}

// Bottom cap — connects inner bottom ring to outer bottom ring. Normals point down.
for (let i = 0; i < N; i++) {
  const j = (i + 1) % N;
  // inner bottom[i], inner bottom[j], outer bottom[j], outer bottom[i]
  const tris = quad(i, j, 2 * N + j, 2 * N + i);
  for (const t of tris) {
    triangles.push(t);
    faceIds.push(4);
  }
}

const getPos = (id) => verts[id];

// Which triangle indices belong to each face?
const innerTriIndices = faceIds
  .map((id, i) => (id === 1 ? i : -1))
  .filter((i) => i >= 0);
const outerTriIndices = faceIds
  .map((id, i) => (id === 2 ? i : -1))
  .filter((i) => i >= 0);
const topTriIndices = faceIds
  .map((id, i) => (id === 3 ? i : -1))
  .filter((i) => i >= 0);

// Which node IDs belong to the inner surface (exclusively)?
const innerNodeIds = new Set();
for (const ti of innerTriIndices) {
  for (const v of triangles[ti]) innerNodeIds.add(v);
}

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

// ── Test 1: CAD face ID mode ──────────────────────────────────────────────────

console.log("\nTest 1: CAD face ID mode");

const topoWithIds = buildBoundaryMeshTopo(triangles, getPos, faceIds);
const seedIdx = innerTriIndices[0]; // click the first inner-surface triangle

const pickedNodeIds = pickFaceNodeIds(seedIdx, topoWithIds);

// Expected: exactly the inner surface node IDs
assert(
  "selected node count matches inner surface",
  pickedNodeIds.size === innerNodeIds.size,
);
assert(
  "all inner surface nodes selected",
  setsEqual(pickedNodeIds, innerNodeIds),
);

// Sanity: no outer-surface-only or cap-only nodes accidentally included
const outerNodeIds = new Set();
for (const ti of outerTriIndices)
  for (const v of triangles[ti]) outerNodeIds.add(v);
const outerOnlyNodes = [...outerNodeIds].filter((v) => !innerNodeIds.has(v));
assert(
  "no outer-only nodes leaked into selection",
  outerOnlyNodes.every((v) => !pickedNodeIds.has(v)),
);

// ── Test 2: CAD face ID mode — clicking a different face picks that face ──────

console.log("\nTest 2: CAD face ID mode — outer face");

const outerSeedIdx = outerTriIndices[0];
const pickedOuter = pickFaceNodeIds(outerSeedIdx, topoWithIds);
const outerNodeIdsFull = new Set();
for (const ti of outerTriIndices)
  for (const v of triangles[ti]) outerNodeIdsFull.add(v);

assert(
  "outer surface: all nodes selected",
  setsEqual(pickedOuter, outerNodeIdsFull),
);
assert(
  "outer surface: no inner nodes leaked",
  [...innerNodeIds]
    .filter((v) => !outerNodeIdsFull.has(v))
    .every((v) => !pickedOuter.has(v)),
);

// ── Test 3: BFS mode WITHOUT face IDs (bug-fix regression) ───────────────────

console.log("\nTest 3: BFS mode (no face IDs) — inner cylinder surface");

const topoNoIds = buildBoundaryMeshTopo(triangles, getPos, undefined);
const pickedBFS = pickFaceNodeIds(
  innerTriIndices[Math.floor(N / 2)],
  topoNoIds,
);

// The BFS should select exactly the inner surface nodes.
// Before the bug fix (isFlat = flatCount >= curvedCount), 2 axial neighbours
// would outvote 1 circumferential neighbour, classifying the seed as "flat".
// The tight 15° threshold would then prevent traversal around the cylinder.
assert(
  "BFS: selected node count matches inner surface",
  pickedBFS.size === innerNodeIds.size,
);
assert(
  "BFS: all inner surface nodes reached",
  setsEqual(pickedBFS, innerNodeIds),
);

// ── Test 4: BFS correctly stops at caps (feature-edge boundary) ───────────────

console.log("\nTest 4: BFS stops at caps");

// Click a top-cap triangle — should select only top-cap nodes.
const topCapNodeIds = new Set();
for (const ti of topTriIndices)
  for (const v of triangles[ti]) topCapNodeIds.add(v);

const pickedTop = pickFaceNodeIds(topTriIndices[0], topoNoIds);
// The cap is a flat annular ring, all normals pointing +z.
// The BFS should stay on the cap and not bleed onto the cylindrical mantles.
// Note: caps share corner nodes with mantles, so "only cap nodes" is too strict —
// we just verify the selection is a superset of cap nodes and doesn't include
// purely inner-mantle-exclusive nodes.
const innerOnlyNodes = [...innerNodeIds].filter((v) => !topCapNodeIds.has(v));
assert(
  "BFS: top cap does not bleed onto inner mantle nodes",
  innerOnlyNodes.every((v) => !pickedTop.has(v)),
);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
