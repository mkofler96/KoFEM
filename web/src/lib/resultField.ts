// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as THREE from "three";
import type {
  Element,
  Node,
  ResultType,
  SolverResult,
} from "../store/modelStore";
import {
  cornerCount,
  isStressField,
  principalStresses,
  STRESS_FIELDS,
  type ShellSurface,
  type StressField,
} from "./stressFields";
import { isContactField, type ContactField } from "./contact";
import { RESULT_TYPES } from "../store/resultsSlice";

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

// The solver returns one constant stress per element (evaluated at the element
// center). This recovers a smooth C⁰ per-node field by volume-weighted
// averaging: each node takes the volume-weighted mean of the values of the
// elements touching it. Weighting by volume (rather than a plain element count)
// down-weights the tiny sliver tetrahedra Netgen leaves at sharp features —
// those slivers carry extreme, noisy stresses that a plain average lets speckle
// the colormap at stress concentrations (issue #215). Returned in node-array
// order; the same field drives the colorbar range here and the vertex coloring
// in MeshScene, so the two must stay identical.
export function nodeAveraged(
  perElement: (element: number) => number,
  nodes: Node[],
  elements: Element[],
): Float64Array {
  const nodeIndex = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i].id, i);
  const sums = new Float64Array(nodes.length);
  const weights = new Float64Array(nodes.length);
  for (let ei = 0; ei < elements.length; ei++) {
    const value = perElement(ei);
    const weight = elementWeight(elements[ei], nodeIndex, nodes);
    for (const nodeId of elements[ei].nodeIds) {
      const ni = nodeIndex.get(nodeId);
      if (ni !== undefined) {
        sums[ni] += weight * value;
        weights[ni] += weight;
      }
    }
  }
  const avg = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++)
    avg[i] = weights[i] > 0 ? sums[i] / weights[i] : 0;
  return avg;
}

// As nodeAveraged, for a value per element corner: `atCorner` gets the offset
// of the corner's tensor (six per corner, corners in each element's node
// order), and each node takes the weighted mean of the corners at it.
function nodeAveragedCorners(
  atCorner: (offset: number) => number,
  nodes: Node[],
  elements: Element[],
): Float64Array {
  const nodeIndex = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i].id, i);
  const sums = new Float64Array(nodes.length);
  const weights = new Float64Array(nodes.length);
  let offset = 0;
  for (const element of elements) {
    const weight = elementWeight(element, nodeIndex, nodes);
    for (const nodeId of element.nodeIds) {
      const ni = nodeIndex.get(nodeId);
      if (ni !== undefined) {
        sums[ni] += weight * atCorner(offset);
        weights[ni] += weight;
      }
      offset += 6;
    }
  }
  const avg = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++)
    avg[i] = weights[i] > 0 ? sums[i] / weights[i] : 0;
  return avg;
}

// The node-averaged von Mises stress, or null when the result carries none.
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
  return nodeAveraged((e) => vm[e], nodes, elements);
}

