// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The repair suggestion for a mesh that overlapped itself: which overlaps are
// offered, and the width it starts from.

import assert from "node:assert/strict";
import {
  coneTipFaces,
  defaultRepairWidth,
  hingeRepairs,
  narrowestUnmeshedWidth,
  removableUnmeshedFaces,
  soupOutline,
  unmeshedFaces,
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

// Faces the mesher gave up on are counted once each, apart from overlaps.
const unmeshed = {
  ...surface,
  kind: "unmeshed",
  faceIds: new Int32Array([60]),
  width: 0.01,
};
const unmeshedToo = {
  ...unmeshed,
  faceIds: new Int32Array([113]),
  width: 0.001,
};
assert.deepEqual(
  unmeshedFaces([surface, hinge, cone, unmeshed, unmeshedToo]),
  [60, 113],
);
assert.deepEqual(unmeshedFaces([unmeshed, unmeshed]), [60]);
assert.deepEqual(unmeshedFaces([surface, hinge, cone]), []);
assert.deepEqual(hingeRepairs([unmeshed]), []);
assert.deepEqual(coneTipFaces([unmeshed]), []);
// The message quotes the narrowest of them; a face without a width is a bug.
assert.equal(narrowestUnmeshedWidth([surface, unmeshed, unmeshedToo]), 0.001);
assert.equal(narrowestUnmeshedWidth([surface, hinge]), null);
assert.throws(() =>
  narrowestUnmeshedWidth([{ ...unmeshed, width: undefined }]),
);
// Only faces narrower than the minimum element size are offered for removal:
// a wider face needs smaller elements, not a different shape.
const wide = { ...unmeshed, faceIds: new Int32Array([6]), width: 7.3 };
assert.deepEqual(
  removableUnmeshedFaces([unmeshed, unmeshedToo, wide, hinge], "0.12"),
  [60, 113],
);
assert.deepEqual(removableUnmeshedFaces([wide], "2"), []);
assert.deepEqual(removableUnmeshedFaces([unmeshed], ""), []);
assert.deepEqual(removableUnmeshedFaces([unmeshed], "0"), []);

// A face's outline from its triangle soup: a unit square of two triangles has
// four boundary edges; the shared diagonal is not one of them.
const square = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0];
const outline = soupOutline(square);
assert.equal(outline.length, 4 * 6);
for (let at = 0; at < outline.length; at += 6) {
  const [x0, y0, , x1, y1] = outline.slice(at, at + 6);
  assert.ok(!(x0 !== x1 && y0 !== y1), "the diagonal is not an outline edge");
}
assert.throws(() => soupOutline([0, 0, 0]));

// The width follows the element size; no usable size means the field asks.
assert.equal(defaultRepairWidth("2"), "3");
assert.equal(defaultRepairWidth("0.333333"), "0.5");
assert.equal(defaultRepairWidth(""), "");
assert.equal(defaultRepairWidth("0"), "");
assert.equal(defaultRepairWidth("-1"), "");

console.log("✓ mesh overlap repair suggestions");
