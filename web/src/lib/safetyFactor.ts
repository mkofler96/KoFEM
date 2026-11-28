// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The safety factor against yield (KOF-496): a material's yield strength over
// the von Mises stress, against both the max and the 99th percentile by
// volume. A model of one material gets one factor over the whole model. A
// model of several gets one per body whose material has a yield strength,
// each from its own elements averaged to the nodes, so a stiff body's stress
// does not leak into a soft neighbour at the nodes they share. Without a
// yield strength there is no factor. The statistics come from the Rust
// module, which must be loaded first.

import type {
  Element,
  Material,
  Node,
  Property,
  SolveRun,
} from "../store/modelStore";
import { groupStatistics } from "./resultStatistics";
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
 * element order); empty when no material in use has a yield strength. Each
 * group's max and percentile come from the Rust module.
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
  const safety = safetyGroups(elements, properties, materials);
  if (safety.length === 0) return [];
  // Only the grouped elements: a body without a yield strength takes no part.
  const members = safety.flatMap((group) => group.elements);
  const groups = Uint32Array.from(
    safety.flatMap((group, g) => group.elements.map(() => g)),
  );
  const statistics = groupStatistics(
    Float64Array.from(members, (e) => vonMises[e]),
    groups,
    safety.length,
    SAFETY_PERCENTILE,
    nodes,
    members.map((e) => elements[e]),
    properties,
  );
  return safety.map((group, g) => {
    const { max, quantile } = statistics[g];
    return {
      propertyId: group.propertyId,
      materialId: group.materialId,
      yieldStrength: group.yieldStrength,
      maxVonMises: max,
      p99VonMises: quantile,
      maxFactor: safetyFactor(group.yieldStrength, max),
      p99Factor: safetyFactor(group.yieldStrength, quantile),
    };
  });
}

/**
 * The materials a result was solved with, each with its yield strength as it
 * is now: the stresses belong to the solve's material assignment, while a
 * yield strength set after the solve changes no stress and needs no new one.
 */
export function withCurrentYield(
  solved: Material[],
  current: Material[],
): Material[] {
  return solved.map((material) => {
    const now = current.find((m) => m.id === material.id);
    if (!now)
      throw new Error(
        `The result was solved with material ${material.id}, which the model no longer has: solve again`,
      );
    return { ...material, yieldStrength: now.yieldStrength };
  });
}

/**
 * The bodies and materials a result's safety factors are taken with: the
 * solve's, with each yield strength as it is now. A result loaded from a file
 * has no run; the file's own bodies and materials are the ones it was solved
 * with.
 */
export function safetyModel(
  run: SolveRun | undefined,
  properties: Property[],
  materials: Material[],
): { properties: Property[]; materials: Material[] } {
  if (run === undefined) return { properties, materials };
  return {
    properties: run.properties,
    materials: withCurrentYield(run.materials, materials),
  };
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
