// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Volume-weighted percentiles of the plotted nodal field (KOF-477), around the
// Rust computation (crates/kofem-fem/src/field_statistics.rs, called as
// nodalPercentiles). The Rust module must be loaded first (loadFemModule).

import {
  fieldPeak,
  nodalPercentiles,
  PeakConditions,
} from "../wasm/fem/kofem_wasm.js";
import type { Element, Node, Property } from "../store/modelStore";
import type { PickGeometry } from "./facePick";
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

interface PeakSelection {
  nodeIds: readonly number[];
  geometry?: PickGeometry;
}

/** A support, as fieldPeakLocation reads it. */
export interface PeakSupport {
  name: string;
  dofs: readonly number[];
  faces: readonly PeakSelection[];
}

/** A load, as fieldPeakLocation reads it. */
export interface PeakLoad {
  name: string;
  faces: readonly PeakSelection[];
}

/** A coupling, as fieldPeakLocation reads it. */
export interface PeakCoupling {
  name: string;
  refNodeId: number;
  faces: readonly PeakSelection[];
}

export interface PeakLocation {
  nodeId: number;
  // The node, undeformed (mm).
  at: [number, number, number];
  value: number;
  // The idealised supports and loads on the node, supports first.
  on: { kind: "support" | "load"; name: string }[];
}

/**
 * Where `values` (one per node, in node order) is largest, and the idealised
 * supports and loads on that node (KOF-495). Rust decides which groups are
 * idealised (crates/kofem-fem/src/field_peak.rs, called as fieldPeak); this
 * maps node ids to indices and hands it the groups as they are.
 */
export function fieldPeakLocation(
  values: Float64Array,
  nodes: readonly Node[],
  elements: readonly Pick<Element, "id" | "type" | "nodeIds">[],
  supports: readonly PeakSupport[],
  loads: readonly PeakLoad[],
  couplings: readonly PeakCoupling[],
): PeakLocation {
  const text = tr(resultsMessages);
  const index = new Map<number, number>();
  const points = new Float64Array(nodes.length * 3);
  nodes.forEach((node, i) => {
    index.set(node.id, i);
    points[3 * i] = node.x;
    points[3 * i + 1] = node.y;
    points[3 * i + 2] = node.z;
  });
  const indices = (owner: string, ids: readonly number[]) =>
    Uint32Array.from(ids, (id) => {
      const i = index.get(id);
      if (i === undefined) throw new Error(text.peakUnknownNode(owner, id));
      return i;
    });
  const shellTriangles = elements.flatMap((element) =>
    element.type === "CTRIA3"
      ? Array.from(indices(text.peakElement(element.id), element.nodeIds))
      : [],
  );
  const groups = [
    ...supports.map((group) => ({ kind: "support" as const, group })),
    ...loads.map((group) => ({ kind: "load" as const, group })),
  ];
  const conditions = new PeakConditions();
  try {
    for (const { kind, group } of groups) {
      if (kind === "support") conditions.support(Uint32Array.from(group.dofs));
      else conditions.load();
      for (const face of group.faces)
        conditions.select(face.geometry, indices(group.name, face.nodeIds));
    }
    for (const coupling of couplings) {
      const [reference] = indices(coupling.name, [coupling.refNodeId]);
      conditions.coupling(
        reference,
        indices(
          coupling.name,
          coupling.faces.flatMap((face) => face.nodeIds),
        ),
      );
    }
    const peak = fieldPeak(
      points,
      values,
      Uint32Array.from(shellTriangles),
      conditions,
    );
    try {
      const [x, y, z] = peak.at;
      return {
        nodeId: nodes[peak.node].id,
        at: [x, y, z],
        value: peak.value,
        on: Array.from(peak.idealised, (k) => ({
          kind: groups[k].kind,
          name: groups[k].group.name,
        })),
      };
    } finally {
      peak.free();
    }
  } finally {
    conditions.free();
  }
}
