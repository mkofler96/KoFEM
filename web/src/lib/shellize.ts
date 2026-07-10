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

/* eslint-disable kofem/min-identifier-length -- dense vector/geometry math: a,b,c
   are triangle vertices, A,B,C their positions, u,v edge vectors, n a normal, p,q
   points, r/R radii — short names match the mathematical notation and the
   reference pipeline in examples/shell-coupling/lib.mjs */

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

export interface ShellExtraction {
  walls: {
    keep: number;
    n: [number, number, number];
    thk: number;
    body: number;
  }[];
  shellBody: number;
  shellVerts: number[]; // 3·nShellNodes
  shellTris: number[]; // 3·nShellTris (local shell indices)
  shellThk: number[]; // per shell tri
  shellSrc: number[]; // source OCC face per shell node
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

function faceProps(m: ShellizeMesh): FaceProp[] {
  const faceBody = new Map<string, number>();
  for (let e = 0; e < m.tet.length / 4; e++) {
    const p = [
      m.tet[4 * e],
      m.tet[4 * e + 1],
      m.tet[4 * e + 2],
      m.tet[4 * e + 3],
    ];
    for (const f of TET_FACES) {
      const k = [p[f[0]], p[f[1]], p[f[2]]].sort((a, b) => a - b).join(",");
      faceBody.set(k, m.body[e]);
    }
  }
  const F = new Map<
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
    const a = m.surfTri[3 * t],
      b = m.surfTri[3 * t + 1],
      c = m.surfTri[3 * t + 2];
    const A = pt(m.V, a),
      B = pt(m.V, b),
      C = pt(m.V, c);
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const nx = u[1] * v[2] - u[2] * v[1],
      ny = u[2] * v[0] - u[0] * v[2],
      nz = u[0] * v[1] - u[1] * v[0];
    const area = 0.5 * Math.hypot(nx, ny, nz);
    let f = F.get(m.surfFace[t]);
    if (!f) {
      const faceKey = [a, b, c].sort((x, y) => x - y).join(",");
      // eslint-disable-next-line kofem/no-silent-fallback -- a surface triangle with no owning tet face gets body -1 and is excluded from wall detection; it never reaches the solver
      const bodyOf = faceBody.get(faceKey) ?? -1;
      f = { area: 0, nx: 0, ny: 0, nz: 0, cx: 0, cy: 0, cz: 0, body: bodyOf };
      F.set(m.surfFace[t], f);
    }
    f.area += area;
    f.nx += nx / 2;
    f.ny += ny / 2;
    f.nz += nz / 2;
    f.cx += ((A[0] + B[0] + C[0]) / 3) * area;
    f.cy += ((A[1] + B[1] + C[1]) / 3) * area;
    f.cz += ((A[2] + B[2] + C[2]) / 3) * area;
  }
  return [...F.entries()]
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

// Detect thin walls (opposite planar CAD-face pairs) and collapse each to a
// mid-surface facet with its wall thickness; weld walls at their junctions.
// Returns an empty extraction (shellBody = -1) when no thin walls are found, so
// the caller can fall back to the all-solid solve.
export function extractThinWallShells(
  m: ShellizeMesh,
  { maxWall = 15 }: { maxWall?: number } = {},
): ShellExtraction {
  const faces = faceProps(m);
  if (faces.length === 0)
    return {
      walls: [],
      shellBody: -1,
      shellVerts: [],
      shellTris: [],
      shellThk: [],
      shellSrc: [],
    };
  const big = faces.filter(
    (f) => f.area > 0.01 * faces[0].area && f.flat > 0.9,
  );
  const used = new Set<number>();
  const walls: ShellExtraction["walls"] = [];
  for (let i = 0; i < big.length; i++) {
    if (used.has(big[i].id)) continue;
    let best = -1,
      bo = Infinity;
    for (let j = 0; j < big.length; j++) {
      if (i === j || used.has(big[j].id) || big[i].body !== big[j].body)
        continue;
      const d =
        big[i].n[0] * big[j].n[0] +
        big[i].n[1] * big[j].n[1] +
        big[i].n[2] * big[j].n[2];
      if (d > -0.85) continue;
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
      // Keep the OUTER face of the pair (its normal points away from the other
      // face): adjacent walls' outer faces meet at convex CAD edges and share
      // Netgen's edge nodes, which the junction weld below relies on.
      const fa = big[i],
        fb = big[best];
      const dcx = fa.c[0] - fb.c[0],
        dcy = fa.c[1] - fb.c[1],
        dcz = fa.c[2] - fb.c[2];
      const outer = fa.n[0] * dcx + fa.n[1] * dcy + fa.n[2] * dcz > 0 ? fa : fb;
      walls.push({ keep: outer.id, n: outer.n, thk: bo, body: fa.body });
    }
  }
  if (walls.length === 0)
    return {
      walls: [],
      shellBody: -1,
      shellVerts: [],
      shellTris: [],
      shellThk: [],
      shellSrc: [],
    };
  const shellBody = walls[0].body;
  const keep = new Map(walls.map((w) => [w.keep, w]));

  const rawV: number[] = [],
    rawT: number[] = [],
    rawThk: number[] = [],
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
    const w = keep.get(m.surfFace[t]);
    if (!w) continue;
    const o = w.thk / 2;
    const nn = [
      m.surfTri[3 * t],
      m.surfTri[3 * t + 1],
      m.surfTri[3 * t + 2],
    ].map((oi) => {
      const p = pt(m.V, oi);
      return addN(w.keep, oi, [
        p[0] - w.n[0] * o,
        p[1] - w.n[1] * o,
        p[2] - w.n[2] * o,
      ]);
    });
    rawT.push(nn[0], nn[1], nn[2]);
    rawThk.push(w.thk);
  }

