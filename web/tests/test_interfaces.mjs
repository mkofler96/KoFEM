// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/interfaces.ts — the body-to-body interfaces of a
// multibody assembly (KOF-170), detected from which bodies own each CAD face
// of the tessellation, and the bodies left unbonded.
//
// Run:  bun tests/test_interfaces.mjs

import {
  detectInterfaces,
  interfaceLabel,
  restoreInterfaces,
  unconnectedBodies,
} from "../src/lib/interfaces.ts";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function throws(name, fn, pattern) {
  try {
    fn();
    check(name, false, "did not throw");
  } catch (err) {
    check(name, pattern.test(err.message), err.message);
  }
}

// A tessellation with one triangle per (face, body) entry: the engine emits a
// face shared by two solids once under each of them.
function tess(entries) {
  return {
    points: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    triangles: entries.map(() => [0, 1, 2]),
    bodyIds: entries.map(([, body]) => body),
    faceIds: entries.map(([face]) => face),
  };
}

const bodies = (n, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    materialId: 1,
    ...(extra[i + 1] ?? {}),
  }));

console.log("\ndetectInterfaces");

// Three bodies in a row: 1 and 2 share faces 7 and 9 (a split mating face),
// 2 and 3 share face 12; face 3 is body 1's own, face 15 body 3's own.
const row = tess([
  [3, 1],
  [7, 1],
  [7, 1], // a second triangle on the same face
  [9, 1],
  [7, 2],
  [9, 2],
  [12, 2],
  [12, 3],
  [15, 3],
]);
const found = detectInterfaces(row);
check("two body pairs found", found.length === 2, JSON.stringify(found));
check(
  "1 ↔ 2 groups both shared faces, ascending",
  found[0].bodyA === 1 &&
    found[0].bodyB === 2 &&
    JSON.stringify(found[0].faceIds) === "[7,9]",
  JSON.stringify(found[0]),
);
check(
  "2 ↔ 3 on face 12",
  found[1].bodyA === 2 &&
    found[1].bodyB === 3 &&
    JSON.stringify(found[1].faceIds) === "[12]",
  JSON.stringify(found[1]),
);
check(
  "ids are 1-based in pair order, all bonded",
  found.map((i) => i.id).join() === "1,2" &&
    found.every((i) => i.type === "bonded"),
);
check(
  "label names both bodies",
  interfaceLabel(found[0]) === "Body 1 ↔ Body 2",
);

check(
  "body order in the tessellation does not matter",
  JSON.stringify(
    detectInterfaces(
      tess([
        [5, 2],
        [5, 1],
      ]),
    ),
  ) ===
    JSON.stringify([
      { id: 1, bodyA: 1, bodyB: 2, faceIds: [5], type: "bonded" },
    ]),
);
check("no tessellation: none", detectInterfaces(null).length === 0);
check(
  "single body: none",
  detectInterfaces(
    tess([
      [1, 1],
      [2, 1],
    ]),
  ).length === 0,
);
const legacyNoBodies = { ...row, bodyIds: undefined, faceIds: undefined };
check(
  "saved before body ids (one body): none",
  detectInterfaces(legacyNoBodies).length === 0,
);
check(
  "saved before face ids: unknown (null), not none",
  detectInterfaces({ ...row, faceIds: undefined }) === null,
);
throws(
  "a face owned by three bodies is refused",
  () =>
    detectInterfaces(
      tess([
        [4, 1],
        [4, 2],
        [4, 3],
      ]),
    ),
  /face 4 is owned by 3 bodies/,
);
throws(
  "misaligned id arrays are refused",
  () => detectInterfaces({ ...row, faceIds: [1] }),
  /9 triangles but 9 body ids and 1 face ids/,
);

console.log("\nunconnectedBodies");

// Body 4 touches nothing.
const withLoose = detectInterfaces(
  tess([
    [7, 1],
    [7, 2],
    [12, 2],
    [12, 3],
    [20, 4],
  ]),
);
check(
  "a body with no interface is flagged",
  JSON.stringify(unconnectedBodies(withLoose, bodies(4))) === "[4]",
);
check(
  "suppressing its only partner leaves a body unbonded",
  JSON.stringify(
    unconnectedBodies(withLoose, bodies(4, { 2: { suppressed: true } })),
  ) === "[1,3,4]",
);
check(
  "a suppressed body is not flagged itself",
  JSON.stringify(
    unconnectedBodies(withLoose, bodies(4, { 4: { suppressed: true } })),
  ) === "[]",
);
check(
  "one body left in the model: nothing to bond to, no flag",
  unconnectedBodies([], bodies(1)).length === 0,
);
check(
  "interfaces unknown: no flag",
  unconnectedBodies(null, bodies(3)).length === 0,
);
check(
  "a derived shell section is not a body",
  unconnectedBodies(found, [
    ...bodies(3),
    { id: 4, materialId: 1, sourceBodyId: 2 },
  ]).length === 0,
);

console.log("\nrestoreInterfaces");

check(
  "files before interfaces: re-detected",
  JSON.stringify(restoreInterfaces(row, undefined)) === JSON.stringify(found),
);
check(
  "a matching saved list round-trips",
  JSON.stringify(restoreInterfaces(row, found)) === JSON.stringify(found),
);
throws(
  "a list that disagrees with the geometry is refused",
  () => restoreInterfaces(row, [found[0], { ...found[1], faceIds: [13] }]),
  /interface 2 does not match the geometry/,
);
throws(
  "a missing interface is refused",
  () => restoreInterfaces(row, [found[0]]),
  /lists 1 interface\(s\), but its geometry has 2/,
);
throws(
  "an unknown type is refused",
  () => restoreInterfaces(row, [found[0], { ...found[1], type: "glued" }]),
  /unknown type "glued"/,
);
throws(
  "interfaces without face ids to check them against are refused",
  () => restoreInterfaces({ ...row, faceIds: undefined }, found),
  /no CAD face ids/,
);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll interface checks passed");