// The node-averaged stress component or principal stress on `surface`, or null
// when the result carries no stress tensors (KOF-447).
export function nodeStressField(
  result: SolverResult,
  field: StressField,
  surface: ShellSurface,
  nodes: Node[],
  elements: Element[],
): Float64Array | null {
  if (!result.stress || elements.length === 0 || nodes.length === 0)
    return null;
  const tensors = result.stress[surface];
  const corners = elements.reduce((n, el) => n + cornerCount(el), 0);
  if (tensors.length !== 6 * corners)
    throw new Error(
      `the stress result carries ${tensors.length / 6} element corners for a mesh of ${corners} — the result is stale or belongs to a different mesh`,
    );
  const index = STRESS_FIELDS.indexOf(field);
  // A corner's value: the component, or the principal stress of the corner's
  // tensor, averaged to the node as von Mises is.
  const which = field === "Max principal stress σ1" ? 0 : 2;
  const atCorner = (offset: number) =>
    index < 6
      ? tensors[offset + index]
      : principalStresses(tensors, offset)[which];
  return nodeAveragedCorners(atCorner, nodes, elements);
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

// The plotted field per node, in node order: a displacement component or
// magnitude, or the node-averaged von Mises stress. The result surface's
// colours, the legend's range and the section cut all read it, so they cannot
// disagree. Null when von Mises is requested and the result carries none.
export function nodalResultValues(
  result: SolverResult,
  resultType: ResultType,
  nodes: Node[],
  elements: Element[],
  surface: ShellSurface,
): Float64Array | null {
  const disp = result.displacements;
  if (disp.length !== nodes.length * 3)
    throw new Error(
      `displacement result carries ${disp.length} values for ${nodes.length} nodes (expected ${nodes.length * 3}) — the result is stale or belongs to a different mesh`,
    );
  if (isContactField(resultType))
    return nodeContactField(result, resultType, nodes);
  if (resultType === "Von Mises stress")
    return nodeVonMisesField(result, nodes, elements);
  if (isStressField(resultType))
    return nodeStressField(result, resultType, surface, nodes, elements);
  const values = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const ux = disp[i * 3],
      uy = disp[i * 3 + 1],
      uz = disp[i * 3 + 2];
    values[i] =
      resultType === "Ux"
        ? ux
        : resultType === "Uy"
          ? uy
          : resultType === "Uz"
            ? uz
            : Math.sqrt(ux * ux + uy * uy + uz * uz);
  }
  return values;
}

// A contact field over the mesh nodes: the slave nodes' pressure or touching
// status, zero on every other node. Null for a result without contact.
function nodeContactField(
  result: SolverResult,
  field: ContactField,
  nodes: Node[],
): Float64Array | null {
  const contact = result.contact;
  if (!contact) return null;
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]));
  const values = new Float64Array(nodes.length);
  contact.nodeIds.forEach((id, k) => {
    const index = indexOf.get(id);
    if (index === undefined)
      throw new Error(
        `contact result names node ${id}, which the mesh does not have — the result belongs to a different mesh`,
      );
    values[index] =
      field === "Contact pressure" ? contact.pressure[k] : contact.closed[k];
  });
  return values;
}

// The fields a result offers: the contact fields only where it solved a
// contact.
export function resultTypesOf(
  result: Pick<SolverResult, "contact"> | null,
): ResultType[] {
  return RESULT_TYPES.filter(
    (type) => !isContactField(type) || !!result?.contact,
  );
}

// Min/max of the selected scalar field over all nodes.  Returns null when the
// field cannot be computed (e.g. Von Mises requested but unavailable).
export function computeResultRange(
  result: SolverResult,
  resultType: ResultType,
  nodes: Node[],
  elements: Element[],
  surface: ShellSurface,
): ResultRange | null {
  if (nodes.length === 0) return null;
  const values = nodalResultValues(
    result,
    resultType,
    nodes,
    elements,
    surface,
  );
  if (!values) return null;
  let min = Infinity,
    max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

export function resultFieldSymbol(resultType: ResultType): string {
  // "Normal stress σxx" → "σxx", "Max principal stress σ1" → "σ1".
  if (isStressField(resultType)) return resultType.split(" ").at(-1) as string;
  if (resultType === "Contact pressure") return "p_c";
  if (resultType === "Contact status") return "touching";
  return resultType === "Von Mises stress"
    ? "σ_vm"
    : resultType === "Displacement (magnitude)"
      ? "|U|"
      : resultType;
}

// Canonical unit system is N · mm · MPa: displacements come out in mm and
// stresses and contact pressure in MPa (force/area = N/mm²). The contact
// status (1 touching, 0 apart) has no unit.
export type ResultUnit = "MPa" | "mm" | "";

export function resultUnit(resultType: ResultType): ResultUnit {
  if (resultType === "Contact status") return "";
  return resultType === "Von Mises stress" ||
    isStressField(resultType) ||
    resultType === "Contact pressure"
    ? "MPa"
    : "mm";
}
