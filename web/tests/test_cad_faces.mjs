#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for the geometry view's CAD-face helpers (src/lib/cadFaces.ts):
// the face outline that makes a split visible, the picked-face overlay and the
// cutting-plane preview.
//
// Run: bun tests/test_cad_faces.mjs   (from the web/ directory)

import {
  cadFaceOutline,
  cadFaceTriangles,
  planePreview,
  tessellationBounds,
} from "../src/lib/cadFaces.ts";

let failed = 0;
function check(label, ok, detail = "") {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failed++;
}

// A 10 × 4 strip split at x = 5 into two CAD faces, tessellated the way OCCT
// does it: each face on its own vertex set (face 1: 0–3, face 2: 4–7), so the
// split line x = 5 exists twice, once per face.
const surface = {
  points: [
    [0, 0, 0],
    [5, 0, 0],
    [5, 4, 0],
    [0, 4, 0],
    [5, 0, 0],
    [10, 0, 0],
    [10, 4, 0],
    [5, 4, 0],
  ],
  triangles: [
    [0, 1, 2],
    [0, 2, 3],
    [4, 5, 6],
    [4, 6, 7],
  ],
  faceIds: [1, 1, 2, 2],
};

const outline = cadFaceOutline(surface);
const segments = outline.length / 6;
check(
  "each face's 4 boundary edges, none of its diagonals",
  segments === 8,
  String(segments),
);
let atSplit = 0;
for (let k = 0; k < outline.length; k += 6)
  if (outline[k] === 5 && outline[k + 3] === 5) atSplit++;
check(
  "the split line is drawn (once per face)",
  atSplit === 2,
  String(atSplit),
);

const body = cadFaceOutline(surface, [2, 3]);
check(
  "restricted to one face's triangles, only its outline",
  body.length / 6 === 4,
);

const picked = cadFaceTriangles(surface, [2]);
check(
  "the picked-face overlay holds that face's two triangles",
  picked.length === 18,
);
check(
  "…and only its vertices",
  [...picked].filter((_, i) => i % 3 === 0).every((x) => x >= 5),
);

const bounds = tessellationBounds(surface.points);
check(
  "bounds span the tessellation",
  JSON.stringify(bounds) ===
    JSON.stringify({ min: [0, 0, 0], max: [10, 4, 0] }),
);
check("an empty tessellation has no bounds", tessellationBounds([]) === null);

const plane = planePreview(bounds, 0, 5);
const xs = new Set([...plane].filter((_, i) => i % 3 === 0));
check("the plane preview lies on x = 5", xs.size === 1 && xs.has(5));
const ys = [...plane].filter((_, i) => i % 3 === 1);
check(
  "…and overhangs the model by a margin",
  Math.min(...ys) < 0 && Math.max(...ys) > 4,
  `${Math.min(...ys)}…${Math.max(...ys)}`,
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll CAD-face checks passed");
