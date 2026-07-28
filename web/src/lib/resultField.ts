// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as THREE from "three";
import type {
  Element,
  Node,
  ResultType,
  SolverResult,
} from "../store/modelStore";

// Maps a normalized scalar t ∈ [0,1] to the viewport result color: blue (low)
// → red (high).  Must stay identical to MeshScene's vertex coloring so the
// colorbar legend matches what is drawn on the mesh.
export function resultColor(t: number): THREE.Color {
  return new THREE.Color().setHSL(0.667 * (1 - t), 1, 0.5);
}

// Volume of a 4-node tetrahedron from its node positions: |(b−a)·((c−a)×(d−a))|/6.
function tetVolume(a: Node, b: Node, c: Node, d: Node): number {
  const bx = b.x - a.x,
    by = b.y - a.y,
    bz = b.z - a.z;
  const cx = c.x - a.x,
    cy = c.y - a.y,
    cz = c.z - a.z;
  const dx = d.x - a.x,
    dy = d.y - a.y,
    dz = d.z - a.z;
  const det =
    bx * (cy * dz - cz * dy) -
    by * (cx * dz - cz * dx) +
    bz * (cx * dy - cy * dx);
  return Math.abs(det) / 6;
}

// Area of a 3-node triangle from its node positions: |(b−a)×(c−a)|/2.
function triArea(a: Node, b: Node, c: Node): number {
  const abx = b.x - a.x,
    aby = b.y - a.y,
    abz = b.z - a.z;
  const acx = c.x - a.x,
    acy = c.y - a.y,
    acz = c.z - a.z;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  return Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
}

// Averaging weight for one element: its measure, so a node's averaged stress is
// dominated by the elements that actually fill the space around it. Tetrahedra
// use the signed-volume formula; 3-node shell facets use their area (uniform
// thickness cancels in the average); any other element type falls back to unit
// weight (still counted, just unweighted).
function elementWeight(
  el: Element,
  nodeIndex: Map<number, number>,
  nodes: Node[],
): number {
  if (el.nodeIds.length === 3) {
    const i0 = nodeIndex.get(el.nodeIds[0]);
    const i1 = nodeIndex.get(el.nodeIds[1]);
    const i2 = nodeIndex.get(el.nodeIds[2]);
    if (i0 === undefined || i1 === undefined || i2 === undefined) return 1;
    return triArea(nodes[i0], nodes[i1], nodes[i2]);
  }
  if (el.nodeIds.length !== 4) return 1;
  const i0 = nodeIndex.get(el.nodeIds[0]);
  const i1 = nodeIndex.get(el.nodeIds[1]);
  const i2 = nodeIndex.get(el.nodeIds[2]);
  const i3 = nodeIndex.get(el.nodeIds[3]);
  if (
    i0 === undefined ||
    i1 === undefined ||
    i2 === undefined ||
    i3 === undefined
  )
    return 1;
  return tetVolume(nodes[i0], nodes[i1], nodes[i2], nodes[i3]);
}

// The solver returns one constant von Mises value per element (evaluated at the
// element center). This recovers a smooth C⁰ per-node field by volume-weighted
// averaging: each node takes the volume-weighted mean of the von Mises of the
// elements touching it. Weighting by volume (rather than a plain element count)
// down-weights the tiny sliver tetrahedra Netgen leaves at sharp features —
// those slivers carry extreme, noisy stresses that a plain average lets speckle
// the colormap at stress concentrations (issue #215). Returned in node-array
// order; the same field drives the colorbar range here and the vertex coloring
// in MeshScene, so the two must stay identical.
export function nodeVonMisesField(
  result: SolverResult,
  nodes: Node[],
  elements: Element[],
): Float64Array | null {
  if (!result.vonMises || elements.length === 0 || nodes.length === 0)
    return null;
  const vm = result.vonMises;
  if (vm.length !== elements.length)
    throw new Error(
      `von Mises result carries ${vm.length} values for ${elements.length} elements — the result is stale or belongs to a different mesh`,
    );
  const nodeIndex = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i].id, i);
  const sums = new Float64Array(nodes.length);
  const weights = new Float64Array(nodes.length);
  for (let ei = 0; ei < elements.length; ei++) {
    const vmVal = vm[ei];
    const weight = elementWeight(elements[ei], nodeIndex, nodes);
    for (const nodeId of elements[ei].nodeIds) {
      const ni = nodeIndex.get(nodeId);
      if (ni !== undefined) {
        sums[ni] += weight * vmVal;
        weights[ni] += weight;
      }
    }
  }
  const avg = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++)
    avg[i] = weights[i] > 0 ? sums[i] / weights[i] : 0;
  return avg;
}

export interface ResultRange {
  min: number;
  max: number;
}

// Position of `value` inside [min, max], as the t that resultColor expects.
// Clamped, so a value outside a manually narrowed legend range saturates at the
// end colour instead of wrapping back through the map.
export function resultFraction(
  value: number,
  min: number,
  max: number,
): number {
  const span = max - min;
  // Div-by-zero guard: a uniform field has zero span, and everything then sits
  // at the bottom of the map.
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (value - min) / span));
}

// Min/max of the selected scalar field over all nodes.  Returns null when the
// field cannot be computed (e.g. Von Mises requested but unavailable).
export function computeResultRange(
  result: SolverResult,
  resultType: ResultType,
  nodes: Node[],
  elements: Element[],
): ResultRange | null {
  if (nodes.length === 0) return null;
  const disp = result.displacements;
  if (disp.length !== nodes.length * 3)
    throw new Error(
      `displacement result carries ${disp.length} values for ${nodes.length} nodes (expected ${nodes.length * 3}) — the result is stale or belongs to a different mesh`,
    );

  let nodeVm: Float64Array | null = null;
  if (resultType === "Von Mises stress") {
    nodeVm = nodeVonMisesField(result, nodes, elements);
    if (!nodeVm) return null;
  }

  const nodeValue = (i: number): number => {
    switch (resultType) {
      case "Ux":
        return disp[i * 3];
      case "Uy":
        return disp[i * 3 + 1];
      case "Uz":
        return disp[i * 3 + 2];
      case "Von Mises stress":
        if (!nodeVm)
          throw new Error(
            "von Mises node field is unavailable although it was requested",
          );
        return nodeVm[i];
      default: {
        const ux = disp[i * 3],
          uy = disp[i * 3 + 1],
          uz = disp[i * 3 + 2];
        return Math.sqrt(ux * ux + uy * uy + uz * uz);
      }
    }
  };

  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const val = nodeValue(i);
    if (val < min) min = val;
    if (val > max) max = val;
  }
  return { min, max };
}

export function resultFieldSymbol(resultType: ResultType): string {
  return resultType === "Von Mises stress"
    ? "σ_vm"
    : resultType === "Displacement (magnitude)"
      ? "|U|"
      : resultType;
}

// Canonical unit system is N · mm · MPa: displacements come out in mm and
// stresses in MPa (force/area = N/mm²).
export function resultUnit(resultType: ResultType): string {
  return resultType === "Von Mises stress" ? "MPa" : "mm";
}
