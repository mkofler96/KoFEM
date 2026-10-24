// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for bodiesLeftOutOfMesh (src/lib/suppressBodies.ts): which CAD
// bodies a saved mesh leaves out, read from the mesh rather than from the
// suppression flags, which may have changed after meshing.
//
// Run:  bun tests/test_suppression_snapshot.mjs

import { bodiesLeftOutOfMesh } from "../src/lib/suppressBodies.ts";

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(
      `  [FAIL] ${name} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

const els = (...propertyIds) =>
  propertyIds.map((propertyId) => ({ propertyId }));

check(
  "every body meshed → nothing left out",
  bodiesLeftOutOfMesh([{ id: 1 }, { id: 2 }], els(1, 1, 2)),
  [],
);
check(
  "a body with no elements was left out, whatever its flag says",
  bodiesLeftOutOfMesh([{ id: 1 }, { id: 2, suppressed: false }], els(1, 1)),
  [2],
);
check(
  "a body suppressed after meshing is still in the mesh",
  bodiesLeftOutOfMesh([{ id: 1 }, { id: 2, suppressed: true }], els(1, 2)),
  [],
);
check(
  "a Shell body meshed only through its derived PSHELL counts as meshed",
  bodiesLeftOutOfMesh(
    [{ id: 1 }, { id: 2 }, { id: 3, sourceBodyId: 2 }],
    els(1, 3, 3),
  ),
  [],
);
check(
  "a derived PSHELL is never reported as a left-out body",
  bodiesLeftOutOfMesh([{ id: 1 }, { id: 3, sourceBodyId: 2 }], els(1)),
  [],
);

let threw = false;
try {
  bodiesLeftOutOfMesh([{ id: 1 }], [{}]);
} catch (err) {
  threw = String(err).includes("no propertyId");
}
check("an element without a propertyId is an error", threw, true);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll suppression-snapshot checks passed");
