// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mid-surface placement where two walls MEET (KOF-191).
//
// A node on a single wall is the wall face pushed t/2 along −n. A node on the CAD
// edge shared by two walls lies on both, so it must land where the two mid-planes
// cross — offsetting it along one wall's normal alone leaves it t/2 off the other
// wall's mid-plane.
//
// That is not cosmetic. `shellWallTets` claims a tet as wall material when its
// centroid is within t/2 of a mid-surface facet, so mid-surface facets dragged out
// of their own wall stop claiming the tets underneath them. Those tets survive the
// collapse as slivers of wall-thickness solid, disconnected from the structure,
// drawn over the shell and picked up as coupling partners — the gap, the distorted
// elements and the jump in displacement reported in KOF-191. On the crane hook at
// 6 mm elements the leftovers formed 17 floating fragments carrying 900+ couplings.
//
// Fixture: an L of two 2 mm walls sharing the edge x = 0, z = 0 —
//   wall A (horizontal): 0 ≤ x ≤ 40, 0 ≤ z ≤ 2   → mid-plane z = 1
//   wall B (vertical):   0 ≤ x ≤ 2,  0 ≤ z ≤ 30  → mid-plane x = 1
// so the shared edge belongs on the line x = 1, z = 1.
//
// Run:  bun tests/test_midsurface_junction.mjs

import { extractThinWallShells, shellWallTets } from "../src/lib/shellize.ts";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  [PASS] ${name}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const THK = 2;
const KUHN = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
];

// ── L-shaped single body, tetrahedralised on a shared grid so it is conformal ──
const verts = [];
const vIndex = new Map();
const addV = (x, y, z) => {
  const key = `${x},${y},${z}`;
  let i = vIndex.get(key);
  if (i === undefined) {
    i = verts.length / 3;
    vIndex.set(key, i);
    verts.push(x, y, z);
  }
  return i;
};
const tet = [];
const body = [];
const addBox = (x0, nx, dx, z0, nz, dz) => {
  const gid = (i, j, k) => addV(x0 + i * dx, j * 5, z0 + k * dz);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < 4; j++)
      for (let k = 0; k < nz; k++) {
        const cell = [
          gid(i, j, k),
          gid(i + 1, j, k),
          gid(i, j + 1, k),
          gid(i + 1, j + 1, k),
          gid(i, j, k + 1),
          gid(i + 1, j, k + 1),
          gid(i, j + 1, k + 1),
          gid(i + 1, j + 1, k + 1),
        ];
        for (const t of KUHN) {
          tet.push(cell[t[0]], cell[t[1]], cell[t[2]], cell[t[3]]);
          body.push(1);
        }
      }
};
addBox(0, 20, 2, 0, 1, THK); // wall A, z ∈ [0, 2]
addBox(0, 1, THK, THK, 14, 2); // wall B, x ∈ [0, 2], z ∈ [2, 30]

// ── Surface triangulation, labelled by CAD face ───────────────────────────────
// Face ids: 1 = A outer (z = 0), 2 = A inner (z = 2), 3 = B outer (x = 0),
// 4 = B inner (x = 2), 5.. = ends and sides (never paired: 20 mm apart, or a
// tenth of the wall faces' area).
const TET_FACES = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 2, 3],
  [1, 2, 3],
];
const seen = new Map();
for (let e = 0; e < tet.length / 4; e++)
  for (const f of TET_FACES) {
    const tri = [tet[4 * e + f[0]], tet[4 * e + f[1]], tet[4 * e + f[2]]];
    const key = [...tri].sort((a, b) => a - b).join(",");
    const hit = seen.get(key);
    if (hit) {
      hit.count++;
      continue;
    }
    // Wind outward (away from the tet's fourth node) — faceProps averages the
    // triangle normals, so a face wound at random reads as non-planar.
    const opposite = tet[4 * e + [0, 1, 2, 3].find((k) => !f.includes(k))];
    const corner = tri.map((i) => [
      verts[3 * i],
      verts[3 * i + 1],
      verts[3 * i + 2],
    ]);
    const edgeAB = [
      corner[1][0] - corner[0][0],
      corner[1][1] - corner[0][1],
      corner[1][2] - corner[0][2],
    ];
    const edgeAC = [
      corner[2][0] - corner[0][0],
      corner[2][1] - corner[0][1],
      corner[2][2] - corner[0][2],
    ];
    const normal = [
      edgeAB[1] * edgeAC[2] - edgeAB[2] * edgeAC[1],
      edgeAB[2] * edgeAC[0] - edgeAB[0] * edgeAC[2],
      edgeAB[0] * edgeAC[1] - edgeAB[1] * edgeAC[0],
    ];
    const inward = [
      verts[3 * opposite] - corner[0][0],
      verts[3 * opposite + 1] - corner[0][1],
      verts[3 * opposite + 2] - corner[0][2],
    ];
    if (
      normal[0] * inward[0] + normal[1] * inward[1] + normal[2] * inward[2] >
      0
    )
      [tri[1], tri[2]] = [tri[2], tri[1]];
    seen.set(key, { tri, count: 1 });
  }