  // Weld mid-surface nodes that came from the SAME original mesh node. Where two
  // walls meet at a CAD edge they share Netgen's edge nodes, so joining nodes by
  // original id fuses the walls exactly — independent of mesh resolution (a
  // spatial tolerance over-welds a fine mesh and under-welds a coarse one).
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
  for (let i = 0; i < nR; i++)
    (
      byOrig.get(rawOrig[i]) ?? byOrig.set(rawOrig[i], []).get(rawOrig[i])!
    ).push(i);
  for (const [, group] of byOrig)
    for (let k = 1; k < group.length; k++) {
      const a = find(group[0]),
        c = find(group[k]);
      if (a !== c) rep[Math.max(a, c)] = Math.min(a, c);
    }
  const comp = new Map<number, number>();
  const shellVerts: number[] = [],
    shellSrc: number[] = [];
  const cid = (i: number) => {
    const r = find(i);
    let c = comp.get(r);
    if (c === undefined) {
      c = shellVerts.length / 3;
      comp.set(r, c);
      shellVerts.push(rawV[3 * r], rawV[3 * r + 1], rawV[3 * r + 2]);
      shellSrc.push(rawSrc[r]);
    }
    return c;
  };
  const shellTris: number[] = [],
    shellThk: number[] = [];
  for (let t = 0; t < rawT.length / 3; t++) {
    const a = cid(rawT[3 * t]),
      b = cid(rawT[3 * t + 1]),
      c = cid(rawT[3 * t + 2]);
    if (a === b || b === c || a === c) continue;
    shellTris.push(a, b, c);
    shellThk.push(rawThk[t]);
  }
  return { walls, shellBody, shellVerts, shellTris, shellThk, shellSrc };
}

// Mutual-nearest weld of different-body solid nodes within tieDist (heals a
// near-hinge where two solid bodies touch without a shared face).
export function tieSolidBodies(
  m: ShellizeMesh,
  shellBody: number,
  { tieDist = 2.5 }: { tieDist?: number } = {},
): Map<number, number> {
  const bodiesOf = new Map<number, Set<number>>();
  for (let e = 0; e < m.tet.length / 4; e++) {
    if (m.body[e] === shellBody) continue;
    for (let k = 0; k < 4; k++) {
      const n = m.tet[4 * e + k];
      (bodiesOf.get(n) ?? bodiesOf.set(n, new Set()).get(n)!).add(m.body[e]);
    }
  }
  const nodes = [...bodiesOf.keys()];
  const grid = new Map<string, number[]>();
  const gk = (x: number, y: number, z: number) =>
    `${Math.floor(x / tieDist)},${Math.floor(y / tieDist)},${Math.floor(z / tieDist)}`;
  for (const n of nodes) {
    const p = pt(m.V, n);
    (grid.get(gk(...p)) ?? grid.set(gk(...p), []).get(gk(...p))!).push(n);
  }
  const nearest = new Map<number, number>();
  for (const n of nodes) {
    const p = pt(m.V, n);
    const cx = Math.floor(p[0] / tieDist),
      cy = Math.floor(p[1] / tieDist),
      cz = Math.floor(p[2] / tieDist);
    let bn = -1,
      bd = tieDist * tieDist;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const b = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!b) continue;
          for (const mm of b) {
            if (mm === n) continue;
            let same = false;
            for (const x of bodiesOf.get(n)!)
              if (bodiesOf.get(mm)!.has(x)) same = true;
            if (same) continue;
            const q = pt(m.V, mm);
            const dd =
              (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
            if (dd < bd) {
              bd = dd;
              bn = mm;
            }
          }
        }
    nearest.set(n, bn);
  }
  const rep = new Map<number, number>();
  for (const n of nodes) {
    const mm = nearest.get(n)!;
    if (mm >= 0 && nearest.get(mm) === n && n < mm) rep.set(mm, n);
  }
  return rep;
}

