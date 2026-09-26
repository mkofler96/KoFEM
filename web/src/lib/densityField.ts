// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Topology-optimization density result → viewport geometry (KOF-233). The
// optimizer returns one density ∈ [0, 1] per element in solve/element order;
// this module maps those back onto the mesh, applies the visibility threshold,
// and extracts the boundary surface of the retained (kept) material so the user
// sees the emerged structure rather than a fuzzy volumetric gradient.

import * as THREE from "three";
import type { Element, Node } from "../store/modelStore";

// Grayscale density ramp: low density → light, full density (1) → near-black.
// A neutral gray map (rather than the blue→red result ramp) keeps the reading
// on the emerged shape's silhouette; a solid element looks solid, the fuzzy
// intermediate-density band around the threshold reads as lighter gray.
export function densityColor(t: number): THREE.Color {
  const clamped = Math.min(1, Math.max(0, t));
  // Lightness 0.88 (t=0) → 0.16 (t=1): dark = dense.
  const lightness = 0.88 - 0.72 * clamped;
  return new THREE.Color().setHSL(0, 0, lightness);
}

// The design elements in the exact order the optimizer returns one density per
// element, so density[i] belongs to orderedDesignElements(elements)[i]. That
// order is: solid tets, then hexes, then shell facets (KOF-237) — matching how
// the solid entry packs its mesh (CTETRA then CHEXA), the coupled entry its
// design domain (tets then facets), and the pure-shell entry (facets only). A
// coupled model carries no hexes and a solid model no facets, so the single
// concatenation covers all three domains.
export function orderedDesignElements(elements: Element[]): Element[] {
  const tets = elements.filter((e) => e.type === "CTETRA");
  const hexes = elements.filter((e) => e.type === "CHEXA");
  const shells = elements.filter((e) => e.type === "CTRIA3");
  return [...tets, ...hexes, ...shells];
}

// Number of elements kept at a given threshold — the count the viewport draws.
// Shared with the Results panel's readout so the two never disagree.
export function visibleElementCount(
  density: Float64Array,
  threshold: number,
): number {
  let n = 0;
  for (const value of density) if (value >= threshold) n++;
  return n;
}

// Triangular faces of a CTETRA (local node indices), outward-oriented.
const TET_FACES: [number, number, number][] = [
  [0, 2, 1],
  [0, 1, 3],
  [1, 2, 3],
  [2, 0, 3],
];

// Quad faces of a CHEXA (local node indices), each split into two triangles.
const HEX_FACES: [number, number, number, number][] = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [3, 7, 6, 2],
  [0, 4, 7, 3],
  [1, 2, 6, 5],
];

export interface DensitySurface {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  triangleCount: number;
}

interface Face {
  ids: number[]; // node ids, outward-oriented
  color: THREE.Color;
}

