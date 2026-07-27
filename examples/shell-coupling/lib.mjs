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

// Squared distance from a point to a triangle (Ericson, Real-Time Collision
// Detection §5.1.5). Mirrors web/src/lib/shellize.ts.
function pointTriDist2(p, a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const at = (s, t) => {
    const q = [a[0] + s * ab[0] + t * ac[0], a[1] + s * ab[1] + t * ac[1], a[2] + s * ab[2] + t * ac[2]];
    return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  };
  if (d1 <= 0 && d2 <= 0) return at(0, 0);
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at(1 - w, w);
  }
  const denom = 1 / (va + vb + vc);
  return at(vb * denom, vc * denom);
}

/** Tets of the shelled body that the shell facets replace: those inside a
 *  detected wall, i.e. whose centroid lies within half that wall's thickness of
 *  its mid-surface. The body's thick junction/base blocks are farther away and
 *  stay solid, so their stiffness and their contact with the neighbours survive.
 *  Mirrors shellize.ts. */
export function shellWallTets(mesh, shells, { margin = 1.0 } = {}) {
  const { V, tet, body } = mesh;
  const wallTets = new Set();
  const nFacets = shells.shellTris.length / 3;
  if (nFacets === 0) return wallTets;
  const sv = shells.shellVerts;
  const facetPt = (t, k) => {
    const i = shells.shellTris[3 * t + k];
    return [sv[3 * i], sv[3 * i + 1], sv[3 * i + 2]];
  };
  let maxThk = 0, sumExtent = 0;
  for (let t = 0; t < nFacets; t++) {
    if (shells.shellThk[t] > maxThk) maxThk = shells.shellThk[t];
    const a = facetPt(t, 0), b = facetPt(t, 1), c = facetPt(t, 2);
    sumExtent += Math.max(
      Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
      Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]),
      Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]),
    );
  }
  const cell = Math.max(maxThk * margin, sumExtent / nFacets, 1e-9);
  const grid = new Map();
  const push = (k, t) => {
    const arr = grid.get(k);
    if (arr) arr.push(t); else grid.set(k, [t]);
  };
  for (let t = 0; t < nFacets; t++) {
    const p = [facetPt(t, 0), facetPt(t, 1), facetPt(t, 2)];
    const lo = [0, 1, 2].map((d) => Math.floor(Math.min(p[0][d], p[1][d], p[2][d]) / cell));
    const hi = [0, 1, 2].map((d) => Math.floor(Math.max(p[0][d], p[1][d], p[2][d]) / cell));
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) push(`${x},${y},${z}`, t);
  }
  for (let e = 0; e < tet.length / 4; e++) {
    if (body[e] !== shells.shellBody) continue;
    const c = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const p = pt(V, tet[4 * e + k]);
      c[0] += p[0] / 4; c[1] += p[1] / 4; c[2] += p[2] / 4;
    }
    const cx = Math.floor(c[0] / cell), cy = Math.floor(c[1] / cell), cz = Math.floor(c[2] / cell);
    let inside = false;
    for (let dx = -1; dx <= 1 && !inside; dx++)
      for (let dy = -1; dy <= 1 && !inside; dy++)
        for (let dz = -1; dz <= 1 && !inside; dz++) {
          const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const t of bucket) {
            const reach = 0.5 * shells.shellThk[t] * margin;
            if (pointTriDist2(c, facetPt(t, 0), facetPt(t, 1), facetPt(t, 2)) <= reach * reach) {
              inside = true;
              break;
            }
          }
        }
    if (inside) wallTets.add(e);
  }
  return wallTets;
}

/** Drop distributing couplings whose reference node carries an essential BC — a
 *  fixed node cannot also be an RBE3 dependent (engine refuses, #377). Mirrors
 *  shellize.ts. */
