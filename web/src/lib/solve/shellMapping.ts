// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mapping between an idealised shell mid-surface and the original store mesh:
// nearest-node lookup and the per-element von Mises recovery the auto-shell
// paths (coupled and pure shell) share.

import type { Element, Node } from "../../workers/solverTypes.js";
import { SpatialGrid } from "../spatialGrid.js";

export type NearestLocator = (p: [number, number, number]) => number;

// Nearest mid-surface node to a query point, grid-accelerated with an expanding
// ring search so it works whatever the wall offset. Standalone counterpart of
// shellNodeLocator (which needs a CoupledModel); here the pool IS the shell.
export function buildNearestVertexLocator(verts: number[]): NearestLocator {
  const n = verts.length / 3;
  let span = 0;
  for (let d = 0; d < 3; d++) {
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const val = verts[3 * i + d];
      if (val < lo) lo = val;
      if (val > hi) hi = val;
    }
    span = Math.max(span, hi - lo);
  }
  // Cell ~ mean node spacing; the 1e-6 floor keeps it positive for a degenerate
  // (single-point) cloud.
  const cell = Math.max(span / Math.max(1, Math.cbrt(n)), 1e-6);
  const grid = new SpatialGrid(
    Array.from({ length: n }, (_, index) => index),
    (index) => [verts[3 * index], verts[3 * index + 1], verts[3 * index + 2]],
    cell,
  );
  const maxRings = 32;
  return (p) => {
    let best = -1,
      bd = Infinity;
    for (let r = 0; r <= maxRings && best < 0; r++) {
      for (const i of grid.candidates(p, r, r)) {
        const dd =
          (p[0] - verts[3 * i]) ** 2 +
          (p[1] - verts[3 * i + 1]) ** 2 +
          (p[2] - verts[3 * i + 2]) ** 2;
        if (dd < bd) {
          bd = dd;
          best = i;
        }
      }
    }
    if (best < 0)
      throw new Error(
        `pure shell: no mid-surface node found near query point (${p[0]}, ${p[1]}, ${p[2]}) — ` +
          "a boundary condition or load could not be mapped onto the shell mesh",
      );
    return best;
  };
}

// Per shell node, the worst surface stress of its adjacent facets. `triangles`
// is flat (3 node indices per facet), `facetVm` one value per facet.
export function maxFacetStressPerNode(
  triangles: ArrayLike<number>,
  facetVm: ArrayLike<number>,
): Map<number, number> {
  const vmByNode = new Map<number, number>();
  for (let t = 0; t < triangles.length / 3; t++) {
    const vm = facetVm[t];
    for (const node of [
      triangles[3 * t],
      triangles[3 * t + 1],
      triangles[3 * t + 2],
    ])
      // eslint-disable-next-line kofem/no-silent-fallback -- running max over adjacent facets; 0 is the identity for a node seen for the first time
      vmByNode.set(node, Math.max(vmByNode.get(node) ?? 0, vm));
  }
  return vmByNode;
}

// The recovered stress of an original element: the worst adjacent-facet stress
// at the shell node nearest its centroid. Throws for an element that
// references a node the model does not have, or whose nearest shell node
// touches no facet; `context` names the path in the error.
export function shellStressAtCentroid(
  element: Element,
  nodeById: Map<number, Node>,
  nearestShell: NearestLocator,
  vmByShellNode: Map<number, number>,
  context: string,
): number {
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const nid of element.nodeIds) {
    const nd = nodeById.get(nid);
    if (!nd)
      throw new Error(
        `${context}: element ${element.id} references unknown node id ${nid}`,
      );
    cx += nd.x;
    cy += nd.y;
    cz += nd.z;
  }
  const k = element.nodeIds.length;
  const pi = nearestShell([cx / k, cy / k, cz / k]);
  const vm = vmByShellNode.get(pi);
  if (vm === undefined)
    throw new Error(
      `${context}: element ${element.id} lies nearest mid-surface node ${pi}, which no shell facet uses`,
    );
  return vm;
}

// Per shell node, the mean stress tensor (six components) of the facets
// around it, each facet's tensor at its corner on that node (the solve gives
// three corner tensors per facet). A component cannot take the "worst" facet as
// von Mises does, so the facets are averaged, as the result plot averages them
// at a node.
export function meanFacetTensorPerNode(
  triangles: ArrayLike<number>,
  cornerTensors: Float64Array,
): Map<number, Float64Array> {
  if (cornerTensors.length !== 6 * triangles.length)
    throw new Error(
      `stress mapping: ${cornerTensors.length / 6} facet corner tensors for ${triangles.length / 3} facets`,
    );
  const sums = new Map<number, { sum: Float64Array; count: number }>();
  for (let c = 0; c < triangles.length; c++) {
    const node = triangles[c];
    let entry = sums.get(node);
    if (!entry) {
      entry = { sum: new Float64Array(6), count: 0 };
      sums.set(node, entry);
    }
    for (let k = 0; k < 6; k++) entry.sum[k] += cornerTensors[6 * c + k];
    entry.count++;
  }
  const means = new Map<number, Float64Array>();
  for (const [node, { sum, count }] of sums)
    means.set(
      node,
      sum.map((v) => v / count),
    );
  return means;
}

// The recovered corner tensors of an original element: at each of its nodes,
// the mean tensor of the shell node nearest that node. Throws for an element
// that references a node the model does not have, or whose nearest shell node
// touches no facet.
export function shellTensorsAtCorners(
  element: Element,
  nodeById: Map<number, Node>,
  nearestShell: NearestLocator,
  tensorByShellNode: Map<number, Float64Array>,
  context: string,
): Float64Array {
  const out = new Float64Array(6 * element.nodeIds.length);
  element.nodeIds.forEach((nid, corner) => {
    const nd = nodeById.get(nid);
    if (!nd)
      throw new Error(
        `${context}: element ${element.id} references unknown node id ${nid}`,
      );
    const pi = nearestShell([nd.x, nd.y, nd.z]);
    const tensor = tensorByShellNode.get(pi);
    if (!tensor)
      throw new Error(
        `${context}: node ${nid} lies nearest mid-surface node ${pi}, which no shell facet uses`,
      );
    out.set(tensor, 6 * corner);
  });
  return out;
}