// Boundary surface of the retained element set. A face shared by two kept
// elements is interior (drawn from neither); a face kept by exactly one element
// is on the surface of the emerging structure and is drawn, flat-shaded in the
// owning element's density colour. Returns null when there is nothing to draw
// (empty mesh, or every element below the threshold) or when the density is
// stale — its length no longer matches the mesh (e.g. a re-mesh after the run),
// mirroring the guard the displacement colormap uses.
export function buildDensitySurface(
  nodes: Node[],
  elements: Element[],
  density: Float64Array,
  threshold: number,
): DensitySurface | null {
  const ordered = orderedDesignElements(elements);
  if (density.length !== ordered.length || ordered.length === 0) return null;

  const nodeMap = new Map<number, Node>(nodes.map((n) => [n.id, n]));

  // Collect every face of every kept element, keyed by its sorted node ids, and
  // count how many kept elements share it. Interior faces appear twice.
  const faceMap = new Map<string, { face: Face; count: number }>();
  const addFace = (ids: number[], color: THREE.Color) => {
    const key = [...ids].sort((a, b) => a - b).join(",");
    const entry = faceMap.get(key);
    if (entry) entry.count++;
    else faceMap.set(key, { face: { ids, color }, count: 1 });
  };

  // Shell facets are themselves surfaces (not the boundary of a volume), so they
  // are drawn directly rather than run through the shared-face dedup that finds a
  // solid body's boundary — a kept CTRIA3 always shows its triangle.
  const shellFaces: Face[] = [];

  for (let i = 0; i < ordered.length; i++) {
    if (density[i] < threshold) continue;
    const el = ordered[i];
    const color = densityColor(density[i]);
    if (el.type === "CTETRA") {
      for (const [a, b, c] of TET_FACES)
        addFace([el.nodeIds[a], el.nodeIds[b], el.nodeIds[c]], color);
    } else if (el.type === "CHEXA") {
      for (const [a, b, c, d] of HEX_FACES)
        addFace(
          [el.nodeIds[a], el.nodeIds[b], el.nodeIds[c], el.nodeIds[d]],
          color,
        );
    } else if (el.type === "CTRIA3") {
      shellFaces.push({
        ids: [el.nodeIds[0], el.nodeIds[1], el.nodeIds[2]],
        color,
      });
    }
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];

  const pushTri = (a: Node, b: Node, c: Node, color: THREE.Color) => {
    const ab = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
    const ac = new THREE.Vector3(c.x - a.x, c.y - a.y, c.z - a.z);
    const nrm = ab.cross(ac).normalize();
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let k = 0; k < 3; k++) normals.push(nrm.x, nrm.y, nrm.z);
    for (let k = 0; k < 3; k++) colors.push(color.r, color.g, color.b);
  };

  for (const { face, count } of faceMap.values()) {
    if (count !== 1) continue; // interior face — not part of the surface
    const pts = face.ids.map((id) => nodeMap.get(id));
    if (pts.some((p) => p === undefined)) continue;
    const [a, b, c, d] = pts as Node[];
    pushTri(a, b, c, face.color);
    if (face.ids.length === 4) pushTri(a, c, d, face.color);
  }
  // Shell facets: each kept CTRIA3 draws its own triangle, flat-shaded.
  for (const face of shellFaces) {
    const pts = face.ids.map((id) => nodeMap.get(id));
    if (pts.some((p) => p === undefined)) continue;
    const [a, b, c] = pts as Node[];
    pushTri(a, b, c, face.color);
  }

  if (positions.length === 0) return null;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    triangleCount: positions.length / 9,
  };
}

// ── Smooth boundary (isosurface) ──────────────────────────────────────────────
//
// The element-wise view above draws exactly what the optimizer analysed, which
// makes a curved member a staircase of element faces. The smooth view instead
// treats the result as a continuous NODAL field f and draws the boundary of the
// region {f ≥ level}: inside the solid, the isosurface f = level (marching
// tetrahedra — linear interpolation along each tet edge, so the surface is exact
// for the linear field the mesh carries); on the outer boundary of the design
// domain, the part of each boundary face with f ≥ level (a cap, so the body is
// closed). Shell facets are clipped the same way, as surfaces.
//
// For SIMP the nodal field is the volume-weighted average of the adjacent
// element densities (nodalDensity); for the level-set method it is the engine's
// own φ, mapped to (φ + 1)/2 so its boundary φ = 0 sits at the default 0.5
// threshold (levelSetField).

// Colour of the smooth surface: one solid tone — the lighting carries the shape.
const SMOOTH_COLOR = densityColor(0.8);

// Kuhn split of a hexahedron into six tets around its 0–6 diagonal (CHEXA node
// order), the same split the engine's level-set volume fractions use.
const HEX_KUHN_TETS: [number, number, number, number][] = [
  [0, 1, 2, 6],
  [0, 1, 5, 6],
  [0, 4, 5, 6],
  [0, 4, 7, 6],
  [0, 3, 7, 6],
  [0, 3, 2, 6],
];

interface P3 {
  x: number;
  y: number;
  z: number;
}

