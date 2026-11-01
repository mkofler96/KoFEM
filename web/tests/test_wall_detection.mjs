// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Thin-wall detection (src/lib/shellize/walls.ts, through extractThinWallShells).
//
// A body the user marks Shell is collapsed to the mid-surface of the walls this
// detector finds: pairs of opposite planar CAD faces of one body, no further
// apart than `maxWall`. Its thresholds decide which material the shell keeps, so
// they are pinned here on synthetic boxes whose answer is known exactly:
//   - a 2 mm plate is one wall, 2 mm thick, its mid-surface at t/2;
//   - a 20 mm block is no wall at the default maxWall = 15, and one at 25;
//   - a 0.04 mm sliver is below the 0.05 mm floor and is no wall;
//   - shellBodyIds picks the body; without it the largest wall's body wins.
//
// Run:  bun tests/test_wall_detection.mjs

import { extractThinWallShells } from "../src/lib/shellize.ts";

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

const plate = (body, faceBase, z0, thickness, size = [60, 40]) => ({
  min: [0, 0, z0],
  max: [size[0], size[1], z0 + thickness],
  cells: [6, 4, 1],
  body,
  faceBase,
});

const shellZ = (shells) =>
  shells.shellVerts.filter((_, index) => index % 3 === 2);

console.log("thin-wall detection:");

// ── a 2 mm plate is one wall ──────────────────────────────────────────────────
{
  const shells = extractThinWallShells(boxes([plate(1, 0, 0, 2)]), {
    shellBodyIds: new Set([1]),
  });
  check("2 mm plate: shell body found", shells.shellBody === 1);
  check(
    "2 mm plate: exactly one wall — the two big faces, not the 2 mm edges",
    shells.walls.length === 1,
    JSON.stringify(shells.walls),
  );
  const [wall] = shells.walls;
  check(
    "2 mm plate: wall thickness is the face separation along the normal",
    wall !== undefined && near(wall.thk, 2),
    wall && `thk=${wall.thk}`,
  );
  check(
    "2 mm plate: kept face is one of the ±z faces",
    wall !== undefined && (wall.keep === 4 || wall.keep === 5),
    wall && `keep=${wall.keep}`,
  );
  check(
    "2 mm plate: mid-surface lies at t/2, z = 1",
    shells.shellVerts.length > 0 && shellZ(shells).every((z) => near(z, 1)),
    `z ∈ [${Math.min(...shellZ(shells))}, ${Math.max(...shellZ(shells))}]`,
  );
  check(
    "2 mm plate: every facet carries the wall thickness",
    shells.shellThk.length > 0 && shells.shellThk.every((t) => near(t, 2)),
  );
}

// ── the maxWall threshold separates a thick block from a wall ─────────────────
{
  const block = boxes([plate(1, 0, 0, 20)]);
  const byDefault = extractThinWallShells(block, {
    shellBodyIds: new Set([1]),
  });
  check(
    "20 mm block: no wall at the default maxWall (15)",
    byDefault.shellBody === -1 && byDefault.shellTris.length === 0,
    `shellBody=${byDefault.shellBody}`,
  );
  const widened = extractThinWallShells(block, {
    maxWall: 25,
    shellBodyIds: new Set([1]),
  });
  check(
    "20 mm block: one 20 mm wall once maxWall (25) exceeds its thickness",
    widened.shellBody === 1 &&
      widened.walls.length === 1 &&
      near(widened.walls[0].thk, 20),
    JSON.stringify(widened.walls),
  );
}

// ── a sliver thinner than the 0.05 mm floor is not a wall ─────────────────────
{
  const sliver = extractThinWallShells(boxes([plate(1, 0, 0, 0.04)]), {
    shellBodyIds: new Set([1]),
  });
  check(
    "0.04 mm sliver: below the 0.05 mm floor, no wall",
    sliver.shellBody === -1,
    `shellBody=${sliver.shellBody}`,
  );
}

// ── body selection ────────────────────────────────────────────────────────────
{
  // Body 1: a 60×40×2 plate. Body 2: a 20×20×3 plate well clear of it.
  const twoBodies = boxes([
    plate(1, 0, 0, 2),
    {
      min: [0, 0, 50],
      max: [20, 20, 53],
      cells: [4, 4, 1],
      body: 2,
      faceBase: 10,
    },
  ]);
  const largest = extractThinWallShells(twoBodies);
  check(
    "no shellBodyIds: the body with the largest wall is shelled",
    largest.shellBody === 1 && largest.walls.every((w) => w.body === 1),
    `shellBody=${largest.shellBody}`,
  );
  const picked = extractThinWallShells(twoBodies, {
    shellBodyIds: new Set([2]),
  });
  check(
    "shellBodyIds {2}: only body 2 is shelled, with its own 3 mm wall",
    picked.shellBody === 2 &&
      picked.walls.length === 1 &&
      near(picked.walls[0].thk, 3) &&
      shellZ(picked).every((z) => near(z, 51.5)),
    JSON.stringify(picked.walls),
  );
  const none = extractThinWallShells(twoBodies, { shellBodyIds: new Set() });
  check(
    "empty shellBodyIds: the user chose all-solid, nothing is shelled",
    none.shellBody === -1 && none.shellTris.length === 0,
  );
}

console.log(
  failures === 0
    ? "\nall thin-wall detection checks passed"
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
