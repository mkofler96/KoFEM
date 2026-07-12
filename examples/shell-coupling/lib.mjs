// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Reusable helpers for the coupled solid+shell showcase: load the WASM engine,
// mesh a STEP part, turn its thin walls into a shell mid-surface, weld
// touching solid bodies, and build the coupled solve inputs. The heavy solving
// (MFEM solid + DKT shells + RBE3 coupling) lives in the engine's solve_coupled;
// this file is only geometry preparation.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PKG = join(here, "../../web/src/wasm/pkg");

/** Load the KoFEM WASM engine (meshing + coupled solve). */
export async function loadEngine({ log = false } = {}) {
  const wasmBinary = readFileSync(join(PKG, "kofem_wasm_emcc.wasm")).buffer;
  const { default: createModule } = await import(join(PKG, "kofem_wasm_emcc.js"));
  return createModule({
    wasmBinary,
    print: (l) => log && console.log("  " + l.trim()),
    printErr: () => {},
  });
}

/** Mesh a STEP file to a tetrahedral volume mesh (Netgen OCC). */
export function meshStep(Module, stepPath, { maxElementSize = 6 } = {}) {
  const bytes = new Uint8Array(readFileSync(stepPath));
  Module.tessellate_step(
    bytes,
    JSON.stringify({ deflection_relative: 0.001, angular_deflection: 0.5, format: "step" }),
  );
  const dto = Module.generate_fem_mesh(
    JSON.stringify({
      max_element_size: maxElementSize,
      min_element_size: maxElementSize / 10,
      grading: 0.3,
      second_order: false,
      elementsperedge: 2,
      elementspercurve: 2,
      optsteps_2d: 3,
      optsteps_3d: 3,
    }),
  );
  return {
    V: Array.from(dto.vertices),
    tet: Array.from(dto.tetrahedra),
    body: Array.from(dto.bodyIds),
    surfTri: dto.surfaceTriangles,
    surfFace: dto.surfaceFaceIds,
  };
}

const pt = (V, i) => [V[3 * i], V[3 * i + 1], V[3 * i + 2]];
const TET_FACES = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];

// Minimum vertex-to-opposite-face altitude / longest edge — a scale-invariant
// flatness measure (well-formed tet ≈ 0.3–0.8, thin-wall sliver < 0.1). Mirrors
// web/src/lib/shellize.ts.
function tetFlatness(V, a, b, c, d) {
  const p = [pt(V, a), pt(V, b), pt(V, c), pt(V, d)];
  let longest = 0;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const e = Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1], p[i][2] - p[j][2]);
    if (e > longest) longest = e;
  }
  let minAlt = Infinity;
  for (let k = 0; k < 4; k++) {
    const o = p[k], q = p[(k + 1) % 4], r = p[(k + 2) % 4], s = p[(k + 3) % 4];
    const ux = q[0] - r[0], uy = q[1] - r[1], uz = q[2] - r[2];
    const vx = s[0] - r[0], vy = s[1] - r[1], vz = s[2] - r[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const h = Math.abs((nx * (o[0] - r[0]) + ny * (o[1] - r[1]) + nz * (o[2] - r[2])) / nl);
    if (h < minAlt) minAlt = h;
  }
  return minAlt / (longest || 1);
}

/** Thin-wall (sliver) tets of the shelled body — the flat elements replaced by
 *  shells. The body's thick junction/base blocks stay solid so their stiffness
 *  and their contact with the neighbours survive. Mirrors shellize.ts. */
export function shellBodySliverTets(mesh, shellBody, { sliverFlatness = 0.2 } = {}) {
  const { V, tet, body } = mesh;
  const slivers = new Set();
  for (let e = 0; e < tet.length / 4; e++)
    if (body[e] === shellBody &&
        tetFlatness(V, tet[4 * e], tet[4 * e + 1], tet[4 * e + 2], tet[4 * e + 3]) < sliverFlatness)
      slivers.add(e);
  return slivers;
}

/** Drop distributing couplings whose reference node carries an essential BC — a
 *  fixed node cannot also be an RBE3 dependent (engine refuses, #377). Mirrors
 *  shellize.ts. */
export function dropCouplingsOnFixedNodes(coupling, fixedDofs) {
  const fixedNodes = new Set();
  for (const d of fixedDofs) fixedNodes.add(Math.floor(d / 6));
  const ref = [], offsets = [0], solid = [];
  for (let k = 0; k < coupling.ref.length; k++) {
    if (fixedNodes.has(coupling.ref[k])) continue;
    ref.push(coupling.ref[k]);
    for (let i = coupling.offsets[k]; i < coupling.offsets[k + 1]; i++) solid.push(coupling.solid[i]);
    offsets.push(solid.length);
  }
  return { ref, offsets, solid };
}