const near = (a, b) => Math.abs(a - b) < 1e-9;
const surfTri = [];
const surfFace = [];
for (const { tri, count } of seen.values()) {
  if (count !== 1) continue;
  const corner = tri.map((i) => [
    verts[3 * i],
    verts[3 * i + 1],
    verts[3 * i + 2],
  ]);
  const all = (axis, want) => corner.every((pos) => near(pos[axis], want));
  let face;
  if (all(2, 0)) face = 1;
  else if (all(2, THK)) face = 2;
  else if (all(0, 0)) face = 3;
  else if (all(0, THK)) face = 4;
  else if (all(1, 0)) face = 5;
  else if (all(1, 20)) face = 6;
  else if (all(0, 40)) face = 7;
  else if (all(2, 30)) face = 8;
  else
    throw new Error(
      `boundary triangle on no known plane: ${JSON.stringify(corner)}`,
    );
  surfTri.push(tri[0], tri[1], tri[2]);
  surfFace.push(face);
}
const mesh = { V: verts, tet, body, surfTri, surfFace };

console.log("mid-surface placement at a wall junction:");

const shells = extractThinWallShells(mesh);
check(
  "both walls of the L are detected on one body",
  shells.walls.length === 2 && shells.shellBody === 1,
  `walls=${shells.walls.length} body=${shells.shellBody}`,
);

// Each facet must lie IN the mid-plane of the wall it belongs to — including the
// facets that reach the junction.
const midPlane = new Map([
  [1, { axis: 2, at: THK / 2 }], // wall A kept face z = 0 → mid-plane z = 1
  [3, { axis: 0, at: THK / 2 }], // wall B kept face x = 0 → mid-plane x = 1
]);
let offPlane = 0,
  worst = 0,
  worstAt = null;
for (let t = 0; t < shells.shellTris.length / 3; t++) {
  const plane = midPlane.get(shells.shellTriSrc[t]);
  if (!plane) continue;
  for (let k = 0; k < 3; k++) {
    const i = shells.shellTris[3 * t + k];
    const dev = Math.abs(shells.shellVerts[3 * i + plane.axis] - plane.at);
    if (dev > 1e-9) {
      offPlane++;
      if (dev > worst) {
        worst = dev;
        worstAt = [
          shells.shellVerts[3 * i],
          shells.shellVerts[3 * i + 1],
          shells.shellVerts[3 * i + 2],
        ];
      }
    }
  }
}
check(
  "every mid-surface facet lies in its own wall's mid-plane",
  offPlane === 0,
  `${offPlane} corners off by up to ${worst} mm at ${JSON.stringify(worstAt)}`,
);

// The shared edge belongs on the line where the two mid-planes cross.
const junction = [];
for (let i = 0; i < shells.shellVerts.length / 3; i++) {
  const posX = shells.shellVerts[3 * i],
    posZ = shells.shellVerts[3 * i + 2];
  if (posX < THK && posZ < THK)
    junction.push([posX, shells.shellVerts[3 * i + 1], posZ]);
}
check(
  "the welded junction nodes sit on the mid-plane intersection (x = 1, z = 1)",
  junction.length > 0 &&
    junction.every(
      ([posX, , posZ]) => near(posX, THK / 2) && near(posZ, THK / 2),
    ),
  `${junction.length} junction nodes: ${JSON.stringify(junction.slice(0, 4))}`,
);

// Consequence the two checks above protect: facets inside their own walls claim
// the tets underneath them. This L is coarse enough that the skewed facets still
// reached its corner tets; on the crane's long junctions they did not, and 1 205
// tets survived as 17 floating fragments.
const wallTets = shellWallTets(mesh, shells);
check(
  "the collapse claims every tet of the L — no wall material is left behind",
  wallTets.size === tet.length / 4,
  `claimed ${wallTets.size} of ${tet.length / 4} tets`,
);

console.log(
  failures === 0
    ? "\nall mid-surface junction checks passed"
    : `\n${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