export function dropCouplingsOnFixedNodes(coupling, fixedDofs) {
  const fixedNodes = new Set();
  for (const d of fixedDofs) fixedNodes.add(Math.floor(d / 6));
  const ref = [], offsets = [0], solid = [], mpc = [];
  for (let k = 0; k < coupling.ref.length; k++) {
    if (fixedNodes.has(coupling.ref[k])) continue;
    ref.push(coupling.ref[k]);
    for (let i = coupling.offsets[k]; i < coupling.offsets[k + 1]; i++) solid.push(coupling.solid[i]);
    offsets.push(solid.length);
    mpc.push(coupling.mpc?.[k] ?? 0);
  }
  return { ref, offsets, solid, mpc };
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

/** Boundary of a tet mesh: faces used by exactly one element, flat 3*nTris.
 *  Mirrors shellize.ts. */
function tetMeshBoundary(tets) {
  const seen = new Map();
  for (let e = 0; e < tets.length / 4; e++)
    for (const f of TET_FACES) {
      const tri = [tets[4 * e + f[0]], tets[4 * e + f[1]], tets[4 * e + f[2]]];
      const k = [...tri].sort((a, b) => a - b).join(",");
      const entry = seen.get(k);
      if (entry) entry.count++; else seen.set(k, { tri, count: 1 });
    }
  const out = [];
  for (const { tri, count } of seen.values()) if (count === 1) out.push(tri[0], tri[1], tri[2]);
  return out;
}

/** Shell mid-surface nodes lying ON the retained solid's boundary — the seam
 *  where an idealised wall meets material that stayed solid, and the only nodes
 *  the shell<->solid tie references. A fixed-radius ball of shell nodes instead
 *  clamped whole millimetres of thin wall to the solid. Mirrors shellize.ts. */
function seamShellNodes(ppt, shellPoolIndices, solidBoundary, tolerance) {
  const nTris = solidBoundary.length / 3;
  if (nTris === 0 || tolerance <= 0) return [];
  const corner = (t, k) => ppt(solidBoundary[3 * t + k]);
  let sumExtent = 0;
  for (let t = 0; t < nTris; t++) {
    const a = corner(t, 0), b = corner(t, 1), c = corner(t, 2);
    sumExtent += Math.max(
      Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
      Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]),
      Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]),
    );
  }
  const cell = Math.max(tolerance, sumExtent / nTris, 1e-9);
  const grid = new Map();
  const push = (k, t) => { const arr = grid.get(k); if (arr) arr.push(t); else grid.set(k, [t]); };
  for (let t = 0; t < nTris; t++) {
    const p = [corner(t, 0), corner(t, 1), corner(t, 2)];
    const lo = [0, 1, 2].map((d) => Math.floor(Math.min(p[0][d], p[1][d], p[2][d]) / cell));
    const hi = [0, 1, 2].map((d) => Math.floor(Math.max(p[0][d], p[1][d], p[2][d]) / cell));
    for (let x = lo[0]; x <= hi[0]; x++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let z = lo[2]; z <= hi[2]; z++) push(`${x},${y},${z}`, t);
  }
  const out = [];
  for (const pi of shellPoolIndices) {
    const q = ppt(pi);
    const c = [0, 1, 2].map((d) => Math.floor(q[d] / cell));
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++)
      for (let dy = -1; dy <= 1 && !hit; dy++)
        for (let dz = -1; dz <= 1 && !hit; dz++) {
          const bucket = grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`);
          if (!bucket) continue;
          for (const t of bucket)
            if (pointTriDist2(q, corner(t, 0), corner(t, 1), corner(t, 2)) <= tolerance * tolerance) { hit = true; break; }
        }
    if (hit) out.push(pi);
  }
  return out;
}

/** Median tet edge — the solid mesh's own length scale, from which both coupling
 *  distances are derived so neither is a fixed length. Mirrors shellize.ts. */
function medianTetEdge(ppt, tets) {
  const edges = [];
  for (let e = 0; e < tets.length / 4; e++) {
    const n = [0, 1, 2, 3].map((k) => ppt(tets[4 * e + k]));
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++)
        edges.push(Math.hypot(n[i][0] - n[j][0], n[i][1] - n[j][1], n[i][2] - n[j][2]));
  }
  if (edges.length === 0) return 0;
  edges.sort((a, b) => a - b);
  return edges[Math.floor(edges.length / 2)];
}

/** Seam tolerance: one wall thickness, or half an element — a discretised seam is
 *  only located to within the local element size. Shrinks under refinement, so
 *  the tied band is mesh-convergent. Mirrors shellize.ts. */
function seamTolerance(maxWallThickness, medEdge) {
  return Math.max(maxWallThickness, 0.5 * medEdge);
}

/** How far a seam node may reach for its solid partners: at least one solid
 *  element, so a coarse mesh still yields the 3 partners an RBE3 needs.
 *  Mirrors shellize.ts. */
function partnerSearchRadius(medEdge, floor) {
  return Math.max(2 * medEdge, floor, 1e-9);
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
  const rawV = [], rawT = [], rawThk = [], rawTriSrc = [], rawSrc = [], rawOrig = [], nm = new Map();
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
    rawT.push(nn[0], nn[1], nn[2]); rawThk.push(w.thk); rawTriSrc.push(w.keep);
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
  const shellTris = [], shellThk = [], shellTriSrc = [];
  for (let t = 0; t < rawT.length / 3; t++) {
    const a = cid(rawT[3 * t]), b = cid(rawT[3 * t + 1]), c = cid(rawT[3 * t + 2]);
    if (a === b || b === c || a === c) continue;
    shellTris.push(a, b, c); shellThk.push(rawThk[t]); shellTriSrc.push(rawTriSrc[t]);
  }
  return { walls, shellBody, shellVerts, shellTris, shellThk, shellSrc, shellTriSrc };
}

/** Pick ≤ budget of the candidates found in the search ball, keeping the patch
 *  WIDE: nearest first, then repeatedly the one farthest from those already
 *  chosen. Taking the nearest `budget` instead lets the patch shrink with the
 *  element size while the reference stays put, driving the RBE3 inertia H towards
 *  its singular limit under refinement. Mirrors shellize.ts. */
function spreadPatch(candidates, budget, ppt) {
  if (candidates.length <= budget) return candidates.map((c) => c.pi);
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const chosen = [candidates.reduce((a, b) => (a.d2 <= b.d2 ? a : b)).pi];
  const rest = candidates.filter((c) => c.pi !== chosen[0]).map((c) => c.pi);
  const sep = rest.map((pi) => d2(ppt(pi), ppt(chosen[0])));
  while (chosen.length < budget) {
    let best = -1;
    for (let i = 0; i < rest.length; i++) if (sep[i] > (best < 0 ? -1 : sep[best])) best = i;
    if (best < 0) break;
    const picked = rest[best];
    chosen.push(picked);
    sep[best] = -1;
    for (let i = 0; i < rest.length; i++)
      if (sep[i] >= 0) sep[i] = Math.min(sep[i], d2(ppt(rest[i]), ppt(picked)));
  }
  return chosen;
}

// Distributing (RBE3) couplings: each ref node near ≥3 target nodes ties to
// ≤ maxCoupled of them, chosen for spread. CSR-style. Mirrors shellize.ts.
function autoDetectCouplings(ppt, targetNodes, refNodes, R, maxCoupled = 16) {
  const grid = new Map(), gk = (x, y, z) => `${Math.floor(x / R)},${Math.floor(y / R)},${Math.floor(z / R)}`;
  for (const pi of targetNodes) (grid.get(gk(...ppt(pi))) ?? grid.set(gk(...ppt(pi)), []).get(gk(...ppt(pi)))).push(pi);
  const ref = [], offsets = [0], solid = [];
  for (const gi of refNodes) {
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
      ref.push(gi);
      for (const pi of spreadPatch(near, maxCoupled, ppt)) solid.push(pi);
      offsets.push(solid.length);
    }
  }
  return { ref, offsets, solid };
}

/** Distance from each node to a triangle soup, for the nodes within reach of it.
 *  The 27-cell scan only sees triangles within one cell, so a distance is reported
 *  exactly when it is ≤ cell — and the cell doubles until the surface is found,
 *  since the clearance of a fit is a property of the CAD. Mirrors shellize.ts. */
function distancesToSurface(ppt, nodes, surface, startCell, maxDoublings) {
  const nTris = surface.length / 3;
  const out = new Map();
  if (nTris === 0 || nodes.length === 0) return out;
  const corner = (t, k) => ppt(surface[3 * t + k]);
  for (let d = 0, cell = startCell; d <= maxDoublings; d++, cell *= 2) {
    const grid = new Map();
    const push = (k, t) => { const arr = grid.get(k); if (arr) arr.push(t); else grid.set(k, [t]); };
    for (let t = 0; t < nTris; t++) {
      const p = [corner(t, 0), corner(t, 1), corner(t, 2)];
      const lo = [0, 1, 2].map((c) => Math.floor(Math.min(p[0][c], p[1][c], p[2][c]) / cell));
      const hi = [0, 1, 2].map((c) => Math.floor(Math.max(p[0][c], p[1][c], p[2][c]) / cell));
      for (let x = lo[0]; x <= hi[0]; x++)
        for (let y = lo[1]; y <= hi[1]; y++)
          for (let z = lo[2]; z <= hi[2]; z++) push(`${x},${y},${z}`, t);
    }
    out.clear();
    for (const pi of nodes) {
      const q = ppt(pi);
      const c = [0, 1, 2].map((k) => Math.floor(q[k] / cell));
      let best = Infinity;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`);
            if (!bucket) continue;
            for (const t of bucket) {
              const dd = pointTriDist2(q, corner(t, 0), corner(t, 1), corner(t, 2));
              if (dd < best) best = dd;
            }
          }
      if (best <= cell * cell) out.set(pi, Math.sqrt(best));
    }
    if (out.size > 0) return out;
  }
  return out;
}

