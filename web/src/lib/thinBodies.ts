// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pre-mesh thin-walled-body detection. Runs on the CAD tessellation (before any
// volume mesh exists) so the app can PRESELECT which bodies of an imported
// assembly should be idealised as shells. For each body a ray is cast inward from
// every surface triangle and the nearest same-body surface it hits gives the local
// wall thickness; a body whose surface is predominantly thin walls — thin both in
// absolute terms relative to the body's own size — is a shell candidate. This is
// the geometry-only counterpart of the mesh-based wall detector in shellize.ts
// (detectWallPairs), which is more precise but needs the finished tet mesh.

export interface TessellationInput {
  vertices: ArrayLike<number>; // 3·nVerts, xyz interleaved
  triangles: ArrayLike<number>; // 3·nTris, vertex indices
  triangleBodyIds: ArrayLike<number>; // 1-based body id per triangle
}

type Vec3 = [number, number, number];

// Möller–Trumbore ray/triangle intersection. Returns the forward hit distance
// along the (unit) direction, or Infinity when the ray misses.
function rayTriangle(
  origin: Vec3,
  dir: Vec3,
  v0: Vec3,
  v1: Vec3,
  v2: Vec3,
): number {
  const e1: Vec3 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
  const e2: Vec3 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
  const pvec: Vec3 = [
    dir[1] * e2[2] - dir[2] * e2[1],
    dir[2] * e2[0] - dir[0] * e2[2],
    dir[0] * e2[1] - dir[1] * e2[0],
  ];
  const det = e1[0] * pvec[0] + e1[1] * pvec[1] + e1[2] * pvec[2];
  if (Math.abs(det) < 1e-9) return Infinity; // ray parallel to the triangle
  const inv = 1 / det;
  const tvec: Vec3 = [origin[0] - v0[0], origin[1] - v0[1], origin[2] - v0[2]];
  const bary1 =
    (tvec[0] * pvec[0] + tvec[1] * pvec[1] + tvec[2] * pvec[2]) * inv;
  if (bary1 < -1e-6 || bary1 > 1 + 1e-6) return Infinity;
  const qvec: Vec3 = [
    tvec[1] * e1[2] - tvec[2] * e1[1],
    tvec[2] * e1[0] - tvec[0] * e1[2],
    tvec[0] * e1[1] - tvec[1] * e1[0],
  ];
  const bary2 = (dir[0] * qvec[0] + dir[1] * qvec[1] + dir[2] * qvec[2]) * inv;
  if (bary2 < -1e-6 || bary1 + bary2 > 1 + 1e-6) return Infinity;
  const dist = (e2[0] * qvec[0] + e2[1] * qvec[1] + e2[2] * qvec[2]) * inv;
  return dist > 1e-4 ? dist : Infinity; // ignore the originating surface itself
}

