// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/densityField.ts — the topology-optimization density
// result → viewport geometry helpers (KOF-233): the solver-order element
// mapping, the visibility threshold count, the grayscale ramp, and the
// boundary-surface extraction of the retained element set.
//
// The surface extraction is the delicate part: a face shared by two kept
// elements is interior and must NOT be drawn, or the emerged shape fills with
// hidden internal triangles; a face kept by exactly one element is on the
// surface and is drawn once. Two tets sharing a face exercise both cases.
//
// Run:  bun tests/test_density_field.mjs

import {
  orderedDesignElements,
  visibleElementCount,
  densityColor,
  buildDensitySurface,
} from "../src/lib/densityField.ts";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Two tets sharing the triangular face {1,2,3}.
const nodes = [
  { id: 0, x: 0, y: 0, z: 0 },
  { id: 1, x: 1, y: 0, z: 0 },
  { id: 2, x: 0, y: 1, z: 0 },
  { id: 3, x: 0, y: 0, z: 1 },
  { id: 4, x: 1, y: 1, z: 1 },
];
const tetA = { id: 10, type: "CTETRA", nodeIds: [0, 1, 2, 3], propertyId: 1 };
const tetB = { id: 11, type: "CTETRA", nodeIds: [1, 2, 3, 4], propertyId: 1 };
const twoTets = [tetA, tetB];

// ── orderedDesignElements: tets, then hexes, then shell facets ────────────────
{
  const hex = {
    id: 20,
    type: "CHEXA",
    nodeIds: [0, 1, 2, 3, 4, 5, 6, 7],
    propertyId: 1,
  };
  const shell = { id: 21, type: "CTRIA3", nodeIds: [0, 1, 2], propertyId: 1 };
  const ordered = orderedDesignElements([hex, tetA, shell, tetB]);
  check(
    "orderedDesignElements orders tets, then hexes, then shell facets",
    ordered.length === 4 &&
      ordered[0].id === tetA.id &&
      ordered[1].id === tetB.id &&
      ordered[2].id === hex.id &&
      ordered[3].id === shell.id,
    `got ${ordered.map((e) => e.id).join(",")}`,
  );
}

// ── buildDensitySurface: a kept shell facet draws its own triangle ────────────
{
  const shellNodes = [
    { id: 0, x: 0, y: 0, z: 0 },
    { id: 1, x: 1, y: 0, z: 0 },
    { id: 2, x: 0, y: 1, z: 0 },
  ];
  const shell = { id: 30, type: "CTRIA3", nodeIds: [0, 1, 2], propertyId: 1 };
  const kept = buildDensitySurface(
    shellNodes,
    [shell],
    new Float64Array([0.9]),
    0.5,
  );
  check(
    "a shell facet above the threshold is drawn as one triangle",
    kept !== null && kept.triangleCount === 1,
    kept === null ? "got null" : `got ${kept.triangleCount} triangles`,
  );
  check(
    "a shell facet below the threshold is dropped",
    buildDensitySurface(shellNodes, [shell], new Float64Array([0.1]), 0.5) ===
      null,
  );
}

// ── visibleElementCount ──────────────────────────────────────────────────────
{
  const density = new Float64Array([0.2, 0.6, 0.9, 0.5]);
  check(
    "visibleElementCount counts density >= threshold (0.5)",
    visibleElementCount(density, 0.5) === 3,
    `got ${visibleElementCount(density, 0.5)}`,
  );
  check(
    "visibleElementCount at 0 keeps every element",
    visibleElementCount(density, 0) === 4,
  );
  check(
    "visibleElementCount above the max keeps none",
    visibleElementCount(density, 1.01) === 0,
  );
}

// ── densityColor: dense = dark ───────────────────────────────────────────────
{
  const low = densityColor(0);
  const high = densityColor(1);
  check(
    "densityColor maps full density to a darker grey than empty",
    high.r < low.r && high.g < low.g && high.b < low.b,
    `low.r=${low.r.toFixed(3)} high.r=${high.r.toFixed(3)}`,
  );
}

// ── buildDensitySurface: interior face dropped, boundary faces kept ───────────
{
  // Both tets kept: the shared face is interior, so 3 + 3 = 6 boundary tris.
  const bothKept = buildDensitySurface(
    nodes,
    twoTets,
    new Float64Array([0.9, 0.9]),
    0.5,
  );
  check(
    "both tets kept → shared face dropped, 6 boundary triangles",
    bothKept !== null && bothKept.triangleCount === 6,
    bothKept ? `got ${bothKept.triangleCount}` : "got null",
  );
  check(
    "buffers are triangleCount*9 long and consistent",
    bothKept !== null &&
      bothKept.positions.length === bothKept.triangleCount * 9 &&
      bothKept.normals.length === bothKept.triangleCount * 9 &&
      bothKept.colors.length === bothKept.triangleCount * 9,
  );

  // Only tet A kept: all four of its faces are on the surface → 4 tris.
  const oneKept = buildDensitySurface(
    nodes,
    twoTets,
    new Float64Array([0.9, 0.1]),
    0.5,
  );
  check(
    "one tet kept → all four faces drawn (4 triangles)",
    oneKept !== null && oneKept.triangleCount === 4,
    oneKept ? `got ${oneKept.triangleCount}` : "got null",
  );

  // Every element below threshold → nothing to draw.
  check(
    "all elements below threshold → null",
    buildDensitySurface(nodes, twoTets, new Float64Array([0.1, 0.1]), 0.5) ===
      null,
  );

  // Stale density (length ≠ element count) → null, never a mismatched draw.
  check(
    "density length mismatch → null (stale guard)",
    buildDensitySurface(nodes, twoTets, new Float64Array([0.9]), 0.5) === null,
  );
}

console.log(
  failures === 0
    ? "\nAll density-field tests passed."
    : `\n${failures} density-field test(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
