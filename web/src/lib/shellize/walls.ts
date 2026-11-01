// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Thin-wall detection: aggregate the surface mesh per CAD face, then pair up
// opposite planar faces of the same body that are close enough to be a wall.

import { TET_FACES, pt, type ShellizeMesh, type Vec3 } from "./geometry.js";

export interface FaceProp {
  id: number;
  area: number;
  body: number;
  flat: number;
  n: Vec3;
  c: Vec3;
}

export interface Wall {
  keep: number;
  n: Vec3;
  thk: number;
  body: number;
}

// Per-CAD-face area, area-weighted normal and centroid, and owning body; sorted
// by area, largest first. `flat` is |Σ n·A| / Σ A — 1 for a planar face.
export function faceProps(m: ShellizeMesh): FaceProp[] {
  const faceBody = new Map<string, number>();
  for (let e = 0; e < m.tet.length / 4; e++) {
    const tetNodes = [
      m.tet[4 * e],
      m.tet[4 * e + 1],
      m.tet[4 * e + 2],
      m.tet[4 * e + 3],
    ];
    for (const face of TET_FACES) {
      const key = [tetNodes[face[0]], tetNodes[face[1]], tetNodes[face[2]]]
        .sort((a, b) => a - b)
        .join(",");
      faceBody.set(key, m.body[e]);
    }
  }
  const acc = new Map<
    number,
    {
      area: number;
      nx: number;
      ny: number;
      nz: number;
      cx: number;
      cy: number;
      cz: number;
      body: number;
    }
  >();
  for (let t = 0; t < m.surfFace.length; t++) {
    const idxA = m.surfTri[3 * t],
      idxB = m.surfTri[3 * t + 1],
      idxC = m.surfTri[3 * t + 2];
    const posA = pt(m.V, idxA),
      posB = pt(m.V, idxB),
      posC = pt(m.V, idxC);
    const edgeU = [posB[0] - posA[0], posB[1] - posA[1], posB[2] - posA[2]];
    const edgeV = [posC[0] - posA[0], posC[1] - posA[1], posC[2] - posA[2]];
    const nx = edgeU[1] * edgeV[2] - edgeU[2] * edgeV[1],
      ny = edgeU[2] * edgeV[0] - edgeU[0] * edgeV[2],
      nz = edgeU[0] * edgeV[1] - edgeU[1] * edgeV[0];
    const area = 0.5 * Math.hypot(nx, ny, nz);
    let entry = acc.get(m.surfFace[t]);
    if (!entry) {
      const faceKey = [idxA, idxB, idxC].sort((x, y) => x - y).join(",");
      // eslint-disable-next-line kofem/no-silent-fallback -- a surface triangle with no owning tet face gets body -1 and is excluded from wall detection; it never reaches the solver
      const bodyOf = faceBody.get(faceKey) ?? -1;
      entry = {
        area: 0,
        nx: 0,
        ny: 0,
        nz: 0,
        cx: 0,
        cy: 0,
        cz: 0,
        body: bodyOf,
      };
      acc.set(m.surfFace[t], entry);
    }
    entry.area += area;
    entry.nx += nx / 2;
    entry.ny += ny / 2;
    entry.nz += nz / 2;
    entry.cx += ((posA[0] + posB[0] + posC[0]) / 3) * area;
    entry.cy += ((posA[1] + posB[1] + posC[1]) / 3) * area;
    entry.cz += ((posA[2] + posB[2] + posC[2]) / 3) * area;
  }
  return [...acc.entries()]
    .map(([id, f]) => {
      // eslint-disable-next-line kofem/no-silent-fallback -- div-by-zero guard: a degenerate (zero-area) face has no defined normal
      const nl = Math.hypot(f.nx, f.ny, f.nz) || 1;
      return {
        id,
        area: f.area,
        body: f.body,
        flat: nl / f.area,
        n: [f.nx / nl, f.ny / nl, f.nz / nl] as Vec3,
        c: [f.cx / f.area, f.cy / f.area, f.cz / f.area] as Vec3,
      };
    })
    .sort((a, b) => b.area - a.area);
}

// Pair up opposite planar faces of the same body into thin walls, keeping the
// OUTER face of each pair (its normal points away from the other face):
// adjacent walls' outer faces meet at convex CAD edges and share Netgen's edge
// nodes, which the junction weld relies on.
export function detectWallPairs(faces: FaceProp[], maxWall: number): Wall[] {
  const big = faces.filter(
    (f) => f.area > 0.01 * faces[0].area && f.flat > 0.9,
  );
  const used = new Set<number>();
  const walls: Wall[] = [];
  for (let i = 0; i < big.length; i++) {
    if (used.has(big[i].id)) continue;
    let best = -1,
      bo = Infinity;
    for (let j = 0; j < big.length; j++) {
      if (i === j || used.has(big[j].id) || big[i].body !== big[j].body)
        continue;
      const dot =
        big[i].n[0] * big[j].n[0] +
        big[i].n[1] * big[j].n[1] +
        big[i].n[2] * big[j].n[2];
      if (dot > -0.85) continue;
      const dc: Vec3 = [
        big[j].c[0] - big[i].c[0],
        big[j].c[1] - big[i].c[1],
        big[j].c[2] - big[i].c[2],
      ];
      // Wall thickness is the centroid offset ALONG the face normal. The raw
      // euclidean centroid distance also picks up any lateral shift between the
      // two faces, and since bending stiffness scales with t³ that inflation
      // made the shell several-fold too stiff. A large lateral shift relative
      // to the face extent means the faces don't actually overlap — not a wall.
      const along = Math.abs(
        big[i].n[0] * dc[0] + big[i].n[1] * dc[1] + big[i].n[2] * dc[2],
      );
      const lateral = Math.sqrt(
        Math.max(0, dc[0] ** 2 + dc[1] ** 2 + dc[2] ** 2 - along ** 2),
      );
      const extent = Math.sqrt(Math.min(big[i].area, big[j].area));
      const ar =
        Math.abs(big[i].area - big[j].area) /
        Math.max(big[i].area, big[j].area);
      if (
        ar > 0.4 ||
        along < 0.05 ||
        along > maxWall ||
        lateral > 0.35 * extent
      )
        continue;
      if (along < bo) {
        bo = along;
        best = j;
      }
    }
    if (best >= 0) {
      used.add(big[i].id);
      used.add(big[best].id);
      const fa = big[i],
        fb = big[best];
      const dcx = fa.c[0] - fb.c[0],
        dcy = fa.c[1] - fb.c[1],
        dcz = fa.c[2] - fb.c[2];
      const outer = fa.n[0] * dcx + fa.n[1] * dcy + fa.n[2] * dcz > 0 ? fa : fb;
      walls.push({ keep: outer.id, n: outer.n, thk: bo, body: fa.body });
    }
  }
  return walls;
}
