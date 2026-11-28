// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Statistics of a result field, around the Rust computations in
// crates/kofem-fem/src/field_statistics.rs: the volume-weighted percentiles
// of the plotted nodal field (KOF-477, nodalPercentiles) and the per-group
// max and percentile of an element field (KOF-496, groupedElementStatistics).
// The Rust module must be loaded first (loadFemModule).

import {
  groupedElementStatistics,
  nodalPercentiles,
} from "../wasm/fem/kofem_wasm.js";
import type { Element, Node, Property } from "../store/modelStore";
import { tr } from "../i18n/useLocale";
import { resultsMessages } from "../i18n/messages/results";

/** The share of the model's volume each percentile row in Results stands for. */
export const RESULT_PERCENTILES = [0.95, 0.99] as const;

// The app's nodes and elements as the Rust module's statistics take them:
// coordinates in node order, connectivities by node index per element family,
// and where each element lands in the family order (tetrahedra, hexahedra,
// shell facets), which per-element inputs follow.
interface PackedElements {
  points: Float64Array;
  tets: Uint32Array;
  tetNodes: number;
  hexes: Uint32Array;
  shells: Uint32Array;
  thicknesses: Float64Array;
  familyOrder: number[];
}

function packElements(
  nodes: Node[],
  elements: Element[],
  properties: Property[],
): PackedElements {
  const text = tr(resultsMessages);
  const index = new Map<number, number>();
  const points = new Float64Array(nodes.length * 3);
  nodes.forEach((node, i) => {
    index.set(node.id, i);
    points[3 * i] = node.x;
    points[3 * i + 1] = node.y;
    points[3 * i + 2] = node.z;
  });
  const tets: number[] = [];
  const hexes: number[] = [];
  const shells: number[] = [];
  const thicknesses: number[] = [];
  const tetOrder: number[] = [];
  const hexOrder: number[] = [];
  const shellOrder: number[] = [];
  let tetNodes = 4;
  elements.forEach((element, e) => {
    const at = element.nodeIds.map((id) => {
      const i = index.get(id);
      if (i === undefined)
        throw new Error(text.percentileUnknownNode(element.id, id));
      return i;
    });
    if (element.type === "CTETRA") {
      tetNodes = at.length;
      tets.push(...at);
      tetOrder.push(e);
    } else if (element.type === "CHEXA") {
      hexes.push(...at);
      hexOrder.push(e);
    } else {
      const thickness = properties.find(
        (p) => p.id === element.propertyId,
      )?.thickness;
      if (thickness === undefined)
        throw new Error(text.percentileNoThickness(element.id));
      shells.push(...at);
      thicknesses.push(thickness);
      shellOrder.push(e);
    }
  });
  return {
    points,
    tets: Uint32Array.from(tets),
    tetNodes,
    hexes: Uint32Array.from(hexes),
    shells: Uint32Array.from(shells),
    thicknesses: Float64Array.from(thicknesses),
    familyOrder: [...tetOrder, ...hexOrder, ...shellOrder],
  };
}

/**
 * The volume-weighted `quantiles` of `values` (one per node, in node order):
 * for each, the lowest value with that share of the volume at or below it.
 * A shell facet's volume is its area times its property's thickness.
 */
export function fieldPercentiles(
  values: Float64Array,
  nodes: Node[],
  elements: Element[],
  properties: Property[],
  quantiles: readonly number[],
): number[] {
  const packed = packElements(nodes, elements, properties);
  return Array.from(
    nodalPercentiles(
      packed.points,
      values,
      packed.tets,
      packed.tetNodes,
      packed.hexes,
      packed.shells,
      packed.thicknesses,
      Float64Array.from(quantiles),
    ),
  );
}

/** The max and a percentile of one group's field. */
export interface GroupStatistics {
  max: number;
  quantile: number;
}

/**
 * Per group, the max and the volume-weighted `quantile` of an element field
 * (`values`, one per element in element order) averaged to the nodes over
 * that group's elements only. `groups` gives each element's group, numbered
 * from 0 to `groupCount` − 1.
 */
export function groupStatistics(
  values: Float64Array,
  groups: Uint32Array,
  groupCount: number,
  quantile: number,
  nodes: Node[],
  elements: Element[],
  properties: Property[],
): GroupStatistics[] {
  const packed = packElements(nodes, elements, properties);
  const order = packed.familyOrder;
  const flat = groupedElementStatistics(
    packed.points,
    packed.tets,
    packed.tetNodes,
    packed.hexes,
    packed.shells,
    packed.thicknesses,
    Float64Array.from(order, (e) => values[e]),
    Uint32Array.from(order, (e) => groups[e]),
    groupCount,
    quantile,
  );
  return Array.from({ length: groupCount }, (_, g) => ({
    max: flat[2 * g],
    quantile: flat[2 * g + 1],
  }));
}