function tetVolume(a: P3, b: P3, c: P3, d: P3): number {
  const ux = b.x - a.x,
    uy = b.y - a.y,
    uz = b.z - a.z;
  const vx = c.x - a.x,
    vy = c.y - a.y,
    vz = c.z - a.z;
  const wx = d.x - a.x,
    wy = d.y - a.y,
    wz = d.z - a.z;
  return (
    Math.abs(
      ux * (vy * wz - vz * wy) -
        uy * (vx * wz - vz * wx) +
        uz * (vx * wy - vy * wx),
    ) / 6
  );
}

function triArea(a: P3, b: P3, c: P3): number {
  const ux = b.x - a.x,
    uy = b.y - a.y,
    uz = b.z - a.z;
  const vx = c.x - a.x,
    vy = c.y - a.y,
    vz = c.z - a.z;
  const cx = uy * vz - uz * vy,
    cy = uz * vx - ux * vz,
    cz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

// Node positions of an element, in its node order. Throws on a node id the
// model does not have — the mesh is inconsistent and nothing sensible can be
// drawn from it.
function elementPoints(el: Element, nodeMap: Map<number, Node>): Node[] {
  return el.nodeIds.map((id) => {
    const n = nodeMap.get(id);
    if (!n)
      throw new Error(
        `density surface: element ${el.id} references unknown node ${id}`,
      );
    return n;
  });
}

// Per-node average of the element densities, weighted by element measure
// (tet/hex volume, shell facet area), aligned with `nodes`. Returns null when
// the density is stale (length no longer matches the design elements).
export function nodalDensity(
  nodes: Node[],
  elements: Element[],
  density: Float64Array,
): Float64Array | null {
  const ordered = orderedDesignElements(elements);
  if (density.length !== ordered.length) return null;
  const nodeMap = new Map<number, Node>(nodes.map((n) => [n.id, n]));
  const nodeIndex = new Map<number, number>(nodes.map((n, i) => [n.id, i]));
  const sum = new Float64Array(nodes.length);
  const weight = new Float64Array(nodes.length);
  for (let i = 0; i < ordered.length; i++) {
    const el = ordered[i];
    const pts = elementPoints(el, nodeMap);
    let measure: number;
    if (el.type === "CTETRA")
      measure = tetVolume(pts[0], pts[1], pts[2], pts[3]);
    else if (el.type === "CHEXA")
      measure = HEX_KUHN_TETS.reduce(
        (acc, [a, b, c, d]) => acc + tetVolume(pts[a], pts[b], pts[c], pts[d]),
        0,
      );
    else measure = triArea(pts[0], pts[1], pts[2]);
    for (const id of el.nodeIds) {
      const slot = nodeIndex.get(id) as number; // resolved by elementPoints
      sum[slot] += measure * density[i];
      weight[slot] += measure;
    }
  }
  // A node no design element touches (e.g. a reference point) carries no
  // material, so its value is 0 — void — not a guess.
  return sum.map((total, slot) =>
    weight[slot] > 0 ? total / weight[slot] : 0,
  );
}

// The level set φ ∈ [−1, 1] as a [0, 1] field whose 0.5 contour is φ = 0.
export function levelSetField(levelSet: Float64Array): Float64Array {
  return levelSet.map((phi) => 0.5 * (phi + 1));
}

// Boundary of {field ≥ level} over the design elements; `field` is aligned
// with `nodes`. Returns null when nothing is inside or the field is stale.
export function buildSmoothDensitySurface(
  nodes: Node[],
  elements: Element[],
  field: Float64Array,
  level: number,
): DensitySurface | null {
  if (field.length !== nodes.length || nodes.length === 0) return null;
  const nodeMap = new Map<number, Node>(nodes.map((n) => [n.id, n]));
  const nodeIndex = new Map<number, number>(nodes.map((n, i) => [n.id, i]));
  const valueAt = (id: number) => field[nodeIndex.get(id) as number];
  const pos = (id: number): P3 => nodeMap.get(id) as Node;
  const inside = (id: number) => valueAt(id) >= level;

  // Isosurface vertices live on mesh edges and are shared by every tet around
  // the edge, so their normals can be averaged for smooth shading.
  const isoIndex = new Map<string, number>();
  const isoPos: number[] = [];
  const isoNrm: number[] = [];
  const isoTris: number[] = [];
  const isoPoint = (vtx: number) =>
    new THREE.Vector3(
      isoPos[3 * vtx],
      isoPos[3 * vtx + 1],
      isoPos[3 * vtx + 2],
    );
  const edgeVertex = (from: number, to: number): number => {
    const key = from < to ? `${from},${to}` : `${to},${from}`;
    const hit = isoIndex.get(key);
    if (hit !== undefined) return hit;
    const valFrom = valueAt(from);
    const valTo = valueAt(to);
    // Linear interpolation of the crossing along the edge.
    const frac =
      valFrom === valTo
        ? 0.5
        : Math.min(1, Math.max(0, (level - valFrom) / (valTo - valFrom)));
    const pFrom = pos(from);
    const pTo = pos(to);
    const vtx = isoPos.length / 3;
    isoPos.push(
      pFrom.x + frac * (pTo.x - pFrom.x),
      pFrom.y + frac * (pTo.y - pFrom.y),
      pFrom.z + frac * (pTo.z - pFrom.z),
    );
    isoNrm.push(0, 0, 0);
    isoIndex.set(key, vtx);
    return vtx;
  };
  // Add an iso triangle oriented so its normal points away from `material`
  // (the centroid of the tet's inside nodes), i.e. out of the body.
  const addIso = (v0: number, v1: number, v2: number, material: P3) => {
    const pa = isoPoint(v0);
    const pb = isoPoint(v1);
    const pc = isoPoint(v2);
    const nrm = new THREE.Vector3()
      .subVectors(pb, pa)
      .cross(new THREE.Vector3().subVectors(pc, pa));
    const outward = pa
      .clone()
      .add(pb)
      .add(pc)
      .multiplyScalar(1 / 3)
      .sub(new THREE.Vector3(material.x, material.y, material.z));
    if (nrm.dot(outward) < 0) {
      nrm.negate();
      isoTris.push(v0, v2, v1);
    } else isoTris.push(v0, v1, v2);
    // Area-weighted normal accumulation (|nrm| = 2·area).
    for (const vtx of [v0, v1, v2]) {
      isoNrm[3 * vtx] += nrm.x;
      isoNrm[3 * vtx + 1] += nrm.y;
      isoNrm[3 * vtx + 2] += nrm.z;
    }
  };

  const marchTet = (ids: [number, number, number, number]) => {
    const inIds = ids.filter(inside);
    if (inIds.length === 0 || inIds.length === 4) return;
    const outIds = ids.filter((id) => !inside(id));
    const material = { x: 0, y: 0, z: 0 };
    for (const id of inIds) {
      const pt = pos(id);
      material.x += pt.x / inIds.length;
      material.y += pt.y / inIds.length;
      material.z += pt.z / inIds.length;
    }
    if (inIds.length === 1 || inIds.length === 3) {
      // One vertex separated from the other three: a single triangle.
      const [lone, others] =
        inIds.length === 1 ? [inIds[0], outIds] : [outIds[0], inIds];
      addIso(
        edgeVertex(lone, others[0]),
        edgeVertex(lone, others[1]),
        edgeVertex(lone, others[2]),
        material,
      );
    } else {
      // Two and two (inside ia, ib; outside oa, ob): the cut is the quad
      // (ia–oa, ia–ob, ib–ob, ib–oa).
      const [ia, ib] = inIds;
      const [oa, ob] = outIds;
      const q0 = edgeVertex(ia, oa);
      const q1 = edgeVertex(ia, ob);
      const q2 = edgeVertex(ib, ob);
      const q3 = edgeVertex(ib, oa);
      addIso(q0, q1, q2, material);
      addIso(q0, q2, q3, material);
    }
  };

  // Caps and shell facets: flat-shaded clipped polygons.
  const flatPos: number[] = [];
  const flatNrm: number[] = [];
  // Clip polygon `ids` (outward-oriented node ids) to {field ≥ level} and fan
  // it into triangles (Sutherland–Hodgman against a single linear field).
  const clipFace = (ids: number[]) => {
    const poly: THREE.Vector3[] = [];
    for (let i = 0; i < ids.length; i++) {
      const cur = ids[i];
      const next = ids[(i + 1) % ids.length];
      const pt = pos(cur);
      if (inside(cur)) poly.push(new THREE.Vector3(pt.x, pt.y, pt.z));
      if (inside(cur) !== inside(next))
        poly.push(isoPoint(edgeVertex(cur, next)));
    }
    if (poly.length < 3) return;
    const p0 = pos(ids[0]);
    const p1 = pos(ids[1]);
    const p2 = pos(ids[2]);
    const nrm = new THREE.Vector3(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z)
      .cross(new THREE.Vector3(p2.x - p0.x, p2.y - p0.y, p2.z - p0.z))
      .normalize();
    for (let i = 1; i + 1 < poly.length; i++)
      for (const vtx of [poly[0], poly[i], poly[i + 1]]) {
        flatPos.push(vtx.x, vtx.y, vtx.z);
        flatNrm.push(nrm.x, nrm.y, nrm.z);
      }
  };

  // Boundary faces of the solid design domain: faces owned by exactly one
  // element (same dedup as buildDensitySurface, over ALL solid elements).
  const faceCount = new Map<string, { ids: number[]; count: number }>();
  const addFace = (ids: number[]) => {
    const key = [...ids].sort((a, b) => a - b).join(",");
    const entry = faceCount.get(key);
    if (entry) entry.count++;
    else faceCount.set(key, { ids, count: 1 });
  };

  for (const el of orderedDesignElements(elements)) {
    const ids = el.nodeIds;
    if (el.type === "CTETRA") {
      marchTet([ids[0], ids[1], ids[2], ids[3]]);
      for (const [a, b, c] of TET_FACES) addFace([ids[a], ids[b], ids[c]]);
    } else if (el.type === "CHEXA") {
      // Kuhn tets for the interior surface. Adjacent hexes may split a shared
      // face along different diagonals, which can leave hairline seams there.
      for (const [a, b, c, d] of HEX_KUHN_TETS)
        marchTet([ids[a], ids[b], ids[c], ids[d]]);
      for (const [a, b, c, d] of HEX_FACES)
        addFace([ids[a], ids[b], ids[c], ids[d]]);
    } else if (el.type === "CTRIA3") {
      clipFace([ids[0], ids[1], ids[2]]);
    }
  }
  for (const { ids, count } of faceCount.values())
    if (count === 1) clipFace(ids);

  const total = isoTris.length * 3 + flatPos.length;
  if (total === 0) return null;
  const positions = new Float32Array(total);
  const normals = new Float32Array(total);
  let offset = 0;
  for (const vtx of isoTris) {
    const nx = isoNrm[3 * vtx];
    const ny = isoNrm[3 * vtx + 1];
    const nz = isoNrm[3 * vtx + 2];
    const len = Math.hypot(nx, ny, nz);
    // Every iso vertex belongs to at least one triangle, so its accumulated
    // normal is zero only if all of them are degenerate (zero area).
    const inv = len > 0 ? 1 / len : 0;
    positions[offset] = isoPos[3 * vtx];
    positions[offset + 1] = isoPos[3 * vtx + 1];
    positions[offset + 2] = isoPos[3 * vtx + 2];
    normals[offset] = nx * inv;
    normals[offset + 1] = ny * inv;
    normals[offset + 2] = nz * inv;
    offset += 3;
  }
  positions.set(flatPos, offset);
  normals.set(flatNrm, offset);
  const colors = new Float32Array(total);
  for (let i = 0; i < total; i += 3) {
    colors[i] = SMOOTH_COLOR.r;
    colors[i + 1] = SMOOTH_COLOR.g;
    colors[i + 2] = SMOOTH_COLOR.b;
  }
  return { positions, normals, colors, triangleCount: total / 9 };
}
