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

// Element-level von Mises stress averaged to nodes, the same averaging used for
// vertex coloring in MeshScene.
function nodeVonMisesField(
  result: SolverResult,
  nodes: Node[],
  elements: Element[],
): Float64Array | null {
  if (!result.vonMises || elements.length === 0 || nodes.length === 0)
    return null;
  const vm = result.vonMises;
  const nodeIndex = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i].id, i);
  const sums = new Float64Array(nodes.length);
  const counts = new Int32Array(nodes.length);
  for (let ei = 0; ei < elements.length; ei++) {
    const vmVal = vm[ei] ?? 0;
    for (const nodeId of elements[ei].nodeIds) {
      const ni = nodeIndex.get(nodeId);
      if (ni !== undefined) {
        sums[ni] += vmVal;
        counts[ni]++;
      }
    }
  }
  const avg = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i++)
    avg[i] = counts[i] > 0 ? sums[i] / counts[i] : 0;
  return avg;
}

export interface ResultRange {
  min: number;
  max: number;
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
  const d = result.displacements;

  let nodeVm: Float64Array | null = null;
  if (resultType === "Von Mises stress") {
    nodeVm = nodeVonMisesField(result, nodes, elements);
    if (!nodeVm) return null;
  }

  const nodeValue = (i: number): number => {
    switch (resultType) {
      case "Ux":
        return d[i * 3] ?? 0;
      case "Uy":
        return d[i * 3 + 1] ?? 0;
      case "Uz":
        return d[i * 3 + 2] ?? 0;
      case "Von Mises stress":
        return nodeVm?.[i] ?? 0;
      default: {
        const ux = d[i * 3] ?? 0,
          uy = d[i * 3 + 1] ?? 0,
          uz = d[i * 3 + 2] ?? 0;
        return Math.sqrt(ux * ux + uy * uy + uz * uz);
      }
    }
  };

  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const v = nodeValue(i);
    if (v < min) min = v;
    if (v > max) max = v;
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

export function resultUnit(resultType: ResultType): string {
  return resultType === "Von Mises stress" ? "Pa" : "m";
}
