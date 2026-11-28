// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What the Mesh step lists per body (KOF-497), around the Rust computation
// (crates/kofem-fem/src/mesh_statistics.rs, called as meshBodyStatistics).
// The Rust module must be loaded first (loadFemModule).

import { meshBodyStatistics as rustBodyStatistics } from "../wasm/fem/kofem_wasm.js";
import type { Element, Node, Property } from "../store/modelStore";
import type { Material } from "../store/materialSlice";
import { tr } from "../i18n/useLocale";
import { meshMessages } from "../i18n/messages/mesh";

export interface BodyMeshStatistics {
  // The CAD solid (body or region) id, as in the model tree.
  body: number;
  // Mean length of the body's distinct element edges (mm).
  meanEdgeLength: number;
  // mm³.
  volume: number;
  // Tonnes (the app's N·mm·t system); null when the body has no density.
  mass: number | null;
}

// The CAD solid an element's property stands for: a derived shell section
// counts for the body whose walls it replaces.
function solidOf(property: Property): number {
  return property.sourceBodyId ?? property.id;
}

// The density a body's mass is taken from, or none: a material nobody chose
// (materialUnconfirmed) or one that no longer exists gives no density, never
// a default one. The material store keeps 0 for a density not set.
function densityOf(
  property: Property,
  materials: readonly Material[],
): number | undefined {
  if (property.materialUnconfirmed) return undefined;
  const density = materials.find((m) => m.id === property.materialId)?.density;
  return density === undefined || density === 0 ? undefined : density;
}

// The mesh stores corners only; the solver adds the quadratic nodes.
const CORNERS = { CTETRA: 4, CHEXA: 8, CTRIA3: 3 } as const;

/**
 * The mean element edge length, volume and mass of every body with elements,
 * in body id order.
 */
export function meshBodyStatistics(
  nodes: readonly Node[],
  elements: readonly Element[],
  properties: readonly Property[],
  materials: readonly Material[],
): BodyMeshStatistics[] {
  const text = tr(meshMessages);
  const index = new Map<number, number>();
  const points = new Float64Array(nodes.length * 3);
  nodes.forEach((node, i) => {
    index.set(node.id, i);
    points[3 * i] = node.x;
    points[3 * i + 1] = node.y;
    points[3 * i + 2] = node.z;
  });
  const propertyById = new Map(properties.map((p) => [p.id, p]));
  const tets: number[] = [];
  const tetBodies: number[] = [];
  const hexes: number[] = [];
  const hexBodies: number[] = [];
  const facets: number[] = [];
  const facetBodies: number[] = [];
  const thicknesses: number[] = [];
  for (const element of elements) {
    const property = propertyById.get(element.propertyId);
    if (property === undefined)
      throw new Error(
        text.statisticsUnknownProperty(element.id, element.propertyId),
      );
    const corners = CORNERS[element.type];
    if (element.nodeIds.length !== corners)
      throw new Error(
        text.statisticsNodeCount(
          element.id,
          element.type,
          element.nodeIds.length,
          corners,
        ),
      );
    const at = element.nodeIds.map((id) => {
      const i = index.get(id);
      if (i === undefined)
        throw new Error(text.statisticsUnknownNode(element.id, id));
      return i;
    });
    const body = solidOf(property);
    if (element.type === "CTETRA") {
      tets.push(...at);
      tetBodies.push(body);
    } else if (element.type === "CHEXA") {
      hexes.push(...at);
      hexBodies.push(body);
    } else {
      if (property.thickness === undefined)
        throw new Error(text.statisticsNoThickness(element.id));
      facets.push(...at);
      facetBodies.push(body);
      thicknesses.push(property.thickness);
    }
  }
  const densityBodies: number[] = [];
  const densities: number[] = [];
  for (const property of properties) {
    if (property.sourceBodyId !== undefined) continue;
    const density = densityOf(property, materials);
    if (density === undefined) continue;
    densityBodies.push(property.id);
    densities.push(density);
  }
  const stats = rustBodyStatistics(
    points,
    Uint32Array.from(tets),
    CORNERS.CTETRA,
    Uint32Array.from(hexes),
    CORNERS.CHEXA,
    Uint32Array.from(facets),
    Float64Array.from(thicknesses),
    Uint32Array.from([...tetBodies, ...hexBodies, ...facetBodies]),
    Uint32Array.from(densityBodies),
    Float64Array.from(densities),
  );
  try {
    return Array.from({ length: stats.count }, (_, i) => ({
      body: stats.body(i),
      meanEdgeLength: stats.meanEdgeLength(i),
      volume: stats.volume(i),
      mass: stats.mass(i) ?? null,
    }));
  } finally {
    stats.free();
  }
}