// Per-OCC-face area / area-weighted normal / centroid / owning body.
function faceProps(mesh) {
  const { V, tet, body, surfTri: st, surfFace: sf } = mesh;
  const faceBody = new Map();
  for (let e = 0; e < tet.length / 4; e++) {
    const p = [tet[4 * e], tet[4 * e + 1], tet[4 * e + 2], tet[4 * e + 3]];
    for (const f of TET_FACES) {
      const k = [p[f[0]], p[f[1]], p[f[2]]].sort((a, b) => a - b).join(",");
      faceBody.set(k, body[e]);
    }
  }
  const F = new Map();
  for (let t = 0; t < sf.length; t++) {
    const a = st[3 * t], b = st[3 * t + 1], c = st[3 * t + 2];
    const A = pt(V, a), B = pt(V, b), C = pt(V, c);
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
    const area = 0.5 * Math.hypot(nx, ny, nz);
    let f = F.get(sf[t]);
    if (!f) {
      f = { area: 0, nx: 0, ny: 0, nz: 0, cx: 0, cy: 0, cz: 0,
            body: faceBody.get([a, b, c].sort((x, y) => x - y).join(",")) };
      F.set(sf[t], f);
    }
    f.area += area; f.nx += nx / 2; f.ny += ny / 2; f.nz += nz / 2;
    f.cx += ((A[0] + B[0] + C[0]) / 3) * area;
    f.cy += ((A[1] + B[1] + C[1]) / 3) * area;
    f.cz += ((A[2] + B[2] + C[2]) / 3) * area;
  }
  return [...F.entries()].map(([id, f]) => {
    const nl = Math.hypot(f.nx, f.ny, f.nz) || 1;
    return { id, area: f.area, body: f.body, flat: nl / f.area,
             n: [f.nx / nl, f.ny / nl, f.nz / nl], c: [f.cx / f.area, f.cy / f.area, f.cz / f.area] };
  }).sort((a, b) => b.area - a.area);
}

/**
 * Detect thin walls (pairs of opposite planar CAD faces) and collapse each to a
 * mid-surface facet carrying the wall thickness. Walls meeting at a junction are
 * welded by node coincidence. Returns the shell mesh + each node's source CAD
 * face (used to map boundary conditions) and the body the walls belong to.
 */
