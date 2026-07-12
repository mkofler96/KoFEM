// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure face-picking algorithm — no React / Three.js dependency.
// Used by MeshScene.tsx and by unit tests.

export const FLAT_ANGLE = (15 * Math.PI) / 180; // flat: all neighbors within 15° of seed
export const CURVE_ANGLE = (89 * Math.PI) / 180; // curved: stop only at near-perpendicular feature edges
export const COS_FLAT = Math.cos(FLAT_ANGLE);
export const COS_CURVE = Math.cos(CURVE_ANGLE);

// Edge-pick polyline walk: stop when the turn between consecutive boundary
// segments exceeds this. Straight runs (turn ≈ 0) traverse up to sharp corners;
// a smoothly-tessellated hole/fillet loop (small per-segment turns) is walked
// whole. 50° stops at 90° corners while continuing round circles of ≥8 segments.
export const EDGE_TURN_LIMIT = (50 * Math.PI) / 180;

export type Vec3 = [number, number, number];
export type Tri = [number, number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len < 1e-30) return [0, 1, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

export interface BoundaryMeshTopo {
  triangles: Tri[];
  edgeToTris: Map<string, number[]>;
  triNormals: Vec3[];
  faceIds?: number[]; // OCC face index per triangle (1-based); present when mesh came from STEP
}

export interface PickedFace {
  nodeIds: number[];
  axis: "X" | "Y" | "Z";
  isMax: boolean;
  label: string;
}

// Two picked faces are the same when they reference the same set of nodes.
// pickFaceNodeIds returns a deterministic node-id set for a given CAD face, so a
// set comparison is enough to detect re-selecting an already-picked face.
export function sameFaceNodes(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/**
 * Fold a freshly picked selection into the current one.
 *
 * Re-selecting an item that is already in the selection removes it instead of
 * adding a duplicate (#264); otherwise it is appended. Items are identified by
 * their node-id set (see `sameFaceNodes`). The result is relabeled
 * "<noun> 1..N" by position so labels stay contiguous after a toggle. `noun`
 * is "Face" for region picks and "Edge" for polyline picks.
 */
export function toggleFaceSelection(
  current: PickedFace[],
  picked: PickedFace,
  noun: "Face" | "Edge" = "Face",
): PickedFace[] {
  const existingIdx = current.findIndex((f) =>
    sameFaceNodes(f.nodeIds, picked.nodeIds),
  );
  const next =
    existingIdx >= 0
      ? current.filter((_, i) => i !== existingIdx)
      : [...current, picked];
  return next.map((f, i) => ({
    ...f,
    label: `${noun} ${i + 1} (${f.nodeIds.length} nodes)`,
  }));
}

export function buildEdgeToTris(triangles: Tri[]): Map<string, number[]> {
  const edgeToTris = new Map<string, number[]>();
  for (let i = 0; i < triangles.length; i++) {
    const [a, b, c] = triangles[i];
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ] as [number, number][]) {
      const key = x < y ? `${x},${y}` : `${y},${x}`;
      const list = edgeToTris.get(key);
      if (list) list.push(i);
      else edgeToTris.set(key, [i]);
    }
  }
  return edgeToTris;
}

export function buildTriNormals(
  triangles: Tri[],
  getPos: (id: number) => Vec3,
): Vec3[] {
  return triangles.map(([a, b, c]) => {
    const pa = getPos(a),
      pb = getPos(b),
      pc = getPos(c);
    const AB: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const AC: Vec3 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    return normalize(cross(AB, AC));
  });
}

export function buildBoundaryMeshTopo(
  triangles: Tri[],
  getPos: (id: number) => Vec3,
  faceIds?: number[],
): BoundaryMeshTopo {
  return {
    triangles,
    edgeToTris: buildEdgeToTris(triangles),
    triNormals: buildTriNormals(triangles, getPos),
    faceIds,
  };
}

/**
 * Pick a face starting from triangle `startIdx`.
 *
 * Two modes:
 *   CAD face ID mode  — when `topo.faceIds` is present, instantly selects all
 *                       triangles with the same OCC face index.  Topologically
 *                       exact: each STEP face is always selected whole.
 *   BFS flood-fill    — fallback when no face IDs are available.  Uses normal
 *                       angle thresholds; surface type (flat vs curved) is
 *                       detected from the seed triangle's edge-adjacent neighbors.
 *
 * Returns the set of node IDs belonging to the picked face.
 */
