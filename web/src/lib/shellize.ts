// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Automatic solid → shell idealisation used by the solver worker: detect the
// thin-walled bodies of a meshed assembly, collapse their walls to a Kirchhoff
// shell mid-surface (per-wall thickness), keep the bulk bodies as solid tets, and
// build the inputs for the engine's coupled solve (solve_coupled). This is the
// in-app port of the pipeline demonstrated in examples/shell-coupling/lib.mjs;
// the heavy solving lives in engine/cpp/solve_coupled.cpp.

// Flat mesh over a 0-based vertex numbering (the worker builds this from the
// store model via its vertex indexer).

export interface ShellizeMesh {
  V: number[]; // 3·nNodes, xyz interleaved
  tet: number[]; // 4·nTets, vertex indices
  body: number[]; // body id per tet
  surfTri: number[]; // 3·nSurfTri, vertex indices
  surfFace: number[]; // OCC face id per surface triangle
}

interface FaceProp {
  id: number;
  area: number;
  body: number;
  flat: number;
  n: [number, number, number];
  c: [number, number, number];
}

interface Wall {
  keep: number;
  n: [number, number, number];
  thk: number;
  body: number;
}

export interface ShellExtraction {
  walls: Wall[];
  shellBody: number;
  shellVerts: number[]; // 3·nShellNodes
  shellTris: number[]; // 3·nShellTris (local shell indices)
  shellThk: number[]; // per shell tri
  shellSrc: number[]; // source OCC face per shell node (one, for a welded fold node arbitrary)
  shellTriSrc: number[]; // source OCC face per shell TRI — unambiguous, so a BC on a
  // folded face reaches every node of its facets (fold nodes shared with a wall included)
}

const TET_FACES = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 2, 3],
  [1, 2, 3],
];

function pt(V: number[], i: number): [number, number, number] {
  return [V[3 * i], V[3 * i + 1], V[3 * i + 2]];
}

// Map get-or-insert without non-null assertions: returns the existing value or
// stores and returns a freshly made one.
function getOrInit<K, T>(map: Map<K, T>, key: K, make: () => T): T {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    map.set(key, value);
  }
  return value;
}

// Squared distance from a point to a triangle (Ericson, Real-Time Collision
// Detection §5.1.5 — closest point on a triangle via the Voronoi regions of its
// vertices, edges and interior).
function pointTriDist2(
  p: [number, number, number],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
): number {
  const ab: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap: [number, number, number] = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dot = (
    u: [number, number, number],
    v: [number, number, number],
  ): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  const closest: [number, number, number] = [0, 0, 0];
  const at = (s: number, t: number): number => {
    closest[0] = a[0] + s * ab[0] + t * ac[0];
    closest[1] = a[1] + s * ab[1] + t * ac[1];
    closest[2] = a[2] + s * ab[2] + t * ac[2];
    return (
      (p[0] - closest[0]) ** 2 +
      (p[1] - closest[1]) ** 2 +
      (p[2] - closest[2]) ** 2
    );
  };
  if (d1 <= 0 && d2 <= 0) return at(0, 0);
  const bp: [number, number, number] = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const cp: [number, number, number] = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return at(
      1 - (d4 - d3) / (d4 - d3 + (d5 - d6)),
      (d4 - d3) / (d4 - d3 + (d5 - d6)),
    );
  const denom = 1 / (va + vb + vc);
  return at(vb * denom, vc * denom);
}

// Uniform grid over a triangle soup, for "is any triangle within r of p" queries.
// Each triangle is registered in every cell its bounding box overlaps, so a
// triangle within `cell` of a query point is always found among the 27 cells
// around it — callers must therefore build with `cell` ≥ their largest query
// radius. `corner(t, k)` returns vertex k of triangle t.
interface TriangleGrid {
  cell: number;
  buckets: Map<string, number[]>;
  corner: (t: number, k: number) => [number, number, number];
}

function buildTriangleGrid(
  nTris: number,
  corner: (t: number, k: number) => [number, number, number],
  cell: number,
): TriangleGrid {
  const buckets = new Map<string, number[]>();
  for (let t = 0; t < nTris; t++) {
    const corners = [corner(t, 0), corner(t, 1), corner(t, 2)];
    const lo = [0, 1, 2].map((axis) =>
      Math.floor(
        Math.min(corners[0][axis], corners[1][axis], corners[2][axis]) / cell,
      ),
    );
    const hi = [0, 1, 2].map((axis) =>
      Math.floor(
        Math.max(corners[0][axis], corners[1][axis], corners[2][axis]) / cell,
      ),
    );
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++)
          getOrInit(buckets, `${x},${y},${z}`, () => []).push(t);
  }
  return { cell, buckets, corner };
}

// True when some triangle near `p` satisfies `withinReach(squaredDistance, t)`.
function anyTriangleNear(
  grid: TriangleGrid,
  p: [number, number, number],
  withinReach: (dist2: number, tri: number) => boolean,
): boolean {
  const cx = Math.floor(p[0] / grid.cell),
    cy = Math.floor(p[1] / grid.cell),
    cz = Math.floor(p[2] / grid.cell);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = grid.buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!bucket) continue;
        for (const t of bucket)
          if (
            withinReach(
              pointTriDist2(
                p,
                grid.corner(t, 0),
                grid.corner(t, 1),
                grid.corner(t, 2),
              ),
              t,
            )
          )
            return true;
      }
  return false;
}

// The tets of the shelled body that the shell facets REPLACE: those lying inside
// a detected thin wall. A tet is inside a wall exactly when its centroid is
// within half that wall's thickness of the wall's mid-surface — the geometric
// statement of "this material is now carried by the shell". Everything farther
// away — the thick junction/base blocks that connect the body to its neighbours —
// stays a solid tet, so its stiffness and its contact with the neighbours are
// preserved. Collapsing the WHOLE body to shells silently dropped those blocks
// (the crane holder lost ~30 % of its volume, exactly the block carrying load
// into the hook), leaving the shells floating with only a proximity coupling to
// the solids.
//
// This used to be a SHAPE test (tet flatness below a fixed ratio), on the
// assumption that a thin wall is always filled by flat slivers. Netgen refines
// across a thin wall until its elements are well formed, so most wall tets pass
// that test: the wall was represented twice — shell facets laid over retained
// solid tets — by a fraction that moved with element size. On the 2 mm fin of
// fin_two_parts.step, 68 % of the wall tets survived at 20 mm elements and
// 99.8 % at 6 mm, while the shell covered the wall in full.
export function shellWallTets(
  m: ShellizeMesh,
  shells: ShellExtraction,
  { margin = 1.0 }: { margin?: number } = {},
): Set<number> {
  const wallTets = new Set<number>();
  const nFacets = shells.shellTris.length / 3;
  if (nFacets === 0) return wallTets;

  const facetPt = midSurfaceCorner(shells);
  // Cell ≥ the largest query radius (half the thickest wall) and ≥ the facet
  // extent, so a facet spans only a few cells.
  let maxThk = 0,
    sumExtent = 0;
  for (let t = 0; t < nFacets; t++) {
    if (shells.shellThk[t] > maxThk) maxThk = shells.shellThk[t];
    sumExtent += triangleExtent(facetPt, t);
  }
  const grid = buildTriangleGrid(
    nFacets,
    facetPt,
    Math.max(maxThk * margin, sumExtent / nFacets, 1e-9),
  );

  for (let e = 0; e < m.tet.length / 4; e++) {
    if (m.body[e] !== shells.shellBody) continue;
    const centroid: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const node = pt(m.V, m.tet[4 * e + k]);
      centroid[0] += node[0] / 4;
      centroid[1] += node[1] / 4;
      centroid[2] += node[2] / 4;
    }
    const inside = anyTriangleNear(grid, centroid, (dist2, t) => {
      const reach = 0.5 * shells.shellThk[t] * margin;
      return dist2 <= reach * reach;
    });
    if (inside) wallTets.add(e);
  }
  return wallTets;
}