export interface CoupledModel {
  pool: number[]; // 3·nPool (solid nodes then shell nodes)
  tets: number[]; // 4·nSolidTets over pool
  triangles: number[]; // 3·nShellTris over pool
  thicknesses: number[];
  coupling: { ref: number[]; offsets: number[]; solid: number[] };
  solidPool: Map<number, number>; // original vertex index → pool index (solid)
  shellPool: number[]; // local shell index → pool index
  tied: (n: number) => number;
}

// Assemble the coupled node pool (solid nodes then shell nodes), remap tets and
// shell triangles onto it, and auto-detect distributing couplings (each shell
// node near ≥3 solid nodes ties to them).
export function buildCoupledModel(
  m: ShellizeMesh,
  shells: ShellExtraction,
  tieRep: Map<number, number>,
  {
    couplingRadius = 10,
    maxCoupledNodes = 16,
  }: { couplingRadius?: number; maxCoupledNodes?: number } = {},
): CoupledModel {
  const tied = (n: number) => tieRep.get(n) ?? n;
  const solidTets: number[] = [];
  for (let e = 0; e < m.tet.length / 4; e++)
    if (m.body[e] !== shells.shellBody)
      solidTets.push(
        m.tet[4 * e],
        m.tet[4 * e + 1],
        m.tet[4 * e + 2],
        m.tet[4 * e + 3],
      );

  const pool: number[] = [];
  const solidPool = new Map<number, number>();
  const addPool = (x: number, y: number, z: number) => {
    const id = pool.length / 3;
    pool.push(x, y, z);
    return id;
  };
  for (const n of new Set(solidTets.map(tied)))
    solidPool.set(n, addPool(...pt(m.V, n)));
  const shellPool: number[] = [];
  for (let s = 0; s < shells.shellVerts.length / 3; s++)
    shellPool.push(
      addPool(
        shells.shellVerts[3 * s],
        shells.shellVerts[3 * s + 1],
        shells.shellVerts[3 * s + 2],
      ),
    );

  const tets = solidTets.map((n) => solidPool.get(tied(n))!);
  const triangles = shells.shellTris.map((s) => shellPool[s]);
  const ppt = (i: number): [number, number, number] => [
    pool[3 * i],
    pool[3 * i + 1],
    pool[3 * i + 2],
  ];

  const R = couplingRadius;
  const grid = new Map<string, number[]>();
  const gk = (x: number, y: number, z: number) =>
    `${Math.floor(x / R)},${Math.floor(y / R)},${Math.floor(z / R)}`;
  for (const [, pi] of solidPool) {
    const p = ppt(pi);
    (grid.get(gk(...p)) ?? grid.set(gk(...p), []).get(gk(...p))!).push(pi);
  }
  const ref: number[] = [],
    offsets = [0],
    solid: number[] = [];
  for (const gi of shellPool) {
    const p = ppt(gi);
    const cx = Math.floor(p[0] / R),
      cy = Math.floor(p[1] / R),
      cz = Math.floor(p[2] / R);
    const near: { pi: number; d2: number }[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const b = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!b) continue;
          for (const pi of b) {
            const q = ppt(pi);
            const d2 =
              (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
            if (d2 <= R * R) near.push({ pi, d2 });
          }
        }
    if (near.length >= 3) {
      // Keep only the k NEAREST candidates: on a fine mesh a radius alone picks
      // hundreds of solid nodes per coupling, and the RBE3 master-slave
      // expansion is quadratic in that count — the reduction then dominates the
      // whole solve. ~16 well-spread nodes transmit force and moment just as
      // well, and bound the cost independently of mesh density.
      near.sort((a, b) => a.d2 - b.d2);
      ref.push(gi);
      for (const { pi } of near.slice(0, maxCoupledNodes)) solid.push(pi);
      offsets.push(solid.length);
    }
  }

  return {
    pool,
    tets,
    triangles,
    thicknesses: shells.shellThk,
    solidPool,
    shellPool,
    tied,
    coupling: { ref, offsets, solid },
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
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(pi);
  }
  return (p) => {
    const cx = Math.floor(p[0] / cell),
      cy = Math.floor(p[1] / cell),
      cz = Math.floor(p[2] / cell);
    let best = model.shellPool[0],
      bd = Infinity;
    for (let r = 0; r <= 6 && bd === Infinity; r++) {
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          for (let dz = -r; dz <= r; dz++) {
            if (
              r > 0 &&
              Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r
            )
              continue; // ring shell only
            const b = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!b) continue;
            for (const pi of b) {
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
    return best;
  };
}
