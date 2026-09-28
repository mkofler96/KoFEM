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
  buildSmoothDensitySurface,
  levelSetField,
  nodalDensity,
  buildDensityStl,
  buildSmoothDensityStl,
  densityStlFileName,
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

// ── Smooth boundary: nodal field + isosurface ─────────────────────────────────
{
  // nodalDensity: two tets of equal volume share face {1,2,3}; density 1 and 0
  // → the three shared nodes average to 0.5, the private ones keep their own.
  const volA = 1 / 6;
  const volB = 1 / 3; // tetB = (1,0,0),(0,1,0),(0,0,1),(1,1,1): volume 1/3
  const nd = nodalDensity(nodes, twoTets, new Float64Array([1, 0]));
  const shared = volA / (volA + volB);
  check(
    "nodalDensity: volume-weighted average at shared nodes",
    nd !== null &&
      Math.abs(nd[0] - 1) < 1e-12 &&
      Math.abs(nd[4]) < 1e-12 &&
      [1, 2, 3].every((i) => Math.abs(nd[i] - shared) < 1e-12),
    nd ? `got ${Array.from(nd)}` : "got null",
  );
  check(
    "nodalDensity: stale density → null",
    nodalDensity(nodes, twoTets, new Float64Array([1])) === null,
  );
  const lsf = levelSetField(new Float64Array([-1, 0, 1]));
  check(
    "levelSetField maps φ = −1, 0, 1 to 0, 0.5, 1",
    lsf[0] === 0 && lsf[1] === 0.5 && lsf[2] === 1,
  );

  // One tet, field 1 at node 0 and 0 elsewhere, level 0.5: the iso triangle
  // through the three edge midpoints of node 0, plus the three boundary faces
  // through node 0 clipped to their corner triangles → 4 triangles.
  const field = new Float64Array([1, 0, 0, 0, 0]);
  const one = buildSmoothDensitySurface(nodes, [tetA], field, 0.5);
  check(
    "single tet corner → 1 iso + 3 cap triangles",
    one !== null && one.triangleCount === 4,
    one ? `got ${one.triangleCount}` : "got null",
  );
  if (one) {
    // The first triangle is the iso triangle: its vertices are the midpoints
    // (0.5,0,0), (0,0.5,0), (0,0,0.5), and its normal points away from node 0.
    const pts = [0, 1, 2].map((k) => one.positions.slice(3 * k, 3 * k + 3));
    const midpoints = pts.every(
      (pt) =>
        Math.abs(pt[0] + pt[1] + pt[2] - 0.5) < 1e-6 &&
        [...pt].filter((c) => Math.abs(c) < 1e-9).length === 2,
    );
    check("iso triangle passes through the edge midpoints", midpoints);
    const nrm = one.normals.slice(0, 3);
    check(
      "iso normal points out of the material (away from node 0)",
      nrm[0] > 0 && nrm[1] > 0 && nrm[2] > 0,
      `normal ${Array.from(nrm)}`,
    );
  }
  check(
    "nothing inside → null",
    buildSmoothDensitySurface(nodes, [tetA], field, 1.5) === null,
  );
  check(
    "stale field (length ≠ nodes) → null",
    buildSmoothDensitySurface(nodes, [tetA], new Float64Array(2), 0.5) === null,
  );

  // Watertightness on a Kuhn-split 4×4×4 cube grid: the boundary of {f ≥ level}
  // must be a closed surface — every edge shared by exactly two triangles — both
  // for a ball inside the domain (isosurface only) and one cut by the domain
  // boundary (isosurface + caps).
  const cells = 4;
  const gridNodes = [];
  const nid = (i, j, k) => i + (cells + 1) * (j + (cells + 1) * k);
  for (let k = 0; k <= cells; k++)
    for (let j = 0; j <= cells; j++)
      for (let i = 0; i <= cells; i++)
        gridNodes.push({ id: nid(i, j, k), x: i, y: j, z: k });
  const gridTets = [];
  const kuhn = [
    [0, 1, 2, 6],
    [0, 1, 5, 6],
    [0, 4, 5, 6],
    [0, 4, 7, 6],
    [0, 3, 7, 6],
    [0, 3, 2, 6],
  ];
  for (let k = 0; k < cells; k++)
    for (let j = 0; j < cells; j++)
      for (let i = 0; i < cells; i++) {
        const corner = [
          nid(i, j, k),
          nid(i + 1, j, k),
          nid(i + 1, j + 1, k),
          nid(i, j + 1, k),
          nid(i, j, k + 1),
          nid(i + 1, j, k + 1),
          nid(i + 1, j + 1, k + 1),
          nid(i, j + 1, k + 1),
        ];
        for (const t of kuhn)
          gridTets.push({
            id: gridTets.length,
            type: "CTETRA",
            nodeIds: t.map((v) => corner[v]),
            propertyId: 1,
          });
      }
  const closed = (surface) => {
    const key = (o) =>
      Array.from(surface.positions.slice(o, o + 3))
        .map((v) => v.toFixed(5))
        .join(",");
    const edges = new Map();
    for (let t = 0; t < surface.triangleCount; t++) {
      const vs = [0, 1, 2].map((m) => key(9 * t + 3 * m));
      for (let m = 0; m < 3; m++) {
        const edge = [vs[m], vs[(m + 1) % 3]].sort().join("|");
        edges.set(edge, (edges.get(edge) ?? 0) + 1);
      }
    }
    return [...edges.values()].every((n) => n === 2);
  };
  const ball = (cx, cy, cz, r) =>
    new Float64Array(
      gridNodes.map((n) => r - Math.hypot(n.x - cx, n.y - cy, n.z - cz)),
    );
  const inner = buildSmoothDensitySurface(
    gridNodes,
    gridTets,
    ball(2, 2, 2, 1.3),
    0,
  );
  check(
    "ball inside the domain → closed isosurface",
    inner !== null && closed(inner),
  );
  const cut = buildSmoothDensitySurface(
    gridNodes,
    gridTets,
    ball(0.2, 0.3, 0.1, 2.4),
    0,
  );
  check(
    "ball cut by the domain boundary → closed (isosurface + caps)",
    cut !== null && closed(cut),
  );
}