// Distributing tie of a gapped solid↔solid interface (a pin in a hole), split by
// BODY LABEL (Netgen can mesh the bodies nearly conformally, so a few shared
// interface nodes make them one connected component yet leave the pin a near-hinge
// — connectivity can't separate them, the body label can). The body with the most
// exclusive nodes is the master; the INTERFACE nodes of every other body — those
// within the measured clearance, plus half an element, of the master body's
// boundary surface — distribute onto master nodes. A fixed-radius ball instead
// slaves a constant-VOLUME band, so the eliminated set grows without bound under
// refinement and ties material far from the interface. Shared (multi-body) nodes
// are already joined and skipped. Mirrors shellize.ts.
function autoDetectSolidCouplings(ppt, poolBody, tets, tetBody, medEdge, maxCoupled = 16) {
  const bodyOfNode = new Map(), bodyCount = new Map();
  for (const [pi, bodies] of poolBody) {
    if (bodies.size !== 1) continue;
    const b = [...bodies][0];
    bodyOfNode.set(pi, b);
    bodyCount.set(b, (bodyCount.get(b) ?? 0) + 1);
  }
  if (bodyCount.size < 2) return { ref: [], offsets: [0], solid: [] };
  let master = -1, best = -1;
  for (const [b, c] of bodyCount) if (c > best) { best = c; master = b; }
  const masterNodes = [], otherNodes = new Map();
  for (const [pi, b] of bodyOfNode)
    if (b === master) masterNodes.push(pi);
    else { const arr = otherNodes.get(b); if (arr) arr.push(pi); else otherNodes.set(b, [pi]); }

  const masterTets = [];
  for (let t = 0; t < tetBody.length; t++)
    if (tetBody[t] === master)
      masterTets.push(tets[4 * t], tets[4 * t + 1], tets[4 * t + 2], tets[4 * t + 3]);
  const masterBoundary = tetMeshBoundary(masterTets);

  let all = { ref: [], offsets: [0], solid: [] };
  for (const nodes of otherNodes.values()) {
    const dist = distancesToSurface(ppt, nodes, masterBoundary, Math.max(2 * medEdge, 1e-9), 6);
    if (dist.size === 0) continue;
    const gap = Math.min(...dist.values());
    const refs = [...dist].filter(([, d]) => d <= gap + 0.5 * medEdge).map(([pi]) => pi);
    all = concatCouplings(all, autoDetectCouplings(
      ppt, masterNodes, refs, partnerSearchRadius(medEdge, gap), maxCoupled));
  }
  return { ref: all.ref, offsets: all.offsets, solid: all.solid };
}

