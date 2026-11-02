// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The repair suggestion for a mesh that overlapped itself: which overlaps are
// offered, and the width it starts from.

import assert from "node:assert/strict";
import {
  coneTipFaces,
  defaultRepairWidth,
  hingeRepairs,
} from "../src/lib/meshOverlaps.ts";

const hinge = {
  kind: "hinge",
  faceIds: new Int32Array([46, 54]),
  bodyId: 2,
  positions: new Float64Array(9),
  hinge: {
    start: new Float64Array([-9, 21.05, 5.9]),
    end: new Float64Array([-9, 21.05, 13.24]),
    normal: new Float64Array([1, 0, 0]),
    length: 7.34,
  },
};
const surface = {
  kind: "surface",
  faceIds: new Int32Array([172]),
  bodyId: 1,
  positions: new Float64Array(9),
};

// Only hinges are repairable, as plain arrays the engine's JSON can carry.
assert.deepEqual(hingeRepairs([surface, hinge]), [
  {
    bodyId: 2,
    start: [-9, 21.05, 5.9],
    end: [-9, 21.05, 13.24],
    normal: [1, 0, 0],
  },
]);
assert.deepEqual(hingeRepairs([surface]), []);

// Only cone overlaps offer their faces for the cone split.
const cone = { ...surface, kind: "cone", faceIds: new Int32Array([7, 8]) };
assert.deepEqual(coneTipFaces([surface, hinge, cone]), [7, 8]);
assert.deepEqual(coneTipFaces([surface, hinge]), []);
// Separate overlaps on one face still name it once: the engine refuses duplicates.
const sameFace = { ...cone, faceIds: new Int32Array([8, 9]) };
assert.deepEqual(coneTipFaces([cone, sameFace]), [7, 8, 9]);

// The width follows the element size; no usable size means the field asks.
assert.equal(defaultRepairWidth("2"), "3");
assert.equal(defaultRepairWidth("0.333333"), "0.5");
assert.equal(defaultRepairWidth(""), "");
assert.equal(defaultRepairWidth("0"), "");
assert.equal(defaultRepairWidth("-1"), "");

console.log("✓ mesh overlap repair suggestions");