export function pickFaceNodeIds(
  startIdx: number,
  topo: BoundaryMeshTopo,
): Set<number> {
  const { triangles, edgeToTris, triNormals, faceIds } = topo;

  // ── CAD face ID mode ─────────────────────────────────────────────────────────
  if (faceIds) {
    const targetId = faceIds[startIdx];
    const nodeIds = new Set<number>();
    for (let i = 0; i < triangles.length; i++) {
      if (faceIds[i] === targetId) {
        nodeIds.add(triangles[i][0]);
        nodeIds.add(triangles[i][1]);
        nodeIds.add(triangles[i][2]);
      }
    }
    return nodeIds;
  }

  // ── BFS flood-fill fallback ──────────────────────────────────────────────────
  const seedNormal = triNormals[startIdx];
  const [sa, sb, sc] = triangles[startIdx];
  let flatCount = 0,
    curvedCount = 0;
  for (const [x, y] of [
    [sa, sb],
    [sb, sc],
    [sc, sa],
  ] as [number, number][]) {
    const key = x < y ? `${x},${y}` : `${y},${x}`;
    for (const ni of edgeToTris.get(key) ?? []) {
      if (ni !== startIdx) {
        if (Math.abs(dot(seedNormal, triNormals[ni])) > COS_FLAT) flatCount++;
        else curvedCount++;
      }
    }
  }

  // A cylinder's seed triangle typically has 2 axial neighbours (same normal,
  // flatCount=2) and 1 circumferential neighbour (rotated normal, curvedCount=1).
  // The former heuristic (flatCount >= curvedCount → 2≥1 → flat) wrongly
  // classified cylinders as flat and blocked circumferential traversal.
  // Correct rule: only treat a surface as flat when EVERY edge-adjacent
  // neighbour shares the same normal.
  const isFlat = curvedCount === 0;

  const visited = new Set<number>([startIdx]);
  const queue = [startIdx];
  const nodeIds = new Set<number>();

  while (queue.length > 0) {
    const triIdx = queue.shift()!;
    const [a, b, c] = triangles[triIdx];
    nodeIds.add(a);
    nodeIds.add(b);
    nodeIds.add(c);

    const n = triNormals[triIdx];
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ] as [number, number][]) {
      const key = x < y ? `${x},${y}` : `${y},${x}`;
      for (const ni of edgeToTris.get(key) ?? []) {
        if (visited.has(ni)) continue;
        // Flat: compare against the seed normal (stops at any corner).
        // Curved: step-to-step comparison only (traverses cylinders/fillets).
        // Absolute dot product handles inconsistent winding from the tet mesher.
        const absDot = Math.abs(
          isFlat ? dot(seedNormal, triNormals[ni]) : dot(n, triNormals[ni]),
        );
        if (absDot > (isFlat ? COS_FLAT : COS_CURVE)) {
          visited.add(ni);
          queue.push(ni);
        }
      }
    }
  }

  return nodeIds;
}

// ── Edge picking ──────────────────────────────────────────────────────────────
//
// A shell mesh is a 2D sheet, so its whole flat face is one face-pick region —
// there is no way to grab just its boundary polyline (the pulled edge of a plate,
// a supported rim) for an edge load or a supported-edge BC. Edge picking fills
// that gap: it selects the connected boundary polyline near the click.