// ── buildDensityStl (KOF-239) ─────────────────────────────────────────────────
// Parse a binary STL back into triangles so the checks read the bytes a viewer
// would, not the in-memory surface.
function parseStl(buffer) {
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  const tris = [];
  for (let t = 0; t < count; t++) {
    const base = 84 + t * 50;
    const float = (k) => view.getFloat32(base + k * 4, true);
    tris.push({
      normal: [float(0), float(1), float(2)],
      v: [
        [float(3), float(4), float(5)],
        [float(6), float(7), float(8)],
        [float(9), float(10), float(11)],
      ],
    });
  }
  const header = String.fromCharCode(...new Uint8Array(buffer, 0, 5));
  return { count, tris, header, byteLength: buffer.byteLength };
}

// Enclosed volume by the divergence theorem, Σ v0·(v1×v2)/6. It equals the
// solid's volume only if the surface is closed AND every triangle is wound
// outward; an inward face subtracts instead, so this checks both at once.
function signedVolume(tris) {
  let vol = 0;
  for (const { v } of tris) {
    const [a, b, c] = v;
    vol +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return vol;
}

{
  const stl = buildDensityStl(
    nodes,
    twoTets,
    new Float64Array([0.9, 0.9]),
    0.5,
  );
  const parsed = stl && parseStl(stl);
  check(
    "STL of two kept tets: 6 triangles, 84 + 50·n bytes",
    parsed !== null && parsed.count === 6 && parsed.byteLength === 84 + 6 * 50,
    parsed ? `count=${parsed.count} bytes=${parsed.byteLength}` : "got null",
  );
  check(
    "STL header does not start with 'solid' (would read as ASCII STL)",
    parsed !== null && parsed.header !== "solid",
  );
  // tet A = 1/6, tet B = 1/3.
  const vol = parsed ? signedVolume(parsed.tris) : NaN;
  check(
    "STL surface is closed and outward-wound (encloses 0.5)",
    Math.abs(vol - 0.5) < 1e-6,
    `signed volume ${vol}`,
  );
  check(
    "STL facet normals point outward (agree with the winding)",
    parsed !== null &&
      parsed.tris.every(({ normal, v }) => {
        const [a, b, c] = v;
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const cross = [
          ab[1] * ac[2] - ab[2] * ac[1],
          ab[2] * ac[0] - ab[0] * ac[2],
          ab[0] * ac[1] - ab[1] * ac[0],
        ];
        return (
          normal[0] * cross[0] + normal[1] * cross[1] + normal[2] * cross[2] > 0
        );
      }),
  );
}

{
  // A tet with inverted node ordering (negative Jacobian) still exports
  // outward: orientation comes from the element centroid, not the node order.
  const inverted = {
    id: 12,
    type: "CTETRA",
    nodeIds: [0, 2, 1, 3],
    propertyId: 1,
  };
  const stl = buildDensityStl(nodes, [inverted], new Float64Array([1]), 0.5);
  const vol = stl ? signedVolume(parseStl(stl).tris) : NaN;
  check(
    "inverted tet ordering still exports outward (volume +1/6)",
    Math.abs(vol - 1 / 6) < 1e-6,
    `signed volume ${vol}`,
  );
}

{
  // Unit cube as one CHEXA: 6 quads → 12 triangles enclosing volume 1.
  const cubeNodes = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ].map(([x, y, z], id) => ({ id, x, y, z }));
  const hex = {
    id: 40,
    type: "CHEXA",
    nodeIds: [0, 1, 2, 3, 4, 5, 6, 7],
    propertyId: 1,
  };
  const stl = buildDensityStl(cubeNodes, [hex], new Float64Array([1]), 0.5);
  const parsed = stl && parseStl(stl);
  const vol = parsed ? signedVolume(parsed.tris) : NaN;
  check(
    "hex exports as 12 outward triangles enclosing volume 1",
    parsed !== null && parsed.count === 12 && Math.abs(vol - 1) < 1e-6,
    parsed ? `count=${parsed.count} volume=${vol}` : "got null",
  );
}

