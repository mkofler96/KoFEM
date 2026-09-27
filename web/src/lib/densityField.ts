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

// Binary STL of the retained-material surface at `threshold` (KOF-239): exactly
// the faceted shape the viewport draws, in the model's own length units (STL
// carries none). Solid elements export as the closed, outward-oriented boundary
// of the kept set; kept shell facets export as zero-thickness mid-surface
// triangles. This is a threshold surface, not a smoothed or CAD-fitted one.
// Returns null when nothing is kept — there is no shape to export.
//
// Layout: 80-byte header, uint32 triangle count, then per triangle 12 float32
// (normal, three vertices) and a uint16 attribute word, all little-endian.
export function buildDensityStl(
  nodes: Node[],
  elements: Element[],
  density: Float64Array,
  threshold: number,
): ArrayBuffer | null {
  const triangles = collectSurfaceTriangles(
    nodes,
    elements,
    density,
    threshold,
  );
  if (!triangles) return null;

  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buffer);
  const header = `KoFEM topology optimization, density >= ${threshold.toFixed(2)}`;
  for (let i = 0; i < header.length && i < 80; i++)
    view.setUint8(i, header.charCodeAt(i) & 0x7f);
  view.setUint32(80, triangles.length, true);

  let offset = 84;
  const put = (v: number) => {
    view.setFloat32(offset, v, true);
    offset += 4;
  };
  for (const { a, b, c } of triangles) {
    const nrm = triangleNormal(a, b, c);
    put(nrm.x);
    put(nrm.y);
    put(nrm.z);
    for (const p of [a, b, c]) {
      put(p.x);
      put(p.y);
      put(p.z);
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return buffer;
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
