// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Volume-weighted percentiles of the plotted nodal field (KOF-477), around the
// Rust computation (crates/kofem-fem/src/field_statistics.rs, called as
// nodalPercentiles). The Rust module must be loaded first (loadFemModule).

import { nodalPercentiles } from "../wasm/fem/kofem_wasm.js";
import type { Element, Node, Property } from "../store/modelStore";
import { tr } from "../i18n/useLocale";
import { resultsMessages } from "../i18n/messages/results";

/** The share of the model's volume each percentile row in Results stands for. */
export const RESULT_PERCENTILES = [0.95, 0.99] as const;

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
  let tetNodes = 4;
  for (const element of elements) {
    const at = element.nodeIds.map((id) => {
      const i = index.get(id);
      if (i === undefined)
        throw new Error(text.percentileUnknownNode(element.id, id));
      return i;
    });
    if (element.type === "CTETRA") {
      tetNodes = at.length;
      tets.push(...at);
    } else if (element.type === "CHEXA") {
      hexes.push(...at);
    } else {
      const thickness = properties.find(
        (p) => p.id === element.propertyId,
      )?.thickness;
      if (thickness === undefined)
        throw new Error(text.percentileNoThickness(element.id));
      shells.push(...at);
      thicknesses.push(thickness);
    }
  }
  return Array.from(
    nodalPercentiles(
      points,
      values,
      Uint32Array.from(tets),
      tetNodes,
      Uint32Array.from(hexes),
      Uint32Array.from(shells),
      Float64Array.from(thicknesses),
      Float64Array.from(quantiles),
    ),
  );
}