check(
  "STL with every element below threshold → null (nothing to export)",
  buildDensityStl(nodes, twoTets, new Float64Array([0.1, 0.1]), 0.5) === null,
);
check(
  "STL file name encodes model and threshold",
  densityStlFileName("crane hook", 0.5) === "crane_hook_topopt_t0.50.stl",
  densityStlFileName("crane hook", 0.5),
);

// ── Smooth-surface STL: the Smooth view's shape, closed and outward ───────────
{
  // Field 1 at node 0, level 0.5: the corner tet cut at the edge midpoints,
  // volume (1/2)³ · 1/6 = 1/48 — for both node-ordering handednesses.
  const field = new Float64Array([1, 0, 0, 0, 0]);
  for (const [name, ids] of [
    ["positive", [0, 1, 2, 3]],
    ["inverted", [0, 2, 1, 3]],
  ]) {
    const tet = { id: 13, type: "CTETRA", nodeIds: ids, propertyId: 1 };
    const stl = buildSmoothDensityStl(nodes, [tet], field, 0.5, "density");
    const vol = stl ? signedVolume(parseStl(stl).tris) : NaN;
    check(
      `smooth STL of a cut ${name} tet is closed and outward (volume 1/48)`,
      Math.abs(vol - 1 / 48) < 1e-7,
      `signed volume ${vol}`,
    );
  }

  // Unit-cube CHEXA with field f = x at level 0.25: the Kuhn split is exact for
  // a linear field, so the exported solid is the slab x ≥ 0.25, volume 0.75.
  const cubeNodes = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ].map(([x, y, z], id) => ({ id, x, y, z }));
  const hex = {
    id: 41,
    type: "CHEXA",
    nodeIds: [0, 1, 2, 3, 4, 5, 6, 7],
    propertyId: 1,
  };
  const slab = buildSmoothDensityStl(
    cubeNodes,
    [hex],
    new Float64Array(cubeNodes.map((n) => n.x)),
    0.25,
    "density",
  );
  const slabVol = slab ? signedVolume(parseStl(slab).tris) : NaN;
  check(
    "smooth STL of a hex cut by a linear field encloses exactly the slab (0.75)",
    Math.abs(slabVol - 0.75) < 1e-6,
    `signed volume ${slabVol}`,
  );
  check(
    "smooth STL with nothing inside → null",
    buildSmoothDensityStl(nodes, [tetA], field, 1.5, "density") === null,
  );
}

console.log(
  failures === 0
    ? "\nAll density-field tests passed."
    : `\n${failures} density-field test(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