// Corner accessor for the shell mid-surface facets.
function midSurfaceCorner(
  shells: ShellExtraction,
): (t: number, k: number) => [number, number, number] {
  const sv = shells.shellVerts;
  return (t, k) => {
    const i = shells.shellTris[3 * t + k];
    return [sv[3 * i], sv[3 * i + 1], sv[3 * i + 2]];
  };
}

// Longest edge of triangle t.
function triangleExtent(
  corner: (t: number, k: number) => [number, number, number],
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

function faceProps(m: ShellizeMesh): FaceProp[] {
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
        n: [f.nx / nl, f.ny / nl, f.nz / nl] as [number, number, number],
        c: [f.cx / f.area, f.cy / f.area, f.cz / f.area] as [
          number,
          number,
          number,
        ],
      };
    })
    .sort((a, b) => b.area - a.area);
}

// Pair up opposite planar faces of the same body into thin walls, keeping the
// OUTER face of each pair (its normal points away from the other face):
// adjacent walls' outer faces meet at convex CAD edges and share Netgen's edge
// nodes, which the junction weld relies on.
function detectWallPairs(faces: FaceProp[], maxWall: number): Wall[] {
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
      const dc: [number, number, number] = [
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

// Where a node lies on ONE wall the mid-surface is that wall's face offset t/2
// along −n. A node on the CAD edge where two walls meet lies on both, and must
// land on the LINE where the two mid-planes cross (three walls ⇒ the corner
// point). Solving n_w·Δ = −t_w/2 for every wall w the node belongs to gives that
// point; the walls are applied in face order, each along the direction the
// earlier ones leave free, so every accepted constraint holds exactly.
//
// Offsetting along a single wall's normal instead leaves the node up to t/2 off
// the other wall's mid-plane. That is not just a cosmetic kink in the facets: it
// drags the mid-surface out of the wall it represents, so `shellWallTets` no
// longer finds those wall tets within t/2 of it and they survive the collapse as
// floating slivers of wall-thickness solid — debris that is drawn over the shell
// AND picked up as coupling partners, tying seam shell nodes to material with no
// load path. On the crane hook at 6 mm elements that left 17 fragments carrying
// 900+ of the model's 265 couplings' partner slots (KOF-191).
function midSurfaceOffset(
  wallsOfNode: Set<number>,
  keep: Map<number, Wall>,
): [number, number, number] {
  const delta: [number, number, number] = [0, 0, 0];
  const basis: [number, number, number][] = [];
  for (const fid of [...wallsOfNode].sort((a, b) => a - b)) {
    const wall = keep.get(fid);
    if (!wall)
      throw new Error(`mid-surface offset asked for unknown wall face ${fid}`);
    const residual: [number, number, number] = [
      wall.n[0],
      wall.n[1],
      wall.n[2],
    ];
    for (const used of basis) {
      const proj =
        residual[0] * used[0] + residual[1] * used[1] + residual[2] * used[2];
      residual[0] -= proj * used[0];
      residual[1] -= proj * used[1];
      residual[2] -= proj * used[2];
    }
    const len = Math.hypot(residual[0], residual[1], residual[2]);
    // Nothing left to move along ⇒ this wall's mid-plane is (near) parallel to
    // one already enforced, so it is already satisfied to within t/2·sin(angle).
    if (len < 0.2) continue;
    const dir: [number, number, number] = [
      residual[0] / len,
      residual[1] / len,
      residual[2] / len,
    ];
    const along =
      wall.n[0] * delta[0] + wall.n[1] * delta[1] + wall.n[2] * delta[2];
    const step =
      (-wall.thk / 2 - along) /
      (wall.n[0] * dir[0] + wall.n[1] * dir[1] + wall.n[2] * dir[2]);
    delta[0] += step * dir[0];
    delta[1] += step * dir[1];
    delta[2] += step * dir[2];
    basis.push(dir);
  }
  return delta;
}

// Collapse the kept wall faces to mid-surface facets (offset to the mid-plane of
// every wall the node lies on) and weld mid-surface nodes that came from the SAME
// original mesh node. Where two walls meet at a CAD edge they share Netgen's edge
// nodes, so joining nodes by original id fuses the walls exactly — independent of
// mesh resolution (a spatial tolerance over-welds a fine mesh and under-welds a
// coarse one).
function collapseWallsToMidSurface(
  m: ShellizeMesh,
  walls: Wall[],
): Pick<
  ShellExtraction,
  "shellVerts" | "shellTris" | "shellThk" | "shellSrc" | "shellTriSrc"
> {
  const keep = new Map(walls.map((w) => [w.keep, w]));

  // Every kept wall each node lies on — a junction node belongs to more than one.
  const wallsOfNode = new Map<number, Set<number>>();
  for (let t = 0; t < m.surfFace.length; t++) {
    if (!keep.has(m.surfFace[t])) continue;
    for (let k = 0; k < 3; k++)
      getOrInit(wallsOfNode, m.surfTri[3 * t + k], () => new Set<number>()).add(
        m.surfFace[t],
      );
  }

  const rawV: number[] = [],
    rawT: number[] = [],
    rawThk: number[] = [],
    rawTriSrc: number[] = [],
    rawSrc: number[] = [],
    rawOrig: number[] = [];
  const nm = new Map<string, number>();
  const addN = (fid: number, oi: number, p: [number, number, number]) => {
    const key = `${fid}:${oi}`;
    let id = nm.get(key);
    if (id !== undefined) return id;
    id = rawV.length / 3;
    nm.set(key, id);
    rawV.push(p[0], p[1], p[2]);
    rawSrc.push(fid);
    rawOrig.push(oi);
    return id;
  };
  const offsetOfNode = new Map<number, [number, number, number]>();
  for (const [oi, nodeWalls] of wallsOfNode)
    offsetOfNode.set(oi, midSurfaceOffset(nodeWalls, keep));
  for (let t = 0; t < m.surfFace.length; t++) {
    const wall = keep.get(m.surfFace[t]);
    if (!wall) continue;
    const nn = [
      m.surfTri[3 * t],
      m.surfTri[3 * t + 1],
      m.surfTri[3 * t + 2],
    ].map((oi) => {
      const pos = pt(m.V, oi);
      const delta = offsetOfNode.get(oi);
      if (!delta)
        throw new Error(
          `mid-surface offset missing for mesh node ${oi} on wall face ${wall.keep}`,
        );
      return addN(wall.keep, oi, [
        pos[0] + delta[0],
        pos[1] + delta[1],
        pos[2] + delta[2],
      ]);
    });
    rawT.push(nn[0], nn[1], nn[2]);
    rawThk.push(wall.thk);
    rawTriSrc.push(wall.keep);
  }

  const nR = rawV.length / 3;
  const rep = new Int32Array(nR).map((_, i) => i);
  const find = (x: number): number => {
    while (rep[x] !== x) {
      rep[x] = rep[rep[x]];
      x = rep[x];
    }
    return x;
  };
  const byOrig = new Map<number, number[]>();
  for (let i = 0; i < nR; i++) getOrInit(byOrig, rawOrig[i], () => []).push(i);
  for (const [, group] of byOrig)
    for (let k = 1; k < group.length; k++) {
      const rootA = find(group[0]),
        rootB = find(group[k]);
      if (rootA !== rootB) rep[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
    }
  const comp = new Map<number, number>();
  const shellVerts: number[] = [],
    shellSrc: number[] = [];
  const cid = (i: number) => {
    const root = find(i);
    let compact = comp.get(root);
    if (compact === undefined) {
      compact = shellVerts.length / 3;
      comp.set(root, compact);
      shellVerts.push(rawV[3 * root], rawV[3 * root + 1], rawV[3 * root + 2]);
      shellSrc.push(rawSrc[root]);
    }
    return compact;
  };
  const shellTris: number[] = [],
    shellThk: number[] = [],
    shellTriSrc: number[] = [];
  for (let t = 0; t < rawT.length / 3; t++) {
    const triA = cid(rawT[3 * t]),
      triB = cid(rawT[3 * t + 1]),
      triC = cid(rawT[3 * t + 2]);
    if (triA === triB || triB === triC || triA === triC) continue;
    shellTris.push(triA, triB, triC);
    shellThk.push(rawThk[t]);
    shellTriSrc.push(rawTriSrc[t]);
  }
  return { shellVerts, shellTris, shellThk, shellSrc, shellTriSrc };
}

// Detect thin walls (opposite planar CAD-face pairs) and collapse each to a
// mid-surface facet with its wall thickness; weld walls at their junctions.
// Returns an empty extraction (shellBody = -1) when no thin walls are found, so
// the caller can fall back to the all-solid solve.
// `shellBodyIds` names the bodies to idealise as shells (the app passes the
// per-body Shell/Solid choice; the showcase generator omits it to let the largest
// thin-walled body be picked automatically). Only ONE body is shelled per solve —
// the coupled solver takes a single shell material (#376) — so among the requested
// bodies the one with the largest thin wall is used.
export function extractThinWallShells(
  m: ShellizeMesh,
  {
    maxWall = 15,
    shellBodyIds,
  }: { maxWall?: number; shellBodyIds?: Set<number> } = {},
): ShellExtraction {
  const empty: ShellExtraction = {
    walls: [],
    shellBody: -1,
    shellVerts: [],
    shellTris: [],
    shellThk: [],
    shellSrc: [],
    shellTriSrc: [],
  };
  if (shellBodyIds && shellBodyIds.size === 0) return empty; // user chose all-solid
  const faces = faceProps(m);
  if (faces.length === 0) return empty;
  const allWalls = detectWallPairs(faces, maxWall).filter(
    (w) => !shellBodyIds || shellBodyIds.has(w.body),
  );
  if (allWalls.length === 0) return empty;
  // Shell exactly ONE body — the one carrying the largest thin wall. detectWallPairs
  // matches opposite faces on any body, so a thick flat block elsewhere can also
  // pair up; collapsing such a wall would lay shell facets on top of a body that
  // stays solid (double representation), corrupting the coupling. The crane hook
  // picked up a stray 5 mm "wall" on the solid hook this way — 569 shell triangles
  // glued onto solid tets. Keep only walls on the shelled body.
  const shellBody = allWalls[0].body;
  const walls = allWalls.filter((w) => w.body === shellBody);
  return {
    walls,
    shellBody,
    ...collapseWallsToMidSurface(m, walls),
  };
}

// CSR-style coupling set. `mpc[k]` selects the coupling kind for reference k:
// 1 ⇒ relaxed shell-to-solid MPC (rigid translation tie + relaxed rotation, for a
// continuous-material seam), 2 ⇒ kinematic RBE2 (the coupled nodes follow the
// reference point rigidly), 0/absent ⇒ distributing RBE3 (for a gapped
// interface). `dofMask[k]` selects which of a kinematic coupling's six DOFs are
// tied (bits 0..5); absent ⇒ all six, which is what every coupling this module
// derives itself wants.
export interface CouplingSet {
  ref: number[];
  offsets: number[];
  solid: number[];
  mpc?: number[]; // per ref; length matches ref when present
  dofMask?: number[]; // per ref; length matches ref when present
}

// All six DOFs of a coupling — the engine's kAllDofs.
const ALL_DOF_MASK = 0x3f;

// Per-reference coupling kinds / DOF masks of a set, defaulted for the sets
// built here (which are all distributing or relaxed-MPC, and tie all six DOFs).
export function couplingMpcCodes(set: CouplingSet): number[] {
  if (set.mpc) return set.mpc;
  return set.ref.map(() => 0);
}

export function couplingDofMasks(set: CouplingSet): number[] {
  if (set.dofMask) return set.dofMask;
  return set.ref.map(() => ALL_DOF_MASK);
}

export interface CoupledModel {
  pool: number[]; // 3·nPool (solid nodes, then shell nodes, then reference points)
  tets: number[]; // 4·nSolidTets over pool
  tetBody: number[]; // body id per solid tet (for per-body PSOLID labelling)
  triangles: number[]; // 3·nShellTris over pool
  thicknesses: number[];
  coupling: CouplingSet;
  solidPool: Map<number, number>; // original vertex index → pool index (solid)
  shellPool: number[]; // local shell index → pool index
  refPool: Map<number, number>; // reference-point vertex index → pool index
  tieReports: TieCouplingReport[]; // what each tie connection contributed
}

// Boundary of a tet mesh: the faces used by exactly one element, as a flat
// 3·nTris index array over the same node numbering as `tets`.
function tetMeshBoundary(tets: number[]): number[] {
  const seen = new Map<
    string,
    { tri: [number, number, number]; count: number }
  >();
  for (let e = 0; e < tets.length / 4; e++)
    for (const face of TET_FACES) {
      const tri: [number, number, number] = [
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

// The shell mid-surface nodes that lie ON the retained solid — the seam where an
// idealised wall meets material that stayed solid. These, and only these, are the
// references of the shell↔solid tie.
//
// The reference set used to be "every shell node with ≥ 3 solid nodes within
// couplingRadius" — a ball of fixed 10 mm, an absolute length with no relation to
// the part being analysed. Every shell node it caught became rigidly tied to the
// solid, so on the 2 mm fin of fin_two_parts.step the top 9.8 mm of the wall was
// clamped to the block: the cantilever was shortened and its tip deflection came
// out 26 % stiff. Whether a node is at the seam is a geometric fact, not a
// distance-to-nodes question, so test it directly against the retained solid's
// BOUNDARY SURFACE. The tolerance is one wall thickness: the mid-surface sits t/2
// inside the original wall face, so a seam node can be up to t/2 off the solid
// boundary, and t leaves margin for a curved or coarsely faceted seam.
function seamShellNodes(
  ppt: (i: number) => [number, number, number],
  shellPoolIndices: number[],
  solidBoundary: number[],
  tolerance: number,
): number[] {
  const nTris = solidBoundary.length / 3;
  if (nTris === 0 || tolerance <= 0) return [];
  const corner = (t: number, k: number): [number, number, number] =>
    ppt(solidBoundary[3 * t + k]);
  let sumExtent = 0;
  for (let t = 0; t < nTris; t++) sumExtent += triangleExtent(corner, t);
  const grid = buildTriangleGrid(
    nTris,
    corner,
    Math.max(tolerance, sumExtent / nTris, 1e-9),
  );
  const tol2 = tolerance * tolerance;
  return shellPoolIndices.filter((pi) =>
    anyTriangleNear(grid, ppt(pi), (dist2) => dist2 <= tol2),
  );
}

// Median tet edge — the solid mesh's own length scale, from which both coupling
// distances below are derived so neither is a fixed number of millimetres.
function medianTetEdge(
  ppt: (i: number) => [number, number, number],
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

// How far off the retained solid's boundary a shell node may sit and still count
// as seam. The seam is a wall-thickness-scale feature, but a DISCRETISED seam is
// only located to within the local element size: with 0.5 mm walls on a 6 mm mesh
// the crane holder's junction ring lands well off the solid's faceted boundary,
// and a wall-thickness tolerance found so few seam nodes that the shell hinged
// there (max |u| 0.16 mm at 4 mm elements but 8.1 mm at 8 mm — no convergence at
// all). So the tolerance carries both scales: one wall thickness, or half an
// element, whichever is larger. Unlike a fixed radius it shrinks as the mesh is
// refined, so the tied band is mesh-convergent rather than a constant bite out of
// the structure.
function seamTolerance(maxWallThickness: number, medEdge: number): number {
  return Math.max(maxWallThickness, 0.5 * medEdge);
}

// Distance a coupling reference may reach to find its solid partners. It has to
// span at least one solid element, otherwise a seam node on a coarse mesh finds
// fewer than the three partners an RBE3/MPC needs and is silently dropped; beyond
// that it only widens the patch the tie distributes over.
function partnerSearchRadius(medEdge: number, floor: number): number {
  return Math.max(2 * medEdge, floor, 1e-9);
}

// Pick at most `budget` of the candidates found in the search ball, keeping the
// PATCH WIDE: the nearest node first (the MPC tie needs it), then repeatedly the
// candidate farthest from everything already chosen. Taking the `budget` nearest
// instead makes the patch shrink with the element size — at 6 mm elements the 16
// nearest spanned 6.6 mm, at 2 mm only 3.9 mm — while the reference stays put, so
// the RBE3 inertia H = Σ wᵢ(|rᵢ|²I − rᵢrᵢᵀ) tends to its singular limit (all rᵢ
// parallel) as the mesh is refined. Measured on the crane hook, cond(H) doubled
// per halving of the element size, and Hinv scales the constraint's rotation rows
// (build_rbe3_constraints), so that lands in Kᵣ = TᵀKT squared. A patch that
// keeps the search ball's width instead is as well-conditioned at 1 mm as at 6.
function spreadPatch(
  candidates: { pi: number; d2: number }[],
  budget: number,
  ppt: (i: number) => [number, number, number],
): number[] {
  if (candidates.length <= budget) return candidates.map((c) => c.pi);
  const chosen = [candidates.reduce((a, b) => (a.d2 <= b.d2 ? a : b)).pi];
  const rest = candidates.filter((c) => c.pi !== chosen[0]).map((c) => c.pi);
  // Distance from each remaining candidate to the nearest chosen node, updated
  // incrementally as the patch grows (farthest-point sampling).
  const sep = rest.map((pi) => dist2(ppt(pi), ppt(chosen[0])));
  while (chosen.length < budget) {
    let best = -1;
    for (let i = 0; i < rest.length; i++)
      if (sep[i] > (best < 0 ? -1 : sep[best])) best = i;
    if (best < 0) break;
    const picked = rest[best];
    chosen.push(picked);
    sep[best] = -1; // never picked again
    for (let i = 0; i < rest.length; i++)
      if (sep[i] >= 0)
        sep[i] = Math.min(sep[i], dist2(ppt(rest[i]), ppt(picked)));
  }
  return chosen;
}

function dist2(
  a: [number, number, number],
  b: [number, number, number],
): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

// Auto-detect distributing (RBE3) couplings: every reference (shell) node that
// has ≥3 solid nodes within couplingRadius ties to them. Emitted CSR-style —
// ref[k] ties to solid[offsets[k]..offsets[k+1]). At most `maxCoupledNodes` solid
// candidates are kept per coupling — the RBE3 master-slave expansion is quadratic
// in that count, so a radius alone picks hundreds of nodes on a fine mesh and the
// reduction dominates the solve — chosen for spread, see spreadPatch.
function autoDetectCouplings(
  ppt: (i: number) => [number, number, number],
  solidPoolIndices: Iterable<number>,
  refPoolIndices: Iterable<number>,
  radius: number,
  maxCoupledNodes: number,
): { ref: number[]; offsets: number[]; solid: number[] } {
  const grid = new Map<string, number[]>();
  const gk = (x: number, y: number, z: number) =>
    `${Math.floor(x / radius)},${Math.floor(y / radius)},${Math.floor(z / radius)}`;
  for (const pi of solidPoolIndices) {
    const pos = ppt(pi);
    getOrInit(grid, gk(...pos), () => []).push(pi);
  }
  const ref: number[] = [],
    offsets = [0],
    solid: number[] = [];
  for (const gi of refPoolIndices) {
    const pos = ppt(gi);
    const cx = Math.floor(pos[0] / radius),
      cy = Math.floor(pos[1] / radius),
      cz = Math.floor(pos[2] / radius);
    const near: { pi: number; d2: number }[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const pi of bucket) {
            const posSolid = ppt(pi);
            const d2 =
              (pos[0] - posSolid[0]) ** 2 +
              (pos[1] - posSolid[1]) ** 2 +
              (pos[2] - posSolid[2]) ** 2;
            if (d2 <= radius * radius) near.push({ pi, d2 });
          }
        }
    if (near.length >= 3) {
      ref.push(gi);
      for (const pi of spreadPatch(near, maxCoupledNodes, ppt)) solid.push(pi);
      offsets.push(solid.length);
    }
  }
  return { ref, offsets, solid };
}

// Concatenate two CSR coupling sets (shell↔solid, solid↔solid, and the
// reference-point couplings the user declared) into one, preserving each set's
// per-reference kind and DOF mask.
export function concatCouplings(a: CouplingSet, b: CouplingSet): CouplingSet {
  const ref = [...a.ref, ...b.ref];
  const solid = [...a.solid, ...b.solid];
  const offsets = [...a.offsets];
  const base = a.solid.length;
  for (let k = 1; k < b.offsets.length; k++) offsets.push(base + b.offsets[k]);
  return {
    ref,
    offsets,
    solid,
    mpc: [...couplingMpcCodes(a), ...couplingMpcCodes(b)],
    dofMask: [...couplingDofMasks(a), ...couplingDofMasks(b)],
  };
}

// One tie connection, as the coupled builders need it: the two surfaces the user
// picked, given as STORE VERTEX INDICES (the builder maps them to pool nodes),
// and how far the tie reaches. `maxSeparation` is the connection's search
// distance, or Infinity when it couples the full surface.
export interface TieSurfaces {
  name: string;
  verticesA: number[];
  verticesB: number[];
  maxSeparation: number;
}

// Why a tie connection ended up coupling nothing. The all-solid weld path already
// refuses a connection that joins nothing (solver.worker: "connected no nodes"),
// because an assembly that stays split solves to a plausible-looking but
// structurally wrong shape — the couplings are the load path. The coupled path
// used to drop the same connection silently (KOF-203); it now says which of the
// four ways it failed, since each has a different fix.
export type TieCouplingDrop =
  // One or both picked surfaces contributed no node to the solved pool.
  | { kind: "no-pool-nodes"; side: "A" | "B" | "both" }
  // The two surfaces never saw each other, even after widening the search.
  | { kind: "out-of-reach"; searched: number }
  // They do meet, but no closer than the connection's own search distance.
  | { kind: "beyond-search-distance"; gap: number; reach: number }
  // In range, but no reference found the three partners an RBE3 needs.
  | { kind: "too-few-partners"; refs: number; radius: number };

// What one tie connection actually contributed to the coupled model.
export interface TieCouplingReport {
  name: string;
  nCoupled: number; // reference nodes that got a distributing coupling
  nPartners: number; // partner slots those references distribute onto
  nShared: number; // nodes the two surfaces already have in common
  gap: number; // measured closest approach, 0 when never measured
  drop?: TieCouplingDrop;
}

// The sentence for a connection that coupled nothing, or undefined when it did
// couple. Nodes the two surfaces SHARE are already rigidly joined through the
// common pool DOFs, so a connection that only shares is connected, not dropped.
export function tieCouplingProblem(
  report: TieCouplingReport,
): string | undefined {
  if (report.nCoupled > 0 || report.nShared > 0 || !report.drop)
    return undefined;
  const head = `Tie "${report.name}" coupled no nodes`;
  const drop = report.drop;
  switch (drop.kind) {
    case "no-pool-nodes":
      return (
        `${head} — ${drop.side === "both" ? "neither picked surface has" : `picked surface ${drop.side} has`} ` +
        "a node in the solved model. Re-pick its surfaces after remeshing, or " +
        "mark the body Solid if the tie lands on a wall that was idealised as shell."
      );
    case "out-of-reach":
      return (
        `${head} — its two surfaces are more than ${drop.searched.toFixed(4)} mm apart. ` +
        "They are not the surfaces that touch; re-pick them."
      );
    case "beyond-search-distance":
      return (
        `${head} — its surfaces come no closer than ${drop.gap.toFixed(4)} mm, ` +
        `beyond its ${drop.reach.toFixed(4)} mm search distance. Increase the ` +
        "distance, or couple the full surface."
      );
    case "too-few-partners":
      return (
        `${head} — none of its ${drop.refs} in-range reference node(s) found the ` +
        `three partners a distributing coupling needs within ${drop.radius.toFixed(4)} mm. ` +
        "Refine the mesh on the other surface, or pick more of it."
      );
    // TieCouplingDrop is a closed union, so this is unreachable. The `never`
    // binding turns adding a drop kind without a message into a compile error,
    // rather than a connection that coupled nothing and reports no reason.
    default: {
      const unhandled: never = drop;
      throw new Error(
        `Cannot say why tie "${report.name}" coupled nothing: unhandled drop ${JSON.stringify(unhandled)}`,
      );
    }
  }
}

// Distance from each ref node to its nearest master node, for the refs that have
// one within `reach`. Grid cells are `reach` wide, so the 27-cell scan sees every
// candidate in range.
function nearestMasterDistances(
  ppt: (i: number) => [number, number, number],
  masters: number[],
  refs: number[],
  reach: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (masters.length === 0 || refs.length === 0 || !(reach > 0)) return out;
  const gridKey = (x: number, y: number, z: number) =>
    `${Math.floor(x / reach)},${Math.floor(y / reach)},${Math.floor(z / reach)}`;
  const grid = new Map<string, number[]>();
  for (const pi of masters)
    getOrInit(grid, gridKey(...ppt(pi)), () => []).push(pi);

  const reach2 = reach * reach;
  for (const gi of refs) {
    const pos = ppt(gi);
    const cx = Math.floor(pos[0] / reach),
      cy = Math.floor(pos[1] / reach),
      cz = Math.floor(pos[2] / reach);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const pi of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            const candidate = dist2(pos, ppt(pi));
            if (candidate < best) best = candidate;
          }
    if (best <= reach2) out.set(gi, Math.sqrt(best));
  }
  return out;
}

// Distributing (RBE3) tie of the two surfaces of one connection — two solid
// bodies that touch across a clearance (a pin in a hook eye). The nodes of
// surface B become the references; each distributes onto the surface-A nodes
// around it, transmitting force AND moment across the clearance without merging
// the meshes.
//
// This used to be detected automatically: the bodies were split by label, the
// one with the most nodes declared "master", and every other body's interface
// band slaved to it. That guessed at the modelling intent — which parts are
// joined, and over how much of their surface — from geometry alone, and had no
// way to be inspected or corrected. Which surfaces are tied is now stated
// explicitly (a tie connection in the Constraints panel), and this reads it.
//
// Two distances, both derived rather than assumed:
//   gap    — the measured closest approach of the two picked surfaces, found by
//            doubling the search until they see each other, because the
//            clearance of a fit is a property of the CAD.
//   radius — how far a reference reaches for its partners (partnerSearchRadius):
//            at least one element, so a coarse mesh still finds the three
//            partners an RBE3 needs.
// A "within distance" connection additionally keeps only the references within
// its search distance of the other surface, which is what limits the tie to the
// part of the surface that actually touches.
//
// Every connection gets a report, whether or not it coupled: a connection the
// user declared and that produced nothing is a missing load path, and the caller
// refuses it rather than solving a split assembly (KOF-203).
function tieCouplings(
  ppt: (i: number) => [number, number, number],
  ties: PoolTie[],
  medEdge: number,
  maxCoupledNodes: number,
): { coupling: CouplingSet; reports: TieCouplingReport[] } {
  let all: CouplingSet = { ref: [], offsets: [0], solid: [] };
  const reports: TieCouplingReport[] = [];
  for (const tie of ties) {
    // Nodes the two surfaces share are already rigidly joined through the common
    // pool DOFs, and a coupling reference must not also be a partner.
    const refSet = new Set(tie.refs);
    const shared = new Set(tie.masters.filter((pi) => refSet.has(pi)));
    const masters = tie.masters.filter((pi) => !shared.has(pi));
    const refs = tie.refs.filter((pi) => !shared.has(pi));
    const base: TieCouplingReport = {
      name: tie.name,
      nCoupled: 0,
      nPartners: 0,
      nShared: shared.size,
      gap: 0,
    };
    const dropped = (drop: TieCouplingDrop, gap = 0): void => {
      reports.push({ ...base, gap, drop });
    };
    if (masters.length === 0 || refs.length === 0) {
      dropped({
        kind: "no-pool-nodes",
        side: masters.length === 0 ? (refs.length === 0 ? "both" : "A") : "B",
      });
      continue;
    }

    let distances = new Map<number, number>();
    let searched = 0;
    for (
      let reach = Math.max(2 * medEdge, 1e-9), doublings = 0;
      doublings <= 6 && distances.size === 0;
      reach *= 2, doublings++
    ) {
      searched = reach;
      distances = nearestMasterDistances(ppt, masters, refs, reach);
    }
    if (distances.size === 0) {
      dropped({ kind: "out-of-reach", searched });
      continue;
    }

    const gap = Math.min(...distances.values());
    const kept = [...distances]
      .filter(([, distance]) => distance <= tie.reach)
      .map(([pi]) => pi);
    if (kept.length === 0) {
      dropped({ kind: "beyond-search-distance", gap, reach: tie.reach }, gap);
      continue;
    }

    const radius = partnerSearchRadius(medEdge, gap);
    const one = autoDetectCouplings(
      ppt,
      masters,
      kept,
      radius,
      maxCoupledNodes,
    );
    if (one.ref.length === 0) {
      dropped({ kind: "too-few-partners", refs: kept.length, radius }, gap);
      continue;
    }
    all = concatCouplings(all, one);
    reports.push({
      ...base,
      gap,
      nCoupled: one.ref.length,
      nPartners: one.solid.length,
    });
  }
  return {
    coupling: { ref: all.ref, offsets: all.offsets, solid: all.solid },
    reports,
  };
}

// One tie connection mapped onto pool nodes: surface A becomes the coupling
// partners, surface B the references.
interface PoolTie {
  name: string;
  masters: number[];
  refs: number[];
  reach: number;
}

// Map a connection's two picked surfaces from store vertex indices onto pool
// nodes. A vertex with no pool node is skipped: on the auto-shell path the thin
// walls a picked surface covered were replaced by mid-surface shell nodes, which
// the seam coupling already ties. A surface left with NO pool node is reported as
// a dropped tie rather than skipped silently — the seam ties that shell back to
// its own retained solid, not to the body on the other side of this connection.
function tiesToPool(
  ties: TieSurfaces[],
  poolOfVertex: (vi: number) => number | undefined,
): PoolTie[] {
  const toPool = (vertices: number[]): number[] => {
    const out: number[] = [];
    for (const vi of vertices) {
      const pi = poolOfVertex(vi);
      if (pi !== undefined) out.push(pi);
    }
    return out;
  };
  return ties.map((tie) => ({
    name: tie.name,
    masters: toPool(tie.verticesA),
    refs: toPool(tie.verticesB),
    reach: tie.maxSeparation,
  }));
}

// Drop distributing couplings whose reference (shell) node carries an essential
// BC. A fixed node's motion is prescribed, so it cannot ALSO be the dependent of
// an RBE3 average of the solid — the engine refuses that conflict rather than
// silently dropping the constraint (issue #377). This arises where a clamped
// shell edge (e.g. a bolted holder rim) sits next to the retained base solid: the
// proximity detector would otherwise couple the very nodes the user fixed. The BC
// wins; the surrounding shell/solid stays connected through the mesh either way.
export function dropCouplingsOnFixedNodes(
  coupling: CouplingSet,
  fixedDofs: Iterable<number>,
): CouplingSet {
  const fixedNodes = new Set<number>();
  for (const d of fixedDofs) fixedNodes.add(Math.floor(d / 6));
  const kinds = couplingMpcCodes(coupling);
  const masks = couplingDofMasks(coupling);
  const ref: number[] = [],
    offsets = [0],
    solid: number[] = [],
    mpc: number[] = [],
    dofMask: number[] = [];
  for (let k = 0; k < coupling.ref.length; k++) {
    // A KINEMATIC coupling's reference point is INDEPENDENT — fixing it is the
    // whole point of a bolted or clamped reference point, not a conflict — so
    // only the couplings whose reference is dependent (distributing, relaxed
    // MPC) are dropped here.
    if (kinds[k] !== 2 && fixedNodes.has(coupling.ref[k])) continue;
    ref.push(coupling.ref[k]);
    for (let i = coupling.offsets[k]; i < coupling.offsets[k + 1]; i++)
      solid.push(coupling.solid[i]);
    offsets.push(solid.length);
    mpc.push(kinds[k]);
    dofMask.push(masks[k]);
  }
  return { ref, offsets, solid, mpc, dofMask };
}

// Assemble the coupled node pool (solid nodes then shell nodes), remap tets and
// shell triangles onto it, and tie the two domains: the shell's SEAM nodes (those
// on the retained solid's boundary) to their nearest solid nodes, plus any gapped
// solid↔solid interface.
export function buildCoupledModel(
  m: ShellizeMesh,
  shells: ShellExtraction,
  wallTets: Set<number>,
  {
    seamTolerance: seamToleranceOverride,
    couplingRadius,
    maxCoupledNodes = 16,
    ties = [],
    referencePoints = [],
  }: {
    // How far off the retained solid's boundary a shell node may sit and still
    // count as seam. Defaults to seamTolerance() of the model's own scales.
    seamTolerance?: number;
    // How far a seam node may reach for its solid partners. Defaults to the
    // solid mesh's own spacing — see partnerSearchRadius.
    couplingRadius?: number;
    maxCoupledNodes?: number;
    // The model's tie connections. Distinct solid bodies are joined ONLY by
    // these — nothing is inferred from the geometry — so an assembly with no
    // connection keeps its bodies apart, which is what the empty default means.
    ties?: TieSurfaces[];
    // Vertex indices of the surface-to-point couplings' reference points. They
    // belong to no tet, so nothing else puts them in the pool.
    referencePoints?: number[];
  } = {},
): CoupledModel {
  // Solid tets = the other bodies plus the shelled body's non-wall (base) tets;
  // only the tets inside the thin walls are replaced by shell facets. Different
  // solid bodies keep their own nodes; a gapped interface is tied by the
  // distributing couplings of a tie connection (tieCouplings), not node-merging.
  const solidTets: number[] = [];
  const tetBody: number[] = [];
  for (let e = 0; e < m.tet.length / 4; e++)
    if (!(m.body[e] === shells.shellBody && wallTets.has(e))) {
      solidTets.push(
        m.tet[4 * e],
        m.tet[4 * e + 1],
        m.tet[4 * e + 2],
        m.tet[4 * e + 3],
      );
      tetBody.push(m.body[e]);
    }

  const pool: number[] = [];
  const solidPool = new Map<number, number>();
  const addPool = (x: number, y: number, z: number) => {
    const id = pool.length / 3;
    pool.push(x, y, z);
    return id;
  };
  for (const n of new Set(solidTets)) solidPool.set(n, addPool(...pt(m.V, n)));
  const shellPool: number[] = [];
  for (let s = 0; s < shells.shellVerts.length / 3; s++)
    shellPool.push(
      addPool(
        shells.shellVerts[3 * s],
        shells.shellVerts[3 * s + 1],
        shells.shellVerts[3 * s + 2],
      ),
    );
  // Reference points last, so isShellPoolIndex can keep telling the three
  // groups apart by index range.
  const refPool = new Map<number, number>();
  for (const vi of referencePoints)
    if (!refPool.has(vi)) refPool.set(vi, addPool(...pt(m.V, vi)));

  const tets = solidTets.map((n) => {
    const poolIndex = solidPool.get(n);
    if (poolIndex === undefined)
      throw new Error(`solid node ${n} missing from the coupled pool`);
    return poolIndex;
  });
  const triangles = shells.shellTris.map((s) => shellPool[s]);
  const ppt = (i: number): [number, number, number] => [
    pool[3 * i],
    pool[3 * i + 1],
    pool[3 * i + 2],
  ];

  // Every coupling distance below is derived from the solid mesh's own spacing —
  // a fixed radius rigidified whole millimetres of thin wall.
  const medEdge = medianTetEdge(ppt, tets);
  // The tie connections first — their reference nodes become coupling-dependent,
  // so the shell↔solid seam detection must not also target them (a target DOF
  // must be independent).
  const { coupling: solidCoupling, reports: tieReports } = tieCouplings(
    ppt,
    tiesToPool(ties, (vi) => solidPool.get(vi)),
    medEdge,
    maxCoupledNodes,
  );
  const solidRefs = new Set(solidCoupling.ref);
  // Tie only the shell nodes that sit on the retained solid, and let each reach
  // as far as the solid mesh's own spacing to find its partners.
  const tolerance =
    seamToleranceOverride ??
    seamTolerance(
      shells.shellThk.length > 0 ? Math.max(...shells.shellThk) : 0,
      medEdge,
    );
  const seam = seamShellNodes(ppt, shellPool, tetMeshBoundary(tets), tolerance);
  const shellCoupling = autoDetectCouplings(
    ppt,
    [...solidPool.values()].filter((pi) => !solidRefs.has(pi)),
    seam,
    couplingRadius ?? partnerSearchRadius(medEdge, tolerance),
    maxCoupledNodes,
  );

  return {
    pool,
    tets,
    tetBody,
    triangles,
    thicknesses: shells.shellThk,
    solidPool,
    shellPool,
    refPool,
    tieReports,
    // The shell↔solid seam is continuous material (a thin wall idealised as shell,
    // tied back to its retained solid) — not a tie connection between parts, and
    // never something the user declares — so it uses the relaxed MPC coupling
    // (mpc=1) for displacement continuity. A tie connection across a clearance
    // stays distributing.
    coupling: concatCouplings(
      { ...shellCoupling, mpc: shellCoupling.ref.map(() => 1) },
      { ...solidCoupling, mpc: solidCoupling.ref.map(() => 0) },
    ),
  };
}

// Coupled model built from EXPLICIT shell and solid elements (a hand-mixed
// CTRIA3 + CTETRA model, or the regenerated crane showcase) — as opposed to the
// auto-shell path, where the shells are derived by collapsing thin solid walls.
// The pool is the solid tet nodes followed by the shell triangle nodes; the two
// domains are joined by RBE3 couplings re-derived from proximity, exactly as the
// auto-shell path does. `poolOfVertex` maps every store vertex index to its pool
// node (used to place BCs/loads), and `shellPoolIndex` is the set of pool nodes
// carrying shell (6-DOF) stiffness (used to auto-fix rotations of clamped shell
// nodes). A shell node that IS a solid node (shared store id) reuses the solid
// pool entry — a direct rigid connection, no distributing coupling needed.
export interface ExplicitCoupledModel {
  pool: number[]; // 3·nPool (solid nodes then shell nodes)
  tets: number[]; // 4·nSolidTets over pool
  triangles: number[]; // 3·nShellTris over pool
  thicknesses: number[]; // per shell triangle
  coupling: CouplingSet;
  poolOfVertex: Map<number, number>; // store vertex index → pool index
  shellPoolIndex: Set<number>; // pool indices carrying shell stiffness
  tieReports: TieCouplingReport[]; // what each tie connection contributed
}

export function buildExplicitCoupledModel(
  V: number[], // 3·nNodes, xyz interleaved (store vertex order)
  solidTets: number[], // 4·nSolidTets, store vertex indices
  shellTris: number[], // 3·nShellTris, store vertex indices
  shellThk: number[], // per shell triangle thickness
  {
    seamTolerance: seamToleranceOverride,
    couplingRadius,
    maxCoupledNodes = 16,
    ties = [],
    referencePoints = [],
  }: {
    seamTolerance?: number;
    couplingRadius?: number;
    maxCoupledNodes?: number;
    // The model's tie connections — the only thing that joins distinct solid
    // bodies here (see buildCoupledModel).
    ties?: TieSurfaces[];
    // Store vertex indices of the surface-to-point couplings' REFERENCE POINTS.
    // They belong to no element, so nothing else would put them in the pool —
    // and without a pool node the coupling has no reference to tie to.
    referencePoints?: number[];
  } = {},
): ExplicitCoupledModel {
  const pool: number[] = [];
  const poolOfVertex = new Map<number, number>();
  const addVertex = (vi: number): number => {
    let pi = poolOfVertex.get(vi);
    if (pi !== undefined) return pi;
    pi = pool.length / 3;
    poolOfVertex.set(vi, pi);
    pool.push(V[3 * vi], V[3 * vi + 1], V[3 * vi + 2]);
    return pi;
  };

  // Solid nodes first — their pool indices are the RBE3 coupling targets.
  const solidPoolIndices: number[] = [];
  for (const vi of new Set(solidTets)) solidPoolIndices.push(addVertex(vi));
  const tets = solidTets.map((vi) => {
    const pi = poolOfVertex.get(vi);
    if (pi === undefined)
      throw new Error(`explicit coupled: solid node ${vi} missing from pool`);
    return pi;
  });
  // Shell nodes second — a node also used by a solid tet reuses its pool entry.
  const shellPoolIndex = new Set<number>();
  const triangles = shellTris.map((vi) => {
    const pi = addVertex(vi);
    shellPoolIndex.add(pi);
    return pi;
  });
  // Reference points last. They carry no element stiffness; the engine gives a
  // coupling reference its six DOFs and leaves its rotations free (shell_core:
  // is_coupling_ref), so they need nothing here beyond a place in the pool.
  for (const vi of referencePoints) addVertex(vi);

  const ppt = (i: number): [number, number, number] => [
    pool[3 * i],
    pool[3 * i + 1],
    pool[3 * i + 2],
  ];
  const medEdge = medianTetEdge(ppt, tets);
  // Gapped solid↔solid interfaces (a pin in a hole) tied across the clearance by
  // the model's tie connections — the same couplings the auto-shell path builds.
  const { coupling: solidCoupling, reports: tieReports } = tieCouplings(
    ppt,
    tiesToPool(ties, (vi) => poolOfVertex.get(vi)),
    medEdge,
    maxCoupledNodes,
  );
  const solidRefs = new Set(solidCoupling.ref);

  // Shell nodes NOT shared with the solid need a distributing coupling; shared
  // nodes are already rigidly attached through the common pool DOFs. Of those,
  // only the SEAM nodes — the ones sitting on the retained solid's boundary — are
  // tied, by the same geometric rule the auto-shell path uses, so a saved mixed
  // model reloads with the seam it was meshed with. Solid nodes that are tie
  // references are coupling-dependent, so exclude them as shell-coupling targets
  // (a target DOF must be independent).
  const solidPoolSet = new Set(solidPoolIndices);
  const unsharedShellNodes = [...shellPoolIndex].filter(
    (pi) => !solidPoolSet.has(pi),
  );
  const tolerance =
    seamToleranceOverride ??
    seamTolerance(shellThk.length > 0 ? Math.max(...shellThk) : 0, medEdge);
  const seam = seamShellNodes(
    ppt,
    unsharedShellNodes,
    tetMeshBoundary(tets),
    tolerance,
  );
  const shellCoupling = autoDetectCouplings(
    ppt,
    solidPoolIndices.filter((pi) => !solidRefs.has(pi)),
    seam,
    couplingRadius ?? partnerSearchRadius(medEdge, tolerance),
    maxCoupledNodes,
  );

  return {
    pool,
    tets,
    triangles,
    thicknesses: shellThk,
    // Shell↔solid seam ⇒ relaxed MPC (continuity); a tie connection across a
    // clearance ⇒ distributing.
    coupling: concatCouplings(
      { ...shellCoupling, mpc: shellCoupling.ref.map(() => 1) },
      { ...solidCoupling, mpc: solidCoupling.ref.map(() => 0) },
    ),
    poolOfVertex,
    shellPoolIndex,
    tieReports,
  };
}

// The pool is built in three blocks — solid nodes, then shell mid-surface
// nodes, then reference points — so a pool index says which it is. Only the
// middle block carries shell (6-DOF) element stiffness; a reference point has
// six DOFs too, but they come from its coupling, not from a facet.
export function isShellPoolIndex(
  model: CoupledModel,
  poolIndex: number,
): boolean {
  return (
    poolIndex >= model.solidPool.size &&
    poolIndex < model.solidPool.size + model.shellPool.length
  );
}

// Nearest shell-mid-surface pool node to a point — used to map the shelled
// body's boundary conditions and its displacement result (the mid-surface is
// offset ~t/2 from the original solid surface). Grid-accelerated with an
// expanding ring search so it works regardless of the offset magnitude.
export function shellNodeLocator(
  model: CoupledModel,
): (p: [number, number, number]) => number {
  const cell = 15;
  const grid = new Map<string, number[]>();
  const gk = (x: number, y: number, z: number) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (const pi of model.shellPool) {
    const key = gk(
      model.pool[3 * pi],
      model.pool[3 * pi + 1],
      model.pool[3 * pi + 2],
    );
    getOrInit(grid, key, () => []).push(pi);
  }
  const maxRings = 6;
  return (p) => {
    const cx = Math.floor(p[0] / cell),
      cy = Math.floor(p[1] / cell),
      cz = Math.floor(p[2] / cell);
    let best = -1,
      bd = Infinity;
    for (let r = 0; r <= maxRings && bd === Infinity; r++) {
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          for (let dz = -r; dz <= r; dz++) {
            if (
              r > 0 &&
              Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r
            )
              continue; // ring shell only
            const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!bucket) continue;
            for (const pi of bucket) {
              const dd =
                (p[0] - model.pool[3 * pi]) ** 2 +
                (p[1] - model.pool[3 * pi + 1]) ** 2 +
                (p[2] - model.pool[3 * pi + 2]) ** 2;
              if (dd < bd) {
                bd = dd;
                best = pi;
              }
            }
          }
    }
    // No candidate within the searched radius: the query point (a BC/load on the
    // shelled body) is farther from every shell mid-surface node than the grid
    // sweep reaches. Returning the seed node would silently map the constraint or
    // load onto an arbitrary, unrelated node — throw instead (issue #378).
    if (best < 0 || bd === Infinity)
      throw new Error(
        `shellNodeLocator: no shell mid-surface node found within ${maxRings * cell} units of ` +
          `query point (${p[0]}, ${p[1]}, ${p[2]}) — a boundary condition or load on the shelled ` +
          "body could not be mapped onto the shell mesh. The node may lie farther from any thin " +
          "wall than the search radius, or the model may be mis-scaled.",
      );
    return best;
  };
}
