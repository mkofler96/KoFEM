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

// One triangle of the retained-material surface. a→b→c winds counter-clockwise
// seen from outside the material, so the right-hand normal points outward.
interface SurfaceTriangle {
  a: Node;
  b: Node;
  c: Node;
  color: THREE.Color;
}

interface Face {
  ids: number[]; // node ids, as listed by the element's local face table
  color: THREE.Color;
  // Centroid of the owning element: the face is flipped if its normal points
  // towards it, so the surface is outward-oriented whatever the element's
  // node-ordering handedness (the STL export relies on this).
  inside: THREE.Vector3;
}

function centroid(pts: Node[]): THREE.Vector3 {
  const sum = new THREE.Vector3();
  for (const p of pts) sum.add(new THREE.Vector3(p.x, p.y, p.z));
  return sum.divideScalar(pts.length);
}

function triangleNormal(a: Node, b: Node, c: Node): THREE.Vector3 {
  const ab = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
  const ac = new THREE.Vector3(c.x - a.x, c.y - a.y, c.z - a.z);
  return ab.cross(ac).normalize();
}

// Boundary triangles of the retained element set — the single definition of
// "the optimized shape" that both the viewport and the STL export draw. A face
// shared by two kept elements is interior (drawn from neither); a face kept by
// exactly one element is on the surface of the emerging structure and is drawn
// in the owning element's density colour. Returns null when there is nothing to
// draw (empty mesh, or every element below the threshold) or when the density
// is stale — its length no longer matches the mesh (e.g. a re-mesh after the
// run), mirroring the guard the displacement colormap uses.
function collectSurfaceTriangles(
  nodes: Node[],
  elements: Element[],
  density: Float64Array,
  threshold: number,
): SurfaceTriangle[] | null {
  const ordered = orderedDesignElements(elements);
  if (density.length !== ordered.length || ordered.length === 0) return null;

  const nodeMap = new Map<number, Node>(nodes.map((n) => [n.id, n]));
  const lookup = (ids: number[]): Node[] | null => {
    const pts = ids.map((id) => nodeMap.get(id));
    return pts.some((p) => p === undefined) ? null : (pts as Node[]);
  };

  // Collect every face of every kept element, keyed by its sorted node ids, and
  // count how many kept elements share it. Interior faces appear twice.
  const faceMap = new Map<string, { face: Face; count: number }>();
  const addFace = (
    ids: number[],
    color: THREE.Color,
    inside: THREE.Vector3,
  ) => {
    const key = [...ids].sort((a, b) => a - b).join(",");
    const entry = faceMap.get(key);
    if (entry) entry.count++;
    else faceMap.set(key, { face: { ids, color, inside }, count: 1 });
  };

  // Shell facets are themselves surfaces (not the boundary of a volume), so they
  // are drawn directly rather than run through the shared-face dedup that finds a
  // solid body's boundary — a kept CTRIA3 always shows its triangle.
  const triangles: SurfaceTriangle[] = [];

  for (let i = 0; i < ordered.length; i++) {
    if (density[i] < threshold) continue;
    const el = ordered[i];
    const color = densityColor(density[i]);
    if (el.type === "CTETRA" || el.type === "CHEXA") {
      const pts = lookup(el.nodeIds);
      if (!pts) continue;
      const inside = centroid(pts);
      const table = el.type === "CTETRA" ? TET_FACES : HEX_FACES;
      for (const local of table)
        addFace(
          local.map((k) => el.nodeIds[k]),
          color,
          inside,
        );
    } else if (el.type === "CTRIA3") {
      const pts = lookup(el.nodeIds.slice(0, 3));
      if (!pts) continue;
      triangles.push({ a: pts[0], b: pts[1], c: pts[2], color });
    }
  }

  for (const { face, count } of faceMap.values()) {
    if (count !== 1) continue; // interior face — not part of the surface
    const pts = lookup(face.ids);
    if (!pts) continue;
    const outward = new THREE.Vector3()
      .copy(centroid(pts))
      .sub(face.inside)
      .dot(triangleNormal(pts[0], pts[1], pts[2]));
    const ring = outward < 0 ? [...pts].reverse() : pts;
    triangles.push({ a: ring[0], b: ring[1], c: ring[2], color: face.color });
    if (ring.length === 4)
      triangles.push({ a: ring[0], b: ring[2], c: ring[3], color: face.color });
  }

  return triangles.length > 0 ? triangles : null;
}

// Flat-shaded viewport geometry of the retained-material surface.
export function buildDensitySurface(
  nodes: Node[],
  elements: Element[],
  density: Float64Array,
  threshold: number,
): DensitySurface | null {
  const triangles = collectSurfaceTriangles(
    nodes,
    elements,
    density,
    threshold,
  );
  if (!triangles) return null;

  const n = triangles.length;
  const positions = new Float32Array(n * 9);
  const normals = new Float32Array(n * 9);
  const colors = new Float32Array(n * 9);
  triangles.forEach(({ a, b, c, color }, t) => {
    const nrm = triangleNormal(a, b, c);
    positions.set([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], t * 9);
    for (let k = 0; k < 3; k++) {
      normals.set([nrm.x, nrm.y, nrm.z], t * 9 + k * 3);
      colors.set([color.r, color.g, color.b], t * 9 + k * 3);
    }
  });
  return { positions, normals, colors, triangleCount: n };
}

