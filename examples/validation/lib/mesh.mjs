// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Structured mesh generators and node selectors for the solver tests, the
// topology-optimization benchmarks and the Theory Guide's axial-bar study.
// The examples on /examples/ are not built from these: each is a STEP file
// meshed by Netgen (lib/pipeline.mjs).
//
// A hex generator returns { vertices: [[x,y,z]...], hexahedra: [[..8]...] }
// plus any helpers a caller needs to pick boundary nodes. Hex vertex ordering matches
// MFEM's AddHex: bottom face CCW, then the matching top face.

/** Axis-aligned box [0,L]×[0,W]×[0,H], nx·ny·nz linear hexes. */
export function boxHexMesh(L, W, H, nx, ny, nz) {
  const nid = (i, j, k) => i * (ny + 1) * (nz + 1) + j * (nz + 1) + k;
  const vertices = [];
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= ny; j++)
      for (let k = 0; k <= nz; k++)
        vertices.push([(i * L) / nx, (j * W) / ny, (k * H) / nz]);
  const hexahedra = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++)
        hexahedra.push([
          nid(i, j, k),
          nid(i + 1, j, k),
          nid(i + 1, j + 1, k),
          nid(i, j + 1, k),
          nid(i, j, k + 1),
          nid(i + 1, j, k + 1),
          nid(i + 1, j + 1, k + 1),
          nid(i, j + 1, k + 1),
        ]);
  return { vertices, hexahedra, nid };
}

/**
 * Mid-surface of a square plate of half-width b with a central circular hole
 * of radius a, as a single-layer flat TRIANGLE surface mesh (z = 0) for the
 * Kirchhoff shell solver. O-grid: rings blend from the hole (s=0) to the
 * square outer boundary (s=1), `grade` clusters rings near the hole. Each
 * ring quad is split into two triangles, so the hole-ring elements — where the
 * peak in-plane (membrane) stress sits — are the first 2·nth triangles. Loaded
 * in its own plane this is the plane-stress Kirsch problem, membrane-only.
 */
export function plateWithHoleShellMesh(a, b, nr, nth, grade = 2) {
  const idx = new Map();
  const key = (i, j) => `${i},${((j % nth) + nth) % nth}`;
  const square = (th) => {
    const c = Math.cos(th),
      s = Math.sin(th);
    const m = Math.max(Math.abs(c), Math.abs(s));
    return [(b * c) / m, (b * s) / m];
  };
  const vertices = [];
  let id = 0;
  for (let i = 0; i <= nr; i++) {
    const s = Math.pow(i / nr, grade);
    for (let j = 0; j < nth; j++) {
      const th = (2 * Math.PI * j) / nth;
      const [cx, cy] = [a * Math.cos(th), a * Math.sin(th)];
      const [sx, sy] = square(th);
      idx.set(key(i, j), id++);
      vertices.push([(1 - s) * cx + s * sx, (1 - s) * cy + s * sy, 0]);
    }
  }
  const n = (i, j) => idx.get(key(i, j));
  const triangles = [];
  for (let i = 0; i < nr; i++)
    for (let j = 0; j < nth; j++) {
      triangles.push([n(i, j), n(i + 1, j), n(i + 1, j + 1)]);
      triangles.push([n(i, j), n(i + 1, j + 1), n(i, j + 1)]);
    }
  return { vertices, triangles, nth, nr };
}

const HEX_EDGES = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];
const HEX_FACES = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [0, 3, 7, 4],
  [1, 2, 6, 5],
];

/**
 * Size of a hex mesh solved at H1 order p: elements, mesh vertices, FE nodes and
 * displacement DOFs (3 per node). A tensor-product Q_p hexahedron carries one
 * node per vertex, p−1 per edge, (p−1)² per face and (p−1)³ inside, so P2 is
 * the 27-node hexahedron. Counts are before supports are eliminated.
 */
export function meshStats(mesh, order) {
  if ((mesh.tetrahedra ?? []).length > 0)
    throw new Error(
      `meshStats counts hexahedral meshes only, got ${mesh.tetrahedra.length} tetrahedra`,
    );
  const edges = new Set();
  const faces = new Set();
  for (const hex of mesh.hexahedra) {
    for (const [a, b] of HEX_EDGES)
      edges.add(
        hex[a] < hex[b] ? `${hex[a]},${hex[b]}` : `${hex[b]},${hex[a]}`,
      );
    for (const f of HEX_FACES)
      faces.add(
        f
          .map((i) => hex[i])
          .sort((x, y) => x - y)
          .join(","),
      );
  }
  const p = order - 1;
  const nodes =
    mesh.vertices.length +
    p * edges.size +
    p * p * faces.size +
    p * p * p * mesh.hexahedra.length;
  return {
    order,
    elements: mesh.hexahedra.length,
    vertices: mesh.vertices.length,
    nodes,
    dofs: 3 * nodes,
  };
}

/** Indices of vertices satisfying pred(x,y,z,index). */
export function nodesWhere(vertices, pred) {
  const out = [];
  vertices.forEach((v, i) => {
    if (pred(v[0], v[1], v[2], i)) out.push(i);
  });
  return out;
}

/** Distribute a total force vector evenly over the given nodes. */
export function distributeForce(nodeIds, force) {
  const per = [
    force[0] / nodeIds.length,
    force[1] / nodeIds.length,
    force[2] / nodeIds.length,
  ];
  return nodeIds.map((vertex) => ({ vertex, force: per }));
}