export function extractThinWallShells(mesh, { maxWall = 15 } = {}) {
  const { V, surfTri: st, surfFace: sf } = mesh;
  const faces = faceProps(mesh);
  const big = faces.filter((f) => f.area > 0.01 * faces[0].area && f.flat > 0.9);
  const used = new Set();
  let walls = [];
  for (let i = 0; i < big.length; i++) {
    if (used.has(big[i].id)) continue;
    let best = -1, bo = Infinity;
    for (let j = 0; j < big.length; j++) {
      if (i === j || used.has(big[j].id) || big[i].body !== big[j].body) continue;
      const d = big[i].n[0] * big[j].n[0] + big[i].n[1] * big[j].n[1] + big[i].n[2] * big[j].n[2];
      if (d > -0.85) continue; // faces must be near-opposite
      // Wall thickness is the centroid offset ALONG the normal; the euclidean
      // distance also picks up lateral shift, and t³ bending stiffness makes
      // that inflation several-fold too stiff. Large lateral shift relative to
      // the face extent ⇒ the faces don't overlap ⇒ not a wall.
      const dc = [big[j].c[0] - big[i].c[0], big[j].c[1] - big[i].c[1], big[j].c[2] - big[i].c[2]];
      const along = Math.abs(big[i].n[0] * dc[0] + big[i].n[1] * dc[1] + big[i].n[2] * dc[2]);
      const lateral = Math.sqrt(Math.max(0, dc[0] ** 2 + dc[1] ** 2 + dc[2] ** 2 - along ** 2));
      const extent = Math.sqrt(Math.min(big[i].area, big[j].area));
      const ar = Math.abs(big[i].area - big[j].area) / Math.max(big[i].area, big[j].area);
      if (ar > 0.4 || along < 0.05 || along > maxWall || lateral > 0.35 * extent) continue;
      if (along < bo) { bo = along; best = j; }
    }
    if (best >= 0) {
      used.add(big[i].id); used.add(big[best].id);
      // keep the OUTER face (normal points away from its partner) so adjacent
      // walls share Netgen edge nodes at convex junctions for the weld below
      const fa = big[i], fb = big[best];
      const dcx = fa.c[0] - fb.c[0], dcy = fa.c[1] - fb.c[1], dcz = fa.c[2] - fb.c[2];
      const outer = fa.n[0] * dcx + fa.n[1] * dcy + fa.n[2] * dcz > 0 ? fa : fb;
      walls.push({ keep: outer.id, n: outer.n, thk: bo, body: fa.body });
    }
  }
  // Shell exactly ONE body — the one with the largest thin wall. detectWallPairs
  // can pair a thick flat block on another body; collapsing that would lay shell
  // facets on top of a body kept solid (the crane hook picked up a stray 5 mm
  // "wall" this way). Mirrors shellize.ts.
  const shellBody = walls.length ? walls[0].body : -1;
  if (shellBody >= 0) walls = walls.filter((w) => w.body === shellBody);
  const keep = new Map(walls.map((w) => [w.keep, w]));

  // Offset each kept face's triangulation inward by thk/2 to the mid-plane.
  const rawV = [], rawT = [], rawThk = [], rawSrc = [], rawOrig = [], nm = new Map();
  const addN = (fid, oi, p) => {
    const key = `${fid}:${oi}`;
    let id = nm.get(key);
    if (id !== undefined) return id;
    id = rawV.length / 3; nm.set(key, id); rawV.push(p[0], p[1], p[2]); rawSrc.push(fid); rawOrig.push(oi);
    return id;
  };
  for (let t = 0; t < sf.length; t++) {
    const w = keep.get(sf[t]);
    if (!w) continue;
    const o = w.thk / 2;
    const nn = [st[3 * t], st[3 * t + 1], st[3 * t + 2]].map((oi) => {
      const p = pt(V, oi);
      return addN(w.keep, oi, [p[0] - w.n[0] * o, p[1] - w.n[1] * o, p[2] - w.n[2] * o]);
    });
    rawT.push(nn[0], nn[1], nn[2]); rawThk.push(w.thk);
  }

  // Weld mid-surface nodes that came from the SAME original mesh node: adjacent
  // walls share Netgen's edge nodes along their CAD junction, so this fuses the
  // walls exactly and independent of mesh resolution (a spatial tolerance
  // over-welds a fine mesh — it collapsed the fine shell to two nodes — and
  // under-welds a coarse one). Mirrors web/src/lib/shellize.ts.
  const nR = rawV.length / 3, rep = new Int32Array(nR).map((_, i) => i);
  const find = (x) => { while (rep[x] !== x) { rep[x] = rep[rep[x]]; x = rep[x]; } return x; };
  const byOrig = new Map();
  for (let i = 0; i < nR; i++) (byOrig.get(rawOrig[i]) ?? byOrig.set(rawOrig[i], []).get(rawOrig[i])).push(i);
  for (const [, group] of byOrig)
    for (let k = 1; k < group.length; k++) {
      const a = find(group[0]), c = find(group[k]);
      if (a !== c) rep[Math.max(a, c)] = Math.min(a, c);
    }
  const comp = new Map(), shellVerts = [], shellSrc = [];
  const cid = (i) => {
    const r = find(i);
    let c = comp.get(r);
    if (c === undefined) { c = shellVerts.length / 3; comp.set(r, c); shellVerts.push(rawV[3 * r], rawV[3 * r + 1], rawV[3 * r + 2]); shellSrc.push(rawSrc[r]); }
    return c;
  };
  const shellTris = [], shellThk = [];
  for (let t = 0; t < rawT.length / 3; t++) {
    const a = cid(rawT[3 * t]), b = cid(rawT[3 * t + 1]), c = cid(rawT[3 * t + 2]);
    if (a === b || b === c || a === c) continue;
    shellTris.push(a, b, c); shellThk.push(rawThk[t]);
  }
  return { walls, shellBody, shellVerts, shellTris, shellThk, shellSrc };
}

/** Mutual-nearest weld of different-body solid nodes within tieDist (heals the
 *  near-hinge where two bodies touch without a shared face). Returns rep-map. */