// Binary STL of a density surface as the viewport draws it, in the model's own
// length units (STL carries none). The facet normal is recomputed from each
// triangle's winding (a smooth surface carries averaged vertex normals, which
// are not facet normals).
//
// Layout: 80-byte header, uint32 triangle count, then per triangle 12 float32
// (normal, three vertices) and a uint16 attribute word, all little-endian.
function surfaceToStl(surface: DensitySurface, header: string): ArrayBuffer {
  const count = surface.triangleCount;
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  for (let i = 0; i < header.length && i < 80; i++)
    view.setUint8(i, header.charCodeAt(i) & 0x7f);
  view.setUint32(80, count, true);

  let offset = 84;
  const put = (v: number) => {
    view.setFloat32(offset, v, true);
    offset += 4;
  };
  const pos = surface.positions;
  const vertex = (t: number, k: number): Node => ({
    id: -1,
    x: pos[9 * t + 3 * k],
    y: pos[9 * t + 3 * k + 1],
    z: pos[9 * t + 3 * k + 2],
  });
  for (let t = 0; t < count; t++) {
    const tri = [vertex(t, 0), vertex(t, 1), vertex(t, 2)];
    const nrm = triangleNormal(tri[0], tri[1], tri[2]);
    put(nrm.x);
    put(nrm.y);
    put(nrm.z);
    for (const p of tri) {
      put(p.x);
      put(p.y);
      put(p.z);
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return buffer;
}

// Binary STL of the retained-material surface at `threshold` (KOF-239): exactly
// the faceted shape the element view draws. Solid elements export as the
// closed, outward-oriented boundary of the kept set; kept shell facets export
// as zero-thickness mid-surface triangles. Returns null when nothing is kept —
// there is no shape to export.
export function buildDensityStl(
  nodes: Node[],
  elements: Element[],
  density: Float64Array,
  threshold: number,
): ArrayBuffer | null {
  const surface = buildDensitySurface(nodes, elements, density, threshold);
  if (!surface) return null;
  return surfaceToStl(
    surface,
    `KoFEM topology optimization, density >= ${threshold.toFixed(2)}`,
  );
}

// Download filename for the exported shape; encodes the cutoff so exports at
// different thresholds do not overwrite each other.
export function densityStlFileName(
  modelName: string,
  threshold: number,
): string {
  // eslint-disable-next-line kofem/no-silent-fallback -- download filename for an unnamed model; cosmetic, never fed back into the analysis
  const base = (modelName || "model").replace(/[^\w-]+/g, "_");
  return `${base}_topopt_t${threshold.toFixed(2)}.stl`;
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
  // Clip polygon `ids` to {field ≥ level} and fan it into triangles
  // (Sutherland–Hodgman against a single linear field). A solid boundary face
  // passes its owning element's centroid and is oriented away from it, whatever
  // the element's node-ordering handedness (as collectSurfaceTriangles does);
  // a shell facet has no inside and keeps its node order.
  const clipFace = (ids: number[], owner?: THREE.Vector3) => {
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
    const flip =
      owner !== undefined &&
      new THREE.Vector3(p0.x, p0.y, p0.z).sub(owner).dot(nrm) < 0;
    if (flip) nrm.negate();
    for (let i = 1; i + 1 < poly.length; i++)
      for (const vtx of flip
        ? [poly[0], poly[i + 1], poly[i]]
        : [poly[0], poly[i], poly[i + 1]]) {
        flatPos.push(vtx.x, vtx.y, vtx.z);
        flatNrm.push(nrm.x, nrm.y, nrm.z);
      }
  };

  // Boundary faces of the solid design domain: faces owned by exactly one
  // element (same dedup as buildDensitySurface, over ALL solid elements).
  const faceCount = new Map<
    string,
    { ids: number[]; owner: THREE.Vector3; count: number }
  >();
  const addFace = (ids: number[], owner: THREE.Vector3) => {
    const key = [...ids].sort((a, b) => a - b).join(",");
    const entry = faceCount.get(key);
    if (entry) entry.count++;
    else faceCount.set(key, { ids, owner, count: 1 });
  };

  for (const el of orderedDesignElements(elements)) {
    const ids = el.nodeIds;
    if (el.type === "CTETRA") {
      marchTet([ids[0], ids[1], ids[2], ids[3]]);
      const owner = centroid(ids.map((id) => nodeMap.get(id) as Node));
      for (const [a, b, c] of TET_FACES)
        addFace([ids[a], ids[b], ids[c]], owner);
    } else if (el.type === "CHEXA") {
      // Kuhn tets for the interior surface. Adjacent hexes may split a shared
      // face along different diagonals, which can leave hairline seams there.
      for (const [a, b, c, d] of HEX_KUHN_TETS)
        marchTet([ids[a], ids[b], ids[c], ids[d]]);
      const owner = centroid(ids.map((id) => nodeMap.get(id) as Node));
      for (const [a, b, c, d] of HEX_FACES)
        addFace([ids[a], ids[b], ids[c], ids[d]], owner);
    } else if (el.type === "CTRIA3") {
      clipFace([ids[0], ids[1], ids[2]]);
    }
  }
  for (const { ids, owner, count } of faceCount.values())
    if (count === 1) clipFace(ids, owner);

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

// Binary STL of the smooth surface (buildSmoothDensitySurface) — what the
// viewport shows in its Smooth mode: the closed, outward-oriented boundary of
// {field ≥ level}, with shell facets clipped as zero-thickness triangles.
// Returns null when nothing is inside.
export function buildSmoothDensityStl(
  nodes: Node[],
  elements: Element[],
  field: Float64Array,
  level: number,
  what: string,
): ArrayBuffer | null {
  const surface = buildSmoothDensitySurface(nodes, elements, field, level);
  if (!surface) return null;
  return surfaceToStl(
    surface,
    `KoFEM topology optimization, smooth ${what} >= ${level.toFixed(2)}`,
  );
}
