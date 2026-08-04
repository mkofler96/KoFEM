#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for the store → engine surface-load build (rebuildSurfaceLoads,
// src/store/boundarySlice.ts) with MULTIPLE selections and MULTIPLE groups.
//
// THE BUG THIS GUARDS (KOF-216): the builder emitted one surface load per picked
// SELECTION, each carrying the group's full force vector. A group's vector is its
// TOTAL, so a 1000 N load picked as three faces reached the engine as three
// separate 1000 N loads and pulled 3000 N — while the panel still said 1000 N.
// One load per GROUP, over the union of its selections, is what makes the engine
// spread the total over the whole loaded region (it divides by the area it
// matched).
//
// Run: bun tests/test_multi_load.mjs   (from the web/ directory)

import { rebuildSurfaceLoads } from "../src/store/boundarySlice.ts";

let passed = 0,
  failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? "  — " + detail : ""}`);
    failed++;
  }
}

// Four disjoint tets, so each face selection below picks out exactly one
// triangular element face.
const elements = [0, 1, 2, 3].map((i) => ({
  id: i,
  type: "CTETRA",
  nodeIds: [4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 3],
  propertyId: 1,
}));
const faceOf = (tet, id) => ({
  id,
  label: `Face ${id}`,
  nodeIds: [4 * tet, 4 * tet + 1, 4 * tet + 2],
});

const forceGroup = (id, components, faces) => ({
  id,
  name: `Load${id}`,
  dof: 1,
  totalForce: components[1],
  components,
  kind: "force",
  faces,
});

// Total force the engine will be asked to apply, summed over every emitted load.
const totalForce = (loads) =>
  loads.reduce(
    (acc, l) => acc.map((v, d) => v + (l.force ? l.force[d] : 0)),
    [0, 0, 0],
  );

console.log("\nMultiple surface loads (store → engine payload)\n");

// ── A group's total is shared across ALL its selections ──────────────────────
{
  const group = forceGroup(1, [0, -1000, 0], [faceOf(0, 1), faceOf(1, 2)]);
  const loads = rebuildSurfaceLoads([group], elements, []);
  assert("a two-face group emits ONE surface load", loads.length === 1);
  assert(
    "the group's total force is NOT multiplied by its face count",
    totalForce(loads)[1] === -1000,
    `got ${totalForce(loads)[1]}, expected -1000`,
  );
  assert(
    "both selections are in the emitted load's face list",
    loads[0].faces.length === 2,
    `got ${loads[0].faces.length} element faces`,
  );
}

// The multiplication grew with the selection count, so a four-face group is the
// case that made a load off by 4x.
{
  const faces = [0, 1, 2, 3].map((tet) => faceOf(tet, tet + 1));
  const loads = rebuildSurfaceLoads(
    [forceGroup(1, [0, -1000, 0], faces)],
    elements,
    [],
  );
  assert(
    "a four-face group still totals the group's force exactly once",
    loads.length === 1 && totalForce(loads)[1] === -1000,
    `${loads.length} load(s), total ${totalForce(loads)[1]}`,
  );
}

// ── Selections overlapping WITHIN a group count once ─────────────────────────
{
  // Two selections resolving to the same element face — e.g. a re-pick of a face
  // already in the group. Counting it twice would take a double share of the
  // traction and inflate the area the total is divided by.
  const group = forceGroup(1, [0, -1000, 0], [faceOf(0, 1), faceOf(0, 2)]);
  const loads = rebuildSurfaceLoads([group], elements, []);
  assert(
    "a duplicated selection contributes its element face once",
    loads.length === 1 && loads[0].faces.length === 1,
    `${loads.length} load(s), ${loads[0]?.faces.length} element face(s)`,
  );
}

// ── Several groups stay several loads ────────────────────────────────────────
{
  const g1 = forceGroup(1, [0, -1000, 0], [faceOf(0, 1)]);
  const g2 = forceGroup(2, [500, 0, 0], [faceOf(1, 2)]);
  const loads = rebuildSurfaceLoads([g1, g2], elements, []);
  assert("two load groups emit two surface loads", loads.length === 2);
  const total = totalForce(loads);
  assert(
    "each group contributes its own total",
    total[0] === 500 && total[1] === -1000,
    `got [${total.join(", ")}]`,
  );
}

// Two groups on the SAME face is the overlap the engine now integrates for both
// (see examples/validation/multiple-loads.test.mjs); the store must hand it over
// as two distinct loads rather than merging them.
{
  const g1 = forceGroup(1, [0, -1000, 0], [faceOf(0, 1)]);
  const g2 = forceGroup(2, [0, -1000, 0], [faceOf(0, 2)]);
  const loads = rebuildSurfaceLoads([g1, g2], elements, []);
  assert(
    "two groups on the same face stay two loads totalling both forces",
    loads.length === 2 && totalForce(loads)[1] === -2000,
    `${loads.length} load(s), total ${totalForce(loads)[1]}`,
  );
}

// ── Pressure is intensive: merging must not scale it ─────────────────────────
{
  const group = {
    id: 1,
    name: "Load1",
    dof: 0,
    totalForce: 10,
    kind: "pressure",
    faces: [faceOf(0, 1), faceOf(1, 2)],
  };
  const loads = rebuildSurfaceLoads([group], elements, []);
  assert(
    "a two-face pressure group emits one load at the prescribed magnitude",
    loads.length === 1 &&
      loads[0].type === "pressure" &&
      loads[0].pressure === 10 &&
      loads[0].faces.length === 2,
    JSON.stringify(loads),
  );
}

// ── Moment groups still bypass the surface path ──────────────────────────────
{
  const group = {
    id: 1,
    name: "Load1",
    dof: 5,
    totalForce: 1000,
    components: [0, 0, 1000],
    kind: "moment",
    faces: [faceOf(0, 1), faceOf(1, 2)],
  };
  assert(
    "a moment group emits no surface load (it becomes equivalent nodal forces)",
    rebuildSurfaceLoads([group], elements, []).length === 0,
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
