// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mesh primitives shared by the shellize modules: the flat mesh they read, and
// the small measurements every stage takes of it.

export type Vec3 = [number, number, number];

// Flat mesh over a 0-based vertex numbering (the worker builds this from the
// store model via its vertex indexer).
export interface ShellizeMesh {
  V: number[]; // 3·nNodes, xyz interleaved
  tet: number[]; // 4·nTets, vertex indices
  body: number[]; // body id per tet
  surfTri: number[]; // 3·nSurfTri, vertex indices
  surfFace: number[]; // OCC face id per surface triangle
}

export const TET_FACES = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 2, 3],
  [1, 2, 3],
];

export function pt(V: number[], i: number): Vec3 {
  return [V[3 * i], V[3 * i + 1], V[3 * i + 2]];
}

export function dist2(a: Vec3, b: Vec3): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

// Map get-or-insert without non-null assertions: returns the existing value or
// stores and returns a freshly made one.
export function getOrInit<K, T>(map: Map<K, T>, key: K, make: () => T): T {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    map.set(key, value);
  }
  return value;
}

// Longest edge of triangle t.
export function triangleExtent(
  corner: (t: number, k: number) => Vec3,
  t: number,
): number {
  const cornerA = corner(t, 0),
    cornerB = corner(t, 1),
    cornerC = corner(t, 2);
  return Math.max(
    Math.hypot(
      cornerB[0] - cornerA[0],
      cornerB[1] - cornerA[1],
      cornerB[2] - cornerA[2],
    ),
    Math.hypot(
      cornerC[0] - cornerB[0],
      cornerC[1] - cornerB[1],
      cornerC[2] - cornerB[2],
    ),
    Math.hypot(
      cornerA[0] - cornerC[0],
      cornerA[1] - cornerC[1],
      cornerA[2] - cornerC[2],
    ),
  );
}

export function tetVolume(m: ShellizeMesh, e: number): number {
  const corner = [0, 1, 2, 3].map((k) => pt(m.V, m.tet[4 * e + k]));
  const edge = [1, 2, 3].map((k) => [
    corner[k][0] - corner[0][0],
    corner[k][1] - corner[0][1],
    corner[k][2] - corner[0][2],
  ]);
  // |e₁ · (e₂ × e₃)| / 6, the edges from corner 0
  return (
    Math.abs(
      edge[0][0] * (edge[1][1] * edge[2][2] - edge[1][2] * edge[2][1]) +
        edge[0][1] * (edge[1][2] * edge[2][0] - edge[1][0] * edge[2][2]) +
        edge[0][2] * (edge[1][0] * edge[2][1] - edge[1][1] * edge[2][0]),
    ) / 6
  );
}

// Boundary of a tet mesh: the faces used by exactly one element, as a flat
// 3·nTris index array over the same node numbering as `tets`.
export function tetMeshBoundary(tets: number[]): number[] {
  const seen = new Map<string, { tri: Vec3; count: number }>();
  for (let e = 0; e < tets.length / 4; e++)
    for (const face of TET_FACES) {
      const tri: Vec3 = [
        tets[4 * e + face[0]],
        tets[4 * e + face[1]],
        tets[4 * e + face[2]],
      ];
      const key = [...tri].sort((a, b) => a - b).join(",");
      const entry = seen.get(key);
      if (entry) entry.count++;
      else seen.set(key, { tri, count: 1 });
    }
  const out: number[] = [];
  for (const { tri, count } of seen.values())
    if (count === 1) out.push(tri[0], tri[1], tri[2]);
  return out;
}

// Median tet edge — the solid mesh's own length scale, from which the coupling
// distances are derived so none is a fixed number of millimetres.
export function medianTetEdge(
  ppt: (i: number) => Vec3,
  tets: number[],
): number {
  const edges: number[] = [];
  for (let e = 0; e < tets.length / 4; e++) {
    const nodes = [0, 1, 2, 3].map((k) => ppt(tets[4 * e + k]));
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++)
        edges.push(
          Math.hypot(
            nodes[i][0] - nodes[j][0],
            nodes[i][1] - nodes[j][1],
            nodes[i][2] - nodes[j][2],
          ),
        );
  }
  if (edges.length === 0) return 0;
  edges.sort((a, b) => a - b);
  return edges[Math.floor(edges.length / 2)];
}
