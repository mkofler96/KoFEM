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

// Minimum vertex-to-opposite-face altitude divided by the longest edge — a
// scale-invariant shape measure. A well-formed tet is ≈ 0.3–0.8; a flat sliver
// (the element that fills a thin wall) is well below 0.1. Being a ratio it is
// independent of mesh size, so the sliver/base split holds across refinements.
function tetFlatness(
  V: number[],
  a: number,
  b: number,
  c: number,
  d: number,
): number {
  const verts = [pt(V, a), pt(V, b), pt(V, c), pt(V, d)];
  let longest = 0;
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++) {
      const edge = Math.hypot(
        verts[i][0] - verts[j][0],
        verts[i][1] - verts[j][1],
        verts[i][2] - verts[j][2],
      );
      if (edge > longest) longest = edge;
    }
  let minAlt = Infinity;
  for (let k = 0; k < 4; k++) {
    const apex = verts[k],
      base0 = verts[(k + 1) % 4],
      base1 = verts[(k + 2) % 4],
      base2 = verts[(k + 3) % 4];
    const ux = base0[0] - base1[0],
      uy = base0[1] - base1[1],
      uz = base0[2] - base1[2];
    const vx = base2[0] - base1[0],
      vy = base2[1] - base1[1],
      vz = base2[2] - base1[2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    // eslint-disable-next-line kofem/no-silent-fallback -- div-by-zero guard: a degenerate opposite face has no defined altitude direction
    const nl = Math.hypot(nx, ny, nz) || 1;
    const altitude = Math.abs(
      (nx * (apex[0] - base1[0]) +
        ny * (apex[1] - base1[1]) +
        nz * (apex[2] - base1[2])) /
        nl,
    );
    if (altitude < minAlt) minAlt = altitude;
  }
  // eslint-disable-next-line kofem/no-silent-fallback -- div-by-zero guard: a fully degenerate tet has no longest edge
  return minAlt / (longest || 1);
}

