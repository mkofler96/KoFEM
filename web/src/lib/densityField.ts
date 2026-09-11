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

// The elements in the exact order the worker packs them for the solver
// (packSolveMesh: all CTETRA first, then all CHEXA), so density[i] belongs to
// orderedSolidElements(elements)[i]. Topology optimization is solid-only
// (KOF-237), so any shell (CTRIA3) elements are not part of the density field
// and are dropped here.
export function orderedSolidElements(elements: Element[]): Element[] {
  const tets = elements.filter((e) => e.type === "CTETRA");
  const hexes = elements.filter((e) => e.type === "CHEXA");
  return [...tets, ...hexes];
}

// Number of elements kept at a given threshold — the count the viewport draws.
// Shared with the Results panel's readout so the two never disagree.
export function visibleElementCount(
  density: Float64Array,
  threshold: number,
): number {
  let n = 0;
  for (let i = 0; i < density.length; i++) if (density[i] >= threshold) n++;
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
  const ordered = orderedSolidElements(elements);
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

  if (positions.length === 0) return null;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    triangleCount: positions.length / 9,
  };
}
