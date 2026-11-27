// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Volume-weighted percentiles of the plotted nodal field (KOF-477), around the
// Rust computation (crates/kofem-fem/src/field_statistics.rs, called as
// nodalPercentiles). The Rust module must be loaded first (loadFemModule).

import { fieldPeak, nodalPercentiles } from "../wasm/fem/kofem_wasm.js";
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

// Ux, Uy, Uz.
const TRANSLATIONS = [0, 1, 2];

/**
 * Where `values` (one per node, in node order) is largest, and the idealised
 * supports and loads on that node (KOF-495), around the Rust computation
 * (crates/kofem-fem/src/field_peak.rs, called as fieldPeak).
 *
 * Idealised are a support that holds every translation, which pins the
 * surface in its own plane, and a support or load on a point or on an edge of
 * a solid, which concentrates it on a line. A symmetry or roller support on a
 * face, a load spread over a face, and either on a shell's edge (the
 * boundary of the plate) load the part as it is loaded, so a peak there is a
 * real stress: the hole edge of a plate on its symmetry line, the bore of a
 * pressurised cylinder. A support on a coupling's reference point holds the
 * coupled surface; a load there is spread over it.
 */
export function fieldPeakLocation(
  values: Float64Array,
  nodes: readonly Node[],
  elements: readonly Pick<Element, "type" | "nodeIds">[],
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
  const shellNodes = new Set(
    elements.flatMap((element) =>
      element.type === "CTRIA3" ? element.nodeIds : [],
    ),
  );
  const concentrated = (selection: PeakSelection) =>
    selection.geometry === "point" ||
    (selection.geometry === "edge" &&
      !selection.nodeIds.every((id) => shellNodes.has(id)));
  const surfaceOf = new Map(
    couplings.map((coupling) => [
      coupling.refNodeId,
      coupling.faces.flatMap((face) => face.nodeIds),
    ]),
  );
  const groups = [
    ...supports.flatMap((group) => {
      const held = TRANSLATIONS.every((dof) => group.dofs.includes(dof))
        ? group.faces
        : group.faces.filter(concentrated);
      const ids = held.flatMap((face) => face.nodeIds);
      return held.length === 0
        ? []
        : [
            {
              kind: "support" as const,
              name: group.name,
              nodeIds: [
                ...ids,
                ...ids.flatMap((id) => surfaceOf.get(id) ?? []),
              ],
            },
          ];
    }),
    ...loads.flatMap((group) => {
      const held = group.faces.filter(concentrated);
      return held.length === 0
        ? []
        : [
            {
              kind: "load" as const,
              name: group.name,
              nodeIds: held.flatMap((face) => face.nodeIds),
            },
          ];
    }),
  ];
  const offsets = [0];
  const members: number[] = [];
  for (const group of groups) {
    for (const id of group.nodeIds) {
      const i = index.get(id);
      if (i === undefined)
        throw new Error(text.peakUnknownNode(group.name, id));
      members.push(i);
    }
    offsets.push(members.length);
  }
  const peak = fieldPeak(
    points,
    values,
    Uint32Array.from(offsets),
    Uint32Array.from(members),
  );
  try {
    const node = nodes[peak.node];
    const [x, y, z] = peak.at;
    return {
      nodeId: node.id,
      at: [x, y, z],
      value: peak.value,
      on: Array.from(peak.selections, (k) => ({
        kind: groups[k].kind,
        name: groups[k].name,
      })),
    };
  } finally {
    peak.free();
  }
}
