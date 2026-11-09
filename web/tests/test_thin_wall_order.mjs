// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Linear-tet thin-wall check (KOF-274): thinWallFindings flags a wall that
// fewer than 4 linear elements span, and stays quiet for a fine mesh, order 2,
// and Shell or suppressed bodies. Uses the synthetic box mesher of
// test_wall_detection.mjs.
//
// Run:  bun tests/test_thin_wall_order.mjs

import { thinWallFindings } from "../src/lib/solve/thinWall.ts";
import { loadFemModule } from "../src/lib/femModule.ts";

// The shell idealisation runs in the Rust module (crates/kofem-shellize).
await loadFemModule();

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const near = (left, right, tol = 1e-9) => Math.abs(left - right) < tol;

const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];

// Tet mesh of axis-aligned boxes, each its own body, with a surface mesh whose
// triangles carry one CAD face id per box side: faceBase + 2·axis + (max side).
// Boxes must not touch, so every box is closed on its own.
function boxes(specs) {
  const mesh = { V: [], tet: [], body: [], surfTri: [], surfFace: [] };
  for (const { min, max, cells, body, faceBase } of specs) {
    const first = mesh.V.length / 3;
    const nodeIndex = (i, j, k) =>
      first + i + (cells[0] + 1) * (j + (cells[1] + 1) * k);
    for (let k = 0; k <= cells[2]; k++)
      for (let j = 0; j <= cells[1]; j++)
        for (let i = 0; i <= cells[0]; i++)
          mesh.V.push(
            min[0] + ((max[0] - min[0]) * i) / cells[0],
            min[1] + ((max[1] - min[1]) * j) / cells[1],
            min[2] + ((max[2] - min[2]) * k) / cells[2],
          );
    const firstTet = mesh.tet.length / 4;
    for (let k = 0; k < cells[2]; k++)
      for (let j = 0; j < cells[1]; j++)
        for (let i = 0; i < cells[0]; i++) {
          const cell = [
            nodeIndex(i, j, k),
            nodeIndex(i + 1, j, k),
            nodeIndex(i, j + 1, k),
            nodeIndex(i + 1, j + 1, k),
            nodeIndex(i, j, k + 1),
            nodeIndex(i + 1, j, k + 1),
            nodeIndex(i, j + 1, k + 1),
            nodeIndex(i + 1, j + 1, k + 1),
          ];
          for (const tet of KUHN) {
            mesh.tet.push(...tet.map((corner) => cell[corner]));
            mesh.body.push(body);
          }
        }
    // Boundary = tet faces used once; orient each outward along its box side.
    const faces = new Map();
    for (let e = firstTet; e < mesh.tet.length / 4; e++)
      for (const face of [
        [0, 1, 2],
        [0, 1, 3],
        [0, 2, 3],
        [1, 2, 3],
      ]) {
        const nodes = face.map((corner) => mesh.tet[4 * e + corner]);
        const key = nodes.toSorted((left, right) => left - right).join(",");
        const entry = faces.get(key);
        if (entry) entry.count++;
        else faces.set(key, { count: 1, nodes });
      }
    const point = (index) => mesh.V.slice(3 * index, 3 * index + 3);
    for (const { count, nodes } of faces.values()) {
      if (count !== 1) continue;
      const pos = nodes.map(point);
      const axis = [0, 1, 2].find((ax) =>
        pos.every((pnt) => near(pnt[ax], pos[0][ax])),
      );
      const side = near(pos[0][axis], max[axis]) ? 1 : 0;
      const edgeU = pos[1].map((value, ax) => value - pos[0][ax]);
      const edgeV = pos[2].map((value, ax) => value - pos[0][ax]);
      const normal = [
        edgeU[1] * edgeV[2] - edgeU[2] * edgeV[1],
        edgeU[2] * edgeV[0] - edgeU[0] * edgeV[2],
        edgeU[0] * edgeV[1] - edgeU[1] * edgeV[0],
      ];
      const tri = [...nodes];
      if (normal[axis] * (side ? 1 : -1) < 0)
        [tri[1], tri[2]] = [tri[2], tri[1]];
      mesh.surfTri.push(...tri);
      mesh.surfFace.push(faceBase + 2 * axis + side);
    }
  }
  return mesh;
}

// Store-model view of the flat mesh: 1-based node ids, one CTETRA per tet.
function model(mesh, elementOrder) {
  const nodes = [];
  for (let i = 0; i < mesh.V.length; i += 3)
    nodes.push({
      id: i / 3 + 1,
      x: mesh.V[i],
      y: mesh.V[i + 1],
      z: mesh.V[i + 2],
    });
  const elements = [];
  for (let e = 0; e < mesh.body.length; e++)
    elements.push({
      id: e + 1,
      type: "CTETRA",
      propertyId: mesh.body[e],
      nodeIds: mesh.tet.slice(4 * e, 4 * e + 4).map((v) => v + 1),
    });
  const tri = (i) => mesh.surfTri.slice(3 * i, 3 * i + 3).map((v) => v + 1);
  return {
    nodes,
    elements,
    properties: [...new Set(mesh.body)].map((id) => ({ id, materialId: 1 })),
    surfaceTriangles: mesh.surfFace.map((_, i) => tri(i)),
    surfaceFaceIds: mesh.surfFace,
    elementOrder,
  };
}

const slab = (size, cells) => ({
  min: [0, 0, 0],
  max: [size[0], size[1], 2],
  cells,
  body: 1,
  faceBase: 0,
});

console.log("linear thin-wall check:");

{
  // 2 mm wall, in-plane edges ~10 mm: one element would span a fifth of it.
  const found = thinWallFindings(model(boxes([slab([60, 40], [6, 4, 1])]), 1));
  check(
    "coarse mesh: the wall is flagged",
    found.length === 1,
    JSON.stringify(found),
  );
  check(
    "coarse mesh: thickness is 2 mm and under 4 elements through",
    found.length === 1 &&
      near(found[0].thickness, 2, 1e-6) &&
      found[0].elementsThrough < 4,
  );
}
{
  // ~0.3 mm edges across a 2 mm wall: about 7 elements through.
  const found = thinWallFindings(model(boxes([slab([3, 3], [10, 10, 7])]), 1));
  check("fine mesh: no finding", found.length === 0, JSON.stringify(found));
}
{
  const found = thinWallFindings(model(boxes([slab([60, 40], [6, 4, 1])]), 2));
  check("quadratic elements: no finding", found.length === 0);
}
{
  const input = model(boxes([slab([60, 40], [6, 4, 1])]), 1);
  input.properties[0].discretization = "shell";
  check("body marked Shell: not checked", thinWallFindings(input).length === 0);
}
{
  const input = model(boxes([slab([60, 40], [6, 4, 1])]), 1);
  input.properties[0].suppressed = true;
  check("suppressed body: not checked", thinWallFindings(input).length === 0);
}

{
  // A huge neighbour must not hide the thin plate: the detector drops faces
  // under 1 % of the largest face in its input.
  const slabSpec = { ...slab([60, 40], [6, 4, 1]), body: 1, faceBase: 0 };
  const hugeSpec = {
    min: [0, 100, 0],
    max: [2000, 600, 500],
    cells: [2, 2, 2],
    body: 2,
    faceBase: 10,
  };
  const found = thinWallFindings(model(boxes([slabSpec, hugeSpec]), 1));
  check(
    "thin plate beside a huge body: still flagged",
    found.some((f) => f.bodyId === 1),
    JSON.stringify(found),
  );
}

console.log(
  failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