function edgeKey(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

/**
 * Boundary edges of a surface mesh: the triangle edges used by exactly one
 * facet. This is the used-once extraction of `extractBoundaryTriFaceIds` one
 * dimension down — for a shell sheet it yields the outer rim and any hole rims;
 * for a closed solid boundary (every edge shared by two facets) it is empty.
 * Returned as `[min, max]` node-id pairs (matching `edgeToTris` keys).
 */
export function extractBoundaryEdges(
  topo: BoundaryMeshTopo,
): [number, number][] {
  const edges: [number, number][] = [];
  for (const [key, tris] of topo.edgeToTris) {
    if (tris.length !== 1) continue;
    const [a, b] = key.split(",").map(Number);
    edges.push([a, b]);
  }
  return edges;
}

function pointSegmentDistSq(p: Vec3, a: Vec3, b: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const abLenSq = dot(ab, ab);
  const proj =
    abLenSq < 1e-30 ? 0 : Math.max(0, Math.min(1, dot(ap, ab) / abLenSq));
  const perp: Vec3 = [
    ap[0] - proj * ab[0],
    ap[1] - proj * ab[1],
    ap[2] - proj * ab[2],
  ];
  return dot(perp, perp);
}

/**
 * Pick the connected boundary polyline of a shell mesh near a click.
 *
 * The seed is the boundary edge nearest the click point — preferring the edges
 * of the clicked triangle (`startTriIdx`) so a click on the rim grabs the rim it
 * is on, falling back to the globally nearest boundary edge when the clicked
 * triangle is interior. From the seed the walk extends along both directions,
 * stepping to the next boundary edge whenever the turn between consecutive
 * segment directions stays within `EDGE_TURN_LIMIT` (see face-pick's analogous
 * feature-angle walk). It stops at sharp corners and closes round smooth loops.
 *
 * Returns the set of node IDs on the picked polyline — the same node-id-set
 * shape `pickFaceNodeIds` returns, so group creation, storage and the solve
 * path (the shell edge fallback in `loadedFaces`) need no changes.
 */
export function pickEdgeNodeIds(
  clickPoint: Vec3,
  startTriIdx: number,
  topo: BoundaryMeshTopo,
  getPos: (id: number) => Vec3,
): Set<number> {
  const boundaryEdges = extractBoundaryEdges(topo);
  if (boundaryEdges.length === 0) return new Set();

  const keyToIdx = new Map<string, number>();
  boundaryEdges.forEach((e, i) => keyToIdx.set(edgeKey(e[0], e[1]), i));

  // Seed candidates: the boundary edges of the clicked triangle, else all edges.
  const [ta, tb, tc] = topo.triangles[startTriIdx];
  const triEdges = [
    keyToIdx.get(edgeKey(ta, tb)),
    keyToIdx.get(edgeKey(tb, tc)),
    keyToIdx.get(edgeKey(tc, ta)),
  ].filter((i): i is number => i !== undefined);
  const candidates =
    triEdges.length > 0 ? triEdges : boundaryEdges.map((_, i) => i);

  let seed = candidates[0];
  let best = Infinity;
  for (const i of candidates) {
    const dist = pointSegmentDistSq(
      clickPoint,
      getPos(boundaryEdges[i][0]),
      getPos(boundaryEdges[i][1]),
    );
    if (dist < best) {
      best = dist;
      seed = i;
    }
  }

  const vertexToEdges = new Map<number, number[]>();
  for (let i = 0; i < boundaryEdges.length; i++) {
    for (const v of boundaryEdges[i]) {
      const list = vertexToEdges.get(v);
      if (list) list.push(i);
      else vertexToEdges.set(v, [i]);
    }
  }

  const other = (edge: number, v: number): number =>
    boundaryEdges[edge][0] === v
      ? boundaryEdges[edge][1]
      : boundaryEdges[edge][0];
  const dir = (from: number, to: number): Vec3 => {
    const pa = getPos(from),
      pb = getPos(to);
    return normalize([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]);
  };

  const selected = new Set<number>([seed]);
  for (const startVertex of boundaryEdges[seed]) {
    let currentEdge = seed;
    let tip = startVertex; // growing end of the polyline
    let travelDir = dir(other(currentEdge, tip), tip);
    for (;;) {
      let nextEdge = -1;
      let bestTurn = EDGE_TURN_LIMIT;
      for (const e of vertexToEdges.get(tip) ?? []) {
        if (e === currentEdge || selected.has(e)) continue;
        const nextDir = dir(tip, other(e, tip));
        const turn = Math.acos(
          Math.max(-1, Math.min(1, dot(travelDir, nextDir))),
        );
        if (turn < bestTurn) {
          bestTurn = turn;
          nextEdge = e;
        }
      }
      if (nextEdge < 0) break;
      selected.add(nextEdge);
      const nextTip = other(nextEdge, tip);
      travelDir = dir(tip, nextTip);
      currentEdge = nextEdge;
      tip = nextTip;
    }
  }

  const nodeIds = new Set<number>();
  for (const e of selected) {
    nodeIds.add(boundaryEdges[e][0]);
    nodeIds.add(boundaryEdges[e][1]);
  }
  return nodeIds;
}