// The thin-wall (sliver) tets of the shelled body: the flat elements that fill
// the thin walls being replaced by shells. Everything else of that body — the
// thick junction/base blocks that connect it to the other bodies — stays a solid
// tet so its stiffness and its contact with the neighbours are preserved.
// Collapsing the WHOLE body to shells silently dropped those blocks (the crane
// holder lost ~30 % of its volume, exactly the block carrying load into the hook),
// leaving the shells floating with only a proximity coupling to the solids.
export function shellBodySliverTets(
  m: ShellizeMesh,
  shellBody: number,
  { sliverFlatness = 0.2 }: { sliverFlatness?: number } = {},
): Set<number> {
  const slivers = new Set<number>();
  for (let e = 0; e < m.tet.length / 4; e++)
    if (
      m.body[e] === shellBody &&
      tetFlatness(
        m.V,
        m.tet[4 * e],
        m.tet[4 * e + 1],
        m.tet[4 * e + 2],
        m.tet[4 * e + 3],
      ) < sliverFlatness
    )
      slivers.add(e);
  return slivers;
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

// Collapse the kept wall faces to mid-surface facets (offset t/2 inward) and
// weld mid-surface nodes that came from the SAME original mesh node. Where two
// walls meet at a CAD edge they share Netgen's edge nodes, so joining nodes by
// original id fuses the walls exactly — independent of mesh resolution (a
// spatial tolerance over-welds a fine mesh and under-welds a coarse one).
function collapseWallsToMidSurface(
  m: ShellizeMesh,
  walls: Wall[],
): Pick<
  ShellExtraction,
  "shellVerts" | "shellTris" | "shellThk" | "shellSrc" | "shellTriSrc"
> {
  const keep = new Map(walls.map((w) => [w.keep, w]));

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
  for (let t = 0; t < m.surfFace.length; t++) {
    const wall = keep.get(m.surfFace[t]);
    if (!wall) continue;
    const offset = wall.thk / 2;
    const nn = [
      m.surfTri[3 * t],
      m.surfTri[3 * t + 1],
      m.surfTri[3 * t + 2],
    ].map((oi) => {
      const pos = pt(m.V, oi);
      return addN(wall.keep, oi, [
        pos[0] - wall.n[0] * offset,
        pos[1] - wall.n[1] * offset,
        pos[2] - wall.n[2] * offset,
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

export interface CoupledModel {
  pool: number[]; // 3·nPool (solid nodes then shell nodes)
  tets: number[]; // 4·nSolidTets over pool
  tetBody: number[]; // body id per solid tet (for per-body PSOLID labelling)
  triangles: number[]; // 3·nShellTris over pool
  thicknesses: number[];
  coupling: { ref: number[]; offsets: number[]; solid: number[] };
  solidPool: Map<number, number>; // original vertex index → pool index (solid)
  shellPool: number[]; // local shell index → pool index
}

// Auto-detect distributing (RBE3) couplings: every reference (shell) node that
// has ≥3 solid nodes within couplingRadius ties to them. Emitted CSR-style —
// ref[k] ties to solid[offsets[k]..offsets[k+1]). Only the k NEAREST solid
// candidates are kept per coupling: the RBE3 master-slave expansion is quadratic
// in that count, so a radius alone picks hundreds of nodes on a fine mesh and the
// reduction dominates the solve; ~16 well-spread nodes transmit force and moment
// just as well and bound the cost independently of mesh density.
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
      near.sort((a, b) => a.d2 - b.d2);
      ref.push(gi);
      for (const { pi } of near.slice(0, maxCoupledNodes)) solid.push(pi);
      offsets.push(solid.length);
    }
  }
  return { ref, offsets, solid };
}

// Concatenate two CSR coupling sets (shell↔solid and solid↔solid) into one.
function concatCouplings(
  a: { ref: number[]; offsets: number[]; solid: number[] },
  b: { ref: number[]; offsets: number[]; solid: number[] },
): { ref: number[]; offsets: number[]; solid: number[] } {
  const ref = [...a.ref, ...b.ref];
  const solid = [...a.solid, ...b.solid];
  const offsets = [...a.offsets];
  const base = a.solid.length;
  for (let k = 1; k < b.offsets.length; k++) offsets.push(base + b.offsets[k]);
  return { ref, offsets, solid };
}

// Distributing (RBE3) tie of a gapped solid↔solid interface — two solid bodies
// that touch across a clearance (a pin in a hole). Netgen meshes the assembly
// nearly conformally, so the bodies can share a handful of interface nodes: that
// thin bridge makes them one connected component yet leaves the pin hanging by a
// near-hinge. So the split is by BODY LABEL, not connectivity: `poolBody` maps
// each solid pool node to the set of bodies whose tets use it. The body with the
// most exclusive nodes is the "master"; every exclusive node of another body with
// ≥3 master nodes within `radius` distributes onto its nearest master nodes,
// transmitting force AND moment across the clearance without merging. Nodes shared
// by two bodies (the conformal bridge) are already rigidly joined and are skipped.
// A body with no master node in range (held another way, e.g. a shelled body's
// base carried by its shell couplings) simply gets no coupling.
function autoDetectSolidCouplings(
  ppt: (i: number) => [number, number, number],
  poolBody: Map<number, Set<number>>,
  radius: number,
  maxCoupledNodes: number,
): { ref: number[]; offsets: number[]; solid: number[] } {
  const bodyOfNode = new Map<number, number>();
  const bodyCount = new Map<number, number>();
  for (const [pi, bodies] of poolBody) {
    if (bodies.size !== 1) continue; // shared interface node — already joined
    const body = [...bodies][0];
    bodyOfNode.set(pi, body);
    // eslint-disable-next-line kofem/no-silent-fallback -- counting occurrences; 0 is the identity for a body seen for the first time
    bodyCount.set(body, (bodyCount.get(body) ?? 0) + 1);
  }
  if (bodyCount.size < 2) return { ref: [], offsets: [0], solid: [] };
  let master = -1,
    best = -1;
  for (const [body, count] of bodyCount)
    if (count > best) {
      best = count;
      master = body;
    }
  const masterNodes: number[] = [],
    otherNodes: number[] = [];
  for (const [pi, body] of bodyOfNode)
    (body === master ? masterNodes : otherNodes).push(pi);
  return autoDetectCouplings(
    ppt,
    masterNodes,
    otherNodes,
    radius,
    maxCoupledNodes,
  );
}

// Drop distributing couplings whose reference (shell) node carries an essential
// BC. A fixed node's motion is prescribed, so it cannot ALSO be the dependent of
// an RBE3 average of the solid — the engine refuses that conflict rather than
// silently dropping the constraint (issue #377). This arises where a clamped
// shell edge (e.g. a bolted holder rim) sits next to the retained base solid: the
// proximity detector would otherwise couple the very nodes the user fixed. The BC
// wins; the surrounding shell/solid stays connected through the mesh either way.
export function dropCouplingsOnFixedNodes(
  coupling: { ref: number[]; offsets: number[]; solid: number[] },
  fixedDofs: Iterable<number>,
): { ref: number[]; offsets: number[]; solid: number[] } {
  const fixedNodes = new Set<number>();
  for (const d of fixedDofs) fixedNodes.add(Math.floor(d / 6));
  const ref: number[] = [],
    offsets = [0],
    solid: number[] = [];
  for (let k = 0; k < coupling.ref.length; k++) {
    if (fixedNodes.has(coupling.ref[k])) continue;
    ref.push(coupling.ref[k]);
    for (let i = coupling.offsets[k]; i < coupling.offsets[k + 1]; i++)
      solid.push(coupling.solid[i]);
    offsets.push(solid.length);
  }
  return { ref, offsets, solid };
}

// Assemble the coupled node pool (solid nodes then shell nodes), remap tets and
// shell triangles onto it, and auto-detect distributing couplings (each shell
// node near ≥3 solid nodes ties to them).
export function buildCoupledModel(
  m: ShellizeMesh,
  shells: ShellExtraction,
  sliverTets: Set<number>,
  {
    couplingRadius = 10,
    solidCouplingRadius = 8,
    maxCoupledNodes = 16,
  }: {
    couplingRadius?: number;
    solidCouplingRadius?: number;
    maxCoupledNodes?: number;
  } = {},
): CoupledModel {
  // Solid tets = the other bodies plus the shelled body's non-wall (base) tets;
  // only the thin-wall slivers are replaced by shell facets. Different solid
  // bodies keep their own nodes; a gapped interface is tied by distributing
  // couplings (autoDetectSolidCouplings), not node-merging.
  const solidTets: number[] = [];
  const tetBody: number[] = [];
  for (let e = 0; e < m.tet.length / 4; e++)
    if (!(m.body[e] === shells.shellBody && sliverTets.has(e))) {
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

  // Body of each solid pool node (a conformal interface node carries >1 body).
  const poolBody = new Map<number, Set<number>>();
  for (let t = 0; t < tets.length / 4; t++)
    for (let k = 0; k < 4; k++)
      getOrInit(poolBody, tets[4 * t + k], () => new Set<number>()).add(
        tetBody[t],
      );

  // Gapped solid↔solid interfaces (pin in a hole) first — their reference nodes
  // become coupling-dependent, so the shell↔solid detection must not also target
  // them (a target DOF must be independent).
  const solidCoupling = autoDetectSolidCouplings(
    ppt,
    poolBody,
    solidCouplingRadius,
    maxCoupledNodes,
  );
  const solidRefs = new Set(solidCoupling.ref);
  const shellCoupling = autoDetectCouplings(
    ppt,
    [...solidPool.values()].filter((pi) => !solidRefs.has(pi)),
    shellPool,
    couplingRadius,
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
    coupling: concatCouplings(shellCoupling, solidCoupling),
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
  coupling: { ref: number[]; offsets: number[]; solid: number[] };
  poolOfVertex: Map<number, number>; // store vertex index → pool index
  shellPoolIndex: Set<number>; // pool indices carrying shell stiffness
}

export function buildExplicitCoupledModel(
  V: number[], // 3·nNodes, xyz interleaved (store vertex order)
  solidTets: number[], // 4·nSolidTets, store vertex indices
  solidTetBody: number[], // body/property id per solid tet (labels the pin/hole bodies)
  shellTris: number[], // 3·nShellTris, store vertex indices
  shellThk: number[], // per shell triangle thickness
  {
    couplingRadius = 10,
    solidCouplingRadius = 8,
    maxCoupledNodes = 16,
  }: {
    couplingRadius?: number;
    solidCouplingRadius?: number;
    maxCoupledNodes?: number;
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
  // Body of each solid pool node, from the per-tet body labels.
  const poolBody = new Map<number, Set<number>>();
  for (let t = 0; t < tets.length / 4; t++)
    for (let k = 0; k < 4; k++)
      getOrInit(poolBody, tets[4 * t + k], () => new Set<number>()).add(
        solidTetBody[t],
      );

  // Shell nodes second — a node also used by a solid tet reuses its pool entry.
  const shellPoolIndex = new Set<number>();
  const triangles = shellTris.map((vi) => {
    const pi = addVertex(vi);
    shellPoolIndex.add(pi);
    return pi;
  });

  const ppt = (i: number): [number, number, number] => [
    pool[3 * i],
    pool[3 * i + 1],
    pool[3 * i + 2],
  ];
  // Gapped solid↔solid interfaces (pin in a hole) tied across the clearance,
  // split by body label — re-derives the same tie the auto-shell path baked into
  // the .vtu (where the bodies are distinct PSOLID properties).
  const solidCoupling = autoDetectSolidCouplings(
    ppt,
    poolBody,
    solidCouplingRadius,
    maxCoupledNodes,
  );
  const solidRefs = new Set(solidCoupling.ref);

  // Shell nodes NOT shared with the solid need a distributing coupling; shared
  // nodes are already rigidly attached through the common pool DOFs. Solid nodes
  // that are solid-tie references are coupling-dependent, so exclude them as
  // shell-coupling targets (a target DOF must be independent).
  const solidPoolSet = new Set(solidPoolIndices);
  const refPoolIndices = [...shellPoolIndex].filter(
    (pi) => !solidPoolSet.has(pi),
  );
  const shellCoupling = autoDetectCouplings(
    ppt,
    solidPoolIndices.filter((pi) => !solidRefs.has(pi)),
    refPoolIndices,
    couplingRadius,
    maxCoupledNodes,
  );

  return {
    pool,
    tets,
    triangles,
    thicknesses: shellThk,
    coupling: concatCouplings(shellCoupling, solidCoupling),
    poolOfVertex,
    shellPoolIndex,
  };
}

// A shell node is "solid" in the pool iff its index is < solidPool.size; shell
// nodes are appended after the solid nodes.
export function isShellPoolIndex(
  model: CoupledModel,
  poolIndex: number,
): boolean {
  return poolIndex >= model.solidPool.size;
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
