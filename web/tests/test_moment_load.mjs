#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for the pure moment → equivalent-nodal-forces conversion
// (src/store/momentLoad.ts, extracted in issue #202).
//
// The conversion applies tangential forces F_i = M/S·(n̂×r_i) with
// S = Σ|r_i⊥|², which must reproduce the applied moment exactly
// (Σ r_i × F_i = M) with zero net force.
//
// Run: bun tests/test_moment_load.mjs   (from the web/ directory)

import { momentToNodalForces } from "../src/store/momentLoad.ts";

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

function near(a, b, tol = 1e-9) {
  return Math.abs(a - b) < tol;
}

// Sum the nodal loads into net force [Fx,Fy,Fz] and net moment [Mx,My,Mz]
// about the centroid of the given nodes.
function resultants(loads, nodeById) {
  let n = 0;
  const centroid = [0, 0, 0];
  for (const node of nodeById.values()) {
    centroid[0] += node.x;
    centroid[1] += node.y;
    centroid[2] += node.z;
    n++;
  }
  centroid[0] /= n;
  centroid[1] /= n;
  centroid[2] /= n;

  const force = [0, 0, 0];
  const moment = [0, 0, 0];
  for (const l of loads) {
    const node = nodeById.get(l.nodeId);
    const nodalForce = [0, 0, 0];
    nodalForce[l.dof] = l.value;
    const arm = [
      node.x - centroid[0],
      node.y - centroid[1],
      node.z - centroid[2],
    ];
    force[0] += nodalForce[0];
    force[1] += nodalForce[1];
    force[2] += nodalForce[2];
    moment[0] += arm[1] * nodalForce[2] - arm[2] * nodalForce[1];
    moment[1] += arm[2] * nodalForce[0] - arm[0] * nodalForce[2];
    moment[2] += arm[0] * nodalForce[1] - arm[1] * nodalForce[0];
  }
  return { force, moment };
}

function nodeMap(nodes) {
  return new Map(nodes.map((n) => [n.id, n]));
}

// ── Test 1: Mz on a square face in the xy-plane ───────────────────────────────

console.log("Test 1: Mz over a square face reproduces the moment exactly");

const square = nodeMap([
  { id: 1, x: 0, y: 0, z: 0 },
  { id: 2, x: 10, y: 0, z: 0 },
  { id: 3, x: 10, y: 10, z: 0 },
  { id: 4, x: 0, y: 10, z: 0 },
]);
const squareFace = [{ nodeIds: [1, 2, 3, 4] }];

{
  const appliedMoment = 500;
  const loads = momentToNodalForces(
    [0, 0, appliedMoment],
    squareFace,
    square,
    "Load1",
  );
  const { force, moment } = resultants(loads, square);
  assert("produces nodal loads", loads.length > 0);
  assert(
    "zero net force",
    near(force[0], 0) && near(force[1], 0) && near(force[2], 0),
  );
  assert(
    "net moment equals applied Mz",
    near(moment[0], 0) && near(moment[1], 0) && near(moment[2], appliedMoment),
  );
  assert(
    "forces are tangential (no z components)",
    loads.every((l) => l.dof === 0 || l.dof === 1),
  );
}

// ── Test 2: componentwise moment is the superposition of its axes ─────────────

console.log("\nTest 2: componentwise [Mx,0,Mz] superposes the per-axis loads");

{
  const combined = momentToNodalForces(
    [300, 0, -200],
    squareFace,
    square,
    "Load1",
  );
  const { force, moment } = resultants(combined, square);
  assert(
    "zero net force",
    near(force[0], 0) && near(force[1], 0) && near(force[2], 0),
  );
  assert(
    "net moment equals [300, 0, -200]",
    near(moment[0], 300) && near(moment[1], 0) && near(moment[2], -200),
  );

  const mx = momentToNodalForces([300, 0, 0], squareFace, square, "Load1");
  const mz = momentToNodalForces([0, 0, -200], squareFace, square, "Load1");
  assert(
    "combined load count = sum of per-axis counts",
    combined.length === mx.length + mz.length,
  );
}

// ── Test 3: zero moment produces no loads ─────────────────────────────────────

console.log("\nTest 3: zero moment vector produces no loads");

{
  const loads = momentToNodalForces([0, 0, 0], squareFace, square, "Load1");
  assert("no loads generated", loads.length === 0);
}

// ── Test 4: face collinear with the moment axis is skipped ────────────────────

console.log("\nTest 4: face whose nodes all lie on the moment axis is skipped");

{
  // All nodes on the x-axis → S = 0 for Mx; the face cannot carry the moment.
  const line = nodeMap([
    { id: 1, x: 0, y: 0, z: 0 },
    { id: 2, x: 5, y: 0, z: 0 },
    { id: 3, x: 10, y: 0, z: 0 },
  ]);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  const loads = momentToNodalForces(
    [100, 0, 0],
    [{ nodeIds: [1, 2, 3] }],
    line,
    "Load7",
  );
  console.warn = origWarn;
  assert("no loads generated", loads.length === 0);
  assert(
    "a warning names the group and axis",
    warnings.length === 1 &&
      warnings[0].includes('"Load7"') &&
      warnings[0].includes("Mx"),
  );
}

// ── Test 5: multiple faces each carry the full moment ─────────────────────────

console.log("\nTest 5: each face carries the full applied moment");

{
  // Two parallel square faces stacked in z; the conversion is per-face, so the
  // total transferred moment is M per face (matching rebuildLoads semantics,
  // where a group's faces each receive the group moment).
  const nodes = nodeMap([
    { id: 1, x: 0, y: 0, z: 0 },
    { id: 2, x: 10, y: 0, z: 0 },
    { id: 3, x: 10, y: 10, z: 0 },
    { id: 4, x: 0, y: 10, z: 0 },
    { id: 5, x: 0, y: 0, z: 10 },
    { id: 6, x: 10, y: 0, z: 10 },
    { id: 7, x: 10, y: 10, z: 10 },
    { id: 8, x: 0, y: 10, z: 10 },
  ]);
  const faces = [{ nodeIds: [1, 2, 3, 4] }, { nodeIds: [5, 6, 7, 8] }];
  const appliedMoment = 240;
  const loads = momentToNodalForces(
    [0, 0, appliedMoment],
    faces,
    nodes,
    "Load1",
  );
  const { force, moment } = resultants(loads, nodes);
  assert(
    "zero net force",
    near(force[0], 0) && near(force[1], 0) && near(force[2], 0),
  );
  assert(
    "net moment is M per face (2·M total)",
    near(moment[2], 2 * appliedMoment),
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