// Body ids that should default to a shell idealisation: a large fraction of the
// body's surface (≥ coverage) sits opposite another wall within a distance that is
// small relative to the body's own diagonal (median thickness < thinRatio·diag).
// The double test separates a truly thin-walled part (a hollow bracket: 0.5 mm
// walls over a 500 mm span → ratio ~0.001) from a merely slender solid (a pin:
// its "opposite wall" is the far side of the shaft, ~diameter away → ratio ~0.1).
export function detectShellBodies(
  { vertices, triangles, triangleBodyIds }: TessellationInput,
  {
    thinRatio = 0.02,
    coverage = 0.5,
  }: { thinRatio?: number; coverage?: number } = {},
): number[] {
  const nTris = triangles.length / 3;
  if (nTris === 0) return [];
  const vtx = (i: number): Vec3 => [
    vertices[3 * i],
    vertices[3 * i + 1],
    vertices[3 * i + 2],
  ];

  const centroid: Vec3[] = new Array(nTris);
  const normal: Vec3[] = new Array(nTris);
  const area = new Float64Array(nTris);
  const tri: [Vec3, Vec3, Vec3][] = new Array(nTris);
  for (let t = 0; t < nTris; t++) {
    const va = vtx(triangles[3 * t]);
    const vb = vtx(triangles[3 * t + 1]);
    const vc = vtx(triangles[3 * t + 2]);
    const nx =
      (vb[1] - va[1]) * (vc[2] - va[2]) - (vb[2] - va[2]) * (vc[1] - va[1]);
    const ny =
      (vb[2] - va[2]) * (vc[0] - va[0]) - (vb[0] - va[0]) * (vc[2] - va[2]);
    const nz =
      (vb[0] - va[0]) * (vc[1] - va[1]) - (vb[1] - va[1]) * (vc[0] - va[0]);
    // eslint-disable-next-line kofem/no-silent-fallback -- div-by-zero guard: a degenerate (zero-area) triangle has no defined normal
    const nl = Math.hypot(nx, ny, nz) || 1;
    centroid[t] = [
      (va[0] + vb[0] + vc[0]) / 3,
      (va[1] + vb[1] + vc[1]) / 3,
      (va[2] + vb[2] + vc[2]) / 3,
    ];
    normal[t] = [nx / nl, ny / nl, nz / nl];
    area[t] = 0.5 * nl;
    tri[t] = [va, vb, vc];
  }

  // Per-body bounding-box diagonal and a spatial grid of the body's triangles so
  // the inward ray only tests nearby candidates.
  const bboxMin = new Map<number, Vec3>();
  const bboxMax = new Map<number, Vec3>();
  for (let t = 0; t < nTris; t++) {
    const body = triangleBodyIds[t];
    let mn = bboxMin.get(body);
    let mx = bboxMax.get(body);
    if (!mn || !mx) {
      mn = [Infinity, Infinity, Infinity];
      mx = [-Infinity, -Infinity, -Infinity];
      bboxMin.set(body, mn);
      bboxMax.set(body, mx);
    }
    for (const v of tri[t])
      for (let d = 0; d < 3; d++) {
        if (v[d] < mn[d]) mn[d] = v[d];
        if (v[d] > mx[d]) mx[d] = v[d];
      }
  }
  const diagonal = new Map<number, number>();
  for (const [body, mn] of bboxMin) {
    const mx = bboxMax.get(body)!;
    diagonal.set(body, Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]));
  }

  // Grid cell ~ the largest body diagonal fraction we care about; a fixed cell
  // keyed by body id keeps different bodies' triangles from colliding.
  const cell = Math.max(1e-3, Math.max(...[...diagonal.values()], 1) * 0.05);
  const grid = new Map<string, number[]>();
  const key = (body: number, x: number, y: number, z: number) =>
    `${body}:${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let t = 0; t < nTris; t++) {
    const k = key(triangleBodyIds[t], ...centroid[t]);
    let bucket = grid.get(k);
    if (!bucket) {
      bucket = [];
      grid.set(k, bucket);
    }
    bucket.push(t);
  }

  // Per body, area-weighted thickness samples (only where the inward ray hits).
  const totalArea = new Map<number, number>();
  const samples = new Map<number, [number, number][]>(); // body → [thickness, area]
  for (let t = 0; t < nTris; t++) {
    const body = triangleBodyIds[t];
    // eslint-disable-next-line kofem/no-silent-fallback -- accumulating area; 0 is the identity for a body seen for the first time
    totalArea.set(body, (totalArea.get(body) ?? 0) + area[t]);
    const searchCap = Math.min(
      // eslint-disable-next-line kofem/no-silent-fallback -- a body always has a diagonal (it has triangles); 1 is an inert lower bound if a degenerate body slips through
      (diagonal.get(body) ?? 1) * 0.3,
      1e6,
    );
    const origin: Vec3 = [
      centroid[t][0] - normal[t][0] * 1e-3,
      centroid[t][1] - normal[t][1] * 1e-3,
      centroid[t][2] - normal[t][2] * 1e-3,
    ];
    const dir: Vec3 = [-normal[t][0], -normal[t][1], -normal[t][2]];
    let best = Infinity;
    const steps = Math.max(1, Math.ceil(searchCap / cell));
    for (let step = 0; step <= steps; step++) {
      const px = centroid[t][0] + dir[0] * step * cell;
      const py = centroid[t][1] + dir[1] * step * cell;
      const pz = centroid[t][2] + dir[2] * step * cell;
      const cx = Math.floor(px / cell),
        cy = Math.floor(py / cell),
        cz = Math.floor(pz / cell);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = grid.get(`${body}:${cx + dx},${cy + dy},${cz + dz}`);
            if (!bucket) continue;
            for (const s of bucket) {
              if (s === t) continue;
              const hit = rayTriangle(
                origin,
                dir,
                tri[s][0],
                tri[s][1],
                tri[s][2],
              );
              if (hit < best) best = hit;
            }
          }
      if (best <= step * cell) break; // nearest hit already inside the swept range
    }
    if (best <= searchCap) {
      let list = samples.get(body);
      if (!list) {
        list = [];
        samples.set(body, list);
      }
      list.push([best, area[t]]);
    }
  }

  const shellBodies: number[] = [];
  for (const [body, total] of totalArea) {
    const list = samples.get(body);
    if (!list) continue;
    const covered = list.reduce((sum, [, sampleArea]) => sum + sampleArea, 0);
    if (covered < coverage * total) continue; // mostly open / bulky → solid
    // Area-weighted median wall thickness.
    list.sort((p, q) => p[0] - q[0]);
    let acc = 0;
    let median = list[list.length - 1][0];
    for (const [thickness, sampleArea] of list) {
      acc += sampleArea;
      if (acc >= covered / 2) {
        median = thickness;
        break;
      }
    }
    const diag = diagonal.get(body);
    if (diag !== undefined && median < thinRatio * diag) shellBodies.push(body);
  }
  return shellBodies.sort((a, b) => a - b);
}