export function tieSolidBodies(mesh, shellBody, { tieDist = 2.5, sliverTets } = {}) {
  const { V, tet, body } = mesh;
  const skip = (e) => (sliverTets ? sliverTets.has(e) : body[e] === shellBody);
  const bodiesOf = new Map();
  for (let e = 0; e < tet.length / 4; e++) {
    if (skip(e)) continue;
    for (let k = 0; k < 4; k++) (bodiesOf.get(tet[4 * e + k]) ?? bodiesOf.set(tet[4 * e + k], new Set()).get(tet[4 * e + k])).add(body[e]);
  }
  const nodes = [...bodiesOf.keys()];
  const grid = new Map(), gk = (x, y, z) => `${Math.floor(x / tieDist)},${Math.floor(y / tieDist)},${Math.floor(z / tieDist)}`;
  for (const n of nodes) (grid.get(gk(...pt(V, n))) ?? grid.set(gk(...pt(V, n)), []).get(gk(...pt(V, n)))).push(n);
  const nearest = new Map();
  for (const n of nodes) {
    const p = pt(V, n);
    const cx = Math.floor(p[0] / tieDist), cy = Math.floor(p[1] / tieDist), cz = Math.floor(p[2] / tieDist);
    let bn = -1, bd = tieDist * tieDist;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const b = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!b) continue;
      for (const m of b) {
        if (m === n) continue;
        let same = false; for (const x of bodiesOf.get(n)) if (bodiesOf.get(m).has(x)) same = true;
        if (same) continue;
        const q = pt(V, m), dd = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (dd < bd) { bd = dd; bn = m; }
      }
    }
    nearest.set(n, bn);
  }
  const rep = new Map();
  let welded = 0;
  for (const n of nodes) { const m = nearest.get(n); if (m >= 0 && nearest.get(m) === n && n < m) { rep.set(m, n); welded++; } }
  return { rep, welded };
}

/**
 * Assemble the coupled node pool: compacted solid nodes (bodies != shellBody,
 * tied) followed by the shell mid-surface nodes. Builds solve_coupled inputs and
 * auto-detects distributing couplings (each shell node near ≥3 solid nodes).
 */
export function buildCoupledModel(mesh, shells, tie, sliverTets, { couplingRadius = 10 } = {}) {
  const { V, tet, body } = mesh;
  const tied = (n) => tie.rep.get(n) ?? n;
  // Solid = other bodies + the shelled body's non-wall (base) tets; only the thin
  // walls become shells, so the base block is not dropped. Mirrors shellize.ts.
  const solidTets = [];
  for (let e = 0; e < tet.length / 4; e++)
    if (!(body[e] === shells.shellBody && sliverTets.has(e))) solidTets.push(tet[4 * e], tet[4 * e + 1], tet[4 * e + 2], tet[4 * e + 3]);

  const pool = [];
  const solidPool = new Map();
  const addPool = (x, y, z) => { const id = pool.length / 3; pool.push(x, y, z); return id; };
  for (const n of new Set(solidTets.map(tied))) solidPool.set(n, addPool(...pt(V, n)));
  const shellPool = [];
  for (let s = 0; s < shells.shellVerts.length / 3; s++)
    shellPool.push(addPool(shells.shellVerts[3 * s], shells.shellVerts[3 * s + 1], shells.shellVerts[3 * s + 2]));

  const tets = solidTets.map((n) => solidPool.get(tied(n)));
  const triangles = shells.shellTris.map((s) => shellPool[s]);
  const ppt = (i) => [pool[3 * i], pool[3 * i + 1], pool[3 * i + 2]];

  // auto-couple: each shell node near ≥3 solid nodes → one distributing coupling.
  // Capped at the 16 NEAREST candidates: the RBE3 expansion is quadratic in the
  // per-coupling node count, and a radius alone picks hundreds on a fine mesh.
  const R = couplingRadius, MAX_COUPLED = 16;
  const grid = new Map(), gk = (x, y, z) => `${Math.floor(x / R)},${Math.floor(y / R)},${Math.floor(z / R)}`;
  for (const [, pi] of solidPool) (grid.get(gk(...ppt(pi))) ?? grid.set(gk(...ppt(pi)), []).get(gk(...ppt(pi)))).push(pi);
  const ref = [], offsets = [0], solid = [];
  for (const gi of shellPool) {
    const p = ppt(gi);
    const cx = Math.floor(p[0] / R), cy = Math.floor(p[1] / R), cz = Math.floor(p[2] / R);
    const near = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const b = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!b) continue;
      for (const pi of b) {
        const q = ppt(pi);
        const d2 = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (d2 <= R * R) near.push({ pi, d2 });
      }
    }
    if (near.length >= 3) {
      near.sort((a, b) => a.d2 - b.d2);
      ref.push(gi);
      for (const { pi } of near.slice(0, MAX_COUPLED)) solid.push(pi);
      offsets.push(solid.length);
    }
  }

  return {
    pool, tets, triangles, thicknesses: shells.shellThk,
    solidPool, shellPool, tied,
    coupling: { ref, offsets, solid },
  };
}
