// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The safety factor against yield (KOF-496): a material's yield strength over
// the von Mises stress, against both the max and the 99th percentile by
// volume. A model of one material gets one factor over the whole model, read
// from the field Results plots. A model of several gets one per body whose
// material has a yield strength, each from its own elements averaged to the
// nodes, so a stiff body's stress does not leak into a soft neighbour at the
// nodes they share. Without a yield strength there is no factor. The
// percentile comes from the Rust module, which must be loaded first.

import type { Element, Material, Node, Property } from "../store/modelStore";
import { nodeAveraged } from "./resultField";
import { fieldPercentiles } from "./resultStatistics";
import { elementBodyName } from "./regions";
import { tr } from "../i18n/useLocale";
import { reportMessages } from "../i18n/messages/report";

/** The share of the volume the percentile factor is taken at. */
export const SAFETY_PERCENTILE = 0.99;

/** The yield strength over the stress; infinite where nothing is stressed. */
export function safetyFactor(yieldStrength: number, stress: number): number {
  if (!Number.isFinite(yieldStrength) || yieldStrength <= 0)
    throw new Error(
      `A yield strength must be a positive number, got ${yieldStrength}`,
    );
  if (!Number.isFinite(stress) || stress < 0)
    throw new Error(
      `A von Mises stress must be a non-negative number, got ${stress}`,
    );
  return stress === 0 ? Number.POSITIVE_INFINITY : yieldStrength / stress;
}

/** The elements one safety factor is taken over. */
export interface SafetyGroup {
  // The body (element property) the group is; null for the whole model.
  propertyId: number | null;
  materialId: number;
  yieldStrength: number;
  // Indices into the element array, in element order.
  elements: number[];
}

function materialOf(
  propertyId: number,
  properties: Property[],
  materials: Material[],
): Material {
  const property = properties.find((p) => p.id === propertyId);
  if (!property)
    throw new Error(
      `Elements use property ${propertyId}, which the model does not have`,
    );
  const material = materials.find((m) => m.id === property.materialId);
  if (!material)
    throw new Error(
      `Property ${propertyId} uses material ${property.materialId}, which the model does not have`,
    );
  return material;
}

/**
 * The groups of elements a safety factor is taken over: the whole model when
 * every element is of one material, else each body whose material has a
 * yield strength, in property-id order. Empty when no material in use has one.
 */
export function safetyGroups(
  elements: Element[],
  properties: Property[],
  materials: Material[],
): SafetyGroup[] {
  const byProperty = new Map<number, number[]>();
  elements.forEach((element, i) => {
    const list = byProperty.get(element.propertyId);
    if (list) list.push(i);
    else byProperty.set(element.propertyId, [i]);
  });
  const bodies = [...byProperty.entries()]
    .sort(([a], [b]) => a - b)
    .map(([propertyId, indices]) => ({
      propertyId,
      material: materialOf(propertyId, properties, materials),
      elements: indices,
    }));
  const used = new Set(bodies.map((b) => b.material.id));
  if (used.size === 1) {
    const { id, yieldStrength } = bodies[0].material;
    if (yieldStrength === undefined) return [];
    return [
      {
        propertyId: null,
        materialId: id,
        yieldStrength,
        elements: elements.map((_, i) => i),
      },
    ];
  }
  return bodies.flatMap(({ propertyId, material, elements: indices }) =>
    material.yieldStrength === undefined
      ? []
      : [
          {
            propertyId,
            materialId: material.id,
            yieldStrength: material.yieldStrength,
            elements: indices,
          },
        ],
  );
}

/** One safety factor row, as Results and the report list it. */
export interface SafetyFactorRow {
  propertyId: number | null;
  materialId: number;
  yieldStrength: number;
  maxVonMises: number;
  p99VonMises: number;
  maxFactor: number;
  p99Factor: number;
}

/**
 * The safety factors of a result, from its von Mises stress per element (in
 * element order); empty when no material in use has a yield strength.
 */
export function safetyFactors(
  vonMises: Float64Array,
  nodes: Node[],
  elements: Element[],
  properties: Property[],
  materials: Material[],
): SafetyFactorRow[] {
  if (vonMises.length !== elements.length)
    throw new Error(
      `The von Mises result carries ${vonMises.length} values for ${elements.length} elements: it belongs to a different mesh`,
    );
  const nodeIndex = new Map<number, number>();
  nodes.forEach((node, i) => nodeIndex.set(node.id, i));
  return safetyGroups(elements, properties, materials).map((group) => {
    const own = group.elements.map((i) => elements[i]);
    const values = nodeAveraged((k) => vonMises[group.elements[k]], nodes, own);
    let maxVonMises = 0;
    for (const element of own)
      for (const id of element.nodeIds) {
        const i = nodeIndex.get(id);
        if (i === undefined)
          throw new Error(
            `Element ${element.id} uses node ${id}, which the mesh does not have`,
          );
        maxVonMises = Math.max(maxVonMises, values[i]);
      }
    const [p99VonMises] = fieldPercentiles(values, nodes, own, properties, [
      SAFETY_PERCENTILE,
    ]);
    const { yieldStrength } = group;
    return {
      propertyId: group.propertyId,
      materialId: group.materialId,
      yieldStrength,
      maxVonMises,
      p99VonMises,
      maxFactor: safetyFactor(yieldStrength, maxVonMises),
      p99Factor: safetyFactor(yieldStrength, p99VonMises),
    };
  });
}

/**
 * What a row is taken over, as Results and the report name it: the material
 * and its yield strength, after the body for a row of one body.
 */
export function safetyRowLabel(
  row: SafetyFactorRow,
  properties: Property[],
  materials: Material[],
): string {
  const material = materials.find((m) => m.id === row.materialId);
  if (!material)
    throw new Error(
      `A safety factor row names material ${row.materialId}, which the model does not have`,
    );
  const label = tr(reportMessages).safetyMaterial(
    material.name,
    String(row.yieldStrength),
  );
  if (row.propertyId === null) return label;
  const property = properties.find((p) => p.id === row.propertyId);
  if (!property)
    throw new Error(
      `A safety factor row names property ${row.propertyId}, which the model does not have`,
    );
  return `${elementBodyName(properties, property)} · ${label}`;
}