// Concatenate two CSR coupling sets, preserving each set's per-reference MPC
// flags (missing => distributing). Mirrors shellize.ts.
function concatCouplings(a, b) {
  const ref = [...a.ref, ...b.ref], solid = [...a.solid, ...b.solid], offsets = [...a.offsets];
  const base = a.solid.length;
  for (let k = 1; k < b.offsets.length; k++) offsets.push(base + b.offsets[k]);
  const mpc = [...(a.mpc ?? a.ref.map(() => 0)), ...(b.mpc ?? b.ref.map(() => 0))];
  return { ref, offsets, solid, mpc };
}

/**
 * Assemble the coupled node pool: solid nodes (other bodies + the shelled body's
 * non-wall base tets) followed by the shell mid-surface nodes. Distinct solid
 * bodies keep their own nodes (no merging) and are tied by distributing couplings
 * across any clearance; shells couple to the solid the same way. Mirrors
 * shellize.ts.
 */
export function buildCoupledModel(mesh, shells, wallTets, { seamTolerance: seamToleranceOverride, couplingRadius } = {}) {
  const { V, tet, body } = mesh;
  const solidTets = [], tetBody = [];
  for (let e = 0; e < tet.length / 4; e++)
    if (!(body[e] === shells.shellBody && wallTets.has(e))) { solidTets.push(tet[4 * e], tet[4 * e + 1], tet[4 * e + 2], tet[4 * e + 3]); tetBody.push(body[e]); }

  const pool = [];
  const solidPool = new Map();
  const addPool = (x, y, z) => { const id = pool.length / 3; pool.push(x, y, z); return id; };
  for (const n of new Set(solidTets)) solidPool.set(n, addPool(...pt(V, n)));
  const shellPool = [];
  for (let s = 0; s < shells.shellVerts.length / 3; s++)
    shellPool.push(addPool(shells.shellVerts[3 * s], shells.shellVerts[3 * s + 1], shells.shellVerts[3 * s + 2]));

  const tets = solidTets.map((n) => solidPool.get(n));
  const triangles = shells.shellTris.map((s) => shellPool[s]);
  const ppt = (i) => [pool[3 * i], pool[3 * i + 1], pool[3 * i + 2]];

  // body of each solid pool node (a conformal interface node carries >1 body)
  const poolBody = new Map();
  for (let t = 0; t < tets.length / 4; t++)
    for (let k = 0; k < 4; k++) (poolBody.get(tets[4 * t + k]) ?? poolBody.set(tets[4 * t + k], new Set()).get(tets[4 * t + k])).add(tetBody[t]);

  // Every coupling distance below comes from the model's own scales, not a fixed
  // number of millimetres.
  const medEdge = medianTetEdge(ppt, tets);
  const solidCoupling = autoDetectSolidCouplings(ppt, poolBody, tets, tetBody, medEdge);
  const solidRefs = new Set(solidCoupling.ref);
  // Tie only the shell nodes sitting on the retained solid, each reaching as far
  // as the solid mesh's own spacing for its partners.
  const tolerance = seamToleranceOverride
    ?? seamTolerance(shells.shellThk.length > 0 ? Math.max(...shells.shellThk) : 0, medEdge);
  const seam = seamShellNodes(ppt, shellPool, tetMeshBoundary(tets), tolerance);
  const shellCoupling = autoDetectCouplings(
    ppt, [...solidPool.values()].filter((pi) => !solidRefs.has(pi)), seam,
    couplingRadius ?? partnerSearchRadius(medEdge, tolerance));

  return {
    pool, tets, tetBody, triangles, thicknesses: shells.shellThk,
    solidPool, shellPool,
    // Shell<->solid seam is continuous material => relaxed MPC (displacement
    // continuity); the gapped pin<->hole tie stays distributing. Mirrors shellize.ts.
    coupling: concatCouplings(
      { ...shellCoupling, mpc: shellCoupling.ref.map(() => 1) },
      { ...solidCoupling, mpc: solidCoupling.ref.map(() => 0) },
    ),
  };
}
