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
export function extractThinWallShells(mesh, { maxWall = 15, weldTol = 3 } = {}) {
  const { V, surfTri: st, surfFace: sf } = mesh;
  const faces = faceProps(mesh);
  const big = faces.filter((f) => f.area > 0.01 * faces[0].area && f.flat > 0.9);
  const used = new Set(), walls = [];
  for (let i = 0; i < big.length; i++) {
    if (used.has(big[i].id)) continue;
    let best = -1, bo = Infinity;
    for (let j = 0; j < big.length; j++) {
      if (i === j || used.has(big[j].id) || big[i].body !== big[j].body) continue;
      const d = big[i].n[0] * big[j].n[0] + big[i].n[1] * big[j].n[1] + big[i].n[2] * big[j].n[2];
      if (d > -0.85) continue; // faces must be near-opposite
      const off = Math.hypot(big[i].c[0] - big[j].c[0], big[i].c[1] - big[j].c[1], big[i].c[2] - big[j].c[2]);
      const ar = Math.abs(big[i].area - big[j].area) / Math.max(big[i].area, big[j].area);
      if (ar > 0.4 || off > maxWall) continue; // similar area, plausible wall gap
      if (off < bo) { bo = off; best = j; }
    }
    if (best >= 0) {
      used.add(big[i].id); used.add(big[best].id);
      walls.push({ keep: big[i].id, n: big[i].n, thk: bo, body: big[i].body });
    }
  }
  const shellBody = walls.length ? walls[0].body : -1;
  const keep = new Map(walls.map((w) => [w.keep, w]));

  // Offset each kept face's triangulation inward by thk/2 to the mid-plane.
  const rawV = [], rawT = [], rawThk = [], rawSrc = [], nm = new Map();
  const addN = (fid, oi, p) => {
    const key = `${fid}:${oi}`;
    let id = nm.get(key);
    if (id !== undefined) return id;
    id = rawV.length / 3; nm.set(key, id); rawV.push(p[0], p[1], p[2]); rawSrc.push(fid);
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

  // Weld coincident mid-surface nodes across walls (junctions).
  const nR = rawV.length / 3, rep = new Int32Array(nR).map((_, i) => i);
  const find = (x) => { while (rep[x] !== x) { rep[x] = rep[rep[x]]; x = rep[x]; } return x; };
  const grid = new Map(), gk = (x, y, z) => `${Math.round(x / weldTol)},${Math.round(y / weldTol)},${Math.round(z / weldTol)}`;
  for (let i = 0; i < nR; i++) {
    const p = [rawV[3 * i], rawV[3 * i + 1], rawV[3 * i + 2]];
    const cx = Math.round(p[0] / weldTol), cy = Math.round(p[1] / weldTol), cz = Math.round(p[2] / weldTol);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const b = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!b) continue;
      for (const j of b) {
        const q = [rawV[3 * j], rawV[3 * j + 1], rawV[3 * j + 2]];
        if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= weldTol) {
          const a = find(i), c = find(j); if (a !== c) rep[Math.max(a, c)] = Math.min(a, c);
        }
      }
    }
    (grid.get(gk(...p)) ?? grid.set(gk(...p), []).get(gk(...p))).push(i);
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
export function tieSolidBodies(mesh, shellBody, { tieDist = 2.5 } = {}) {
  const { V, tet, body } = mesh;
  const bodiesOf = new Map();
  for (let e = 0; e < tet.length / 4; e++) {
    if (body[e] === shellBody) continue;
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
export function buildCoupledModel(mesh, shells, tie, { couplingRadius = 10 } = {}) {
  const { V, tet, body } = mesh;
  const tied = (n) => tie.rep.get(n) ?? n;
  const solidTets = [];
  for (let e = 0; e < tet.length / 4; e++)
    if (body[e] !== shells.shellBody) solidTets.push(tet[4 * e], tet[4 * e + 1], tet[4 * e + 2], tet[4 * e + 3]);

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
