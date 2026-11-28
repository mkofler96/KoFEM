// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The safety factor against yield (KOF-496), computed by the Rust module
// (crates/kofem-fem/src/safety_factor.rs), which must be loaded first.

import { safetyFactors as rustSafetyFactors } from "../wasm/fem/kofem_wasm.js";
import type {
  Element,
  Material,
  Node,
  Property,
  SolveRun,
} from "../store/modelStore";
import { packElements } from "./resultStatistics";
import { elementBodyName } from "./regions";

export const SAFETY_PERCENTILE = 0.99;

/** One safety factor row, as Results and the report list it. */
export interface SafetyFactorRow {
  // The body (element property) the row is taken over; null for the whole
  // model, which is of one material.
  propertyId: number | null;
  materialId: number;
  yieldStrength: number;
  maxVonMises: number;
  p99VonMises: number;
  maxFactor: number;
  p99Factor: number;
}

function materialIdOf(propertyId: number, properties: Property[]): number {
  const property = properties.find((p) => p.id === propertyId);
  if (!property)
    throw new Error(
      `Elements use property ${propertyId}, which the model does not have`,
    );
  return property.materialId;
}

/**
 * The safety factors of a result, from its von Mises stress per element (in
 * element order): one over the whole model of one material, else one per
 * body whose material has a yield strength. Empty when no material in use
 * has one.
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
  const bodies = [...new Set(elements.map((e) => e.propertyId))].sort(
    (a, b) => a - b,
  );
  const bodyIndex = new Map(bodies.map((id, i) => [id, i]));
  const withYield = materials.flatMap((m) =>
    m.yieldStrength === undefined ? [] : [{ id: m.id, yield: m.yieldStrength }],
  );
  const packed = packElements(nodes, elements, properties);
  const order = packed.familyOrder;
  const rows = rustSafetyFactors(
    packed.points,
    packed.tets,
    packed.tetNodes,
    packed.hexes,
    packed.shells,
    packed.thicknesses,
    Float64Array.from(order, (e) => vonMises[e]),
    Uint32Array.from(order, (e) => {
      const index = bodyIndex.get(elements[e].propertyId);
      if (index === undefined)
        throw new Error(`Element ${elements[e].id} has no body`);
      return index;
    }),
    Uint32Array.from(bodies, (id) => materialIdOf(id, properties)),
    Uint32Array.from(withYield, (m) => m.id),
    Float64Array.from(withYield, (m) => m.yield),
    SAFETY_PERCENTILE,
  );
  try {
    const bodyOfRow = rows.bodies;
    const materialIds = rows.materials;
    const yields = rows.yieldStrengths;
    const max = rows.max;
    const quantile = rows.quantile;
    const maxFactors = rows.maxFactors;
    const quantileFactors = rows.quantileFactors;
    const wholeModel = rows.wholeModel;
    return Array.from(materialIds, (materialId, i) => ({
      propertyId: wholeModel ? null : bodies[bodyOfRow[i]],
      materialId,
      yieldStrength: yields[i],
      maxVonMises: max[i],
      p99VonMises: quantile[i],
      maxFactor: maxFactors[i],
      p99Factor: quantileFactors[i],
    }));
  } finally {
    rows.free();
  }
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

/** A safety factor as Results and the report print it. */
export const formatSafetyFactor = (factor: number): string =>
  Number.isFinite(factor) ? factor.toPrecision(3) : "∞";

/**
 * What a row is taken over: the material and its yield strength, after the
 * body for a row of one body.
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
  const label = `${material.name}, ${row.yieldStrength} MPa`;
  if (row.propertyId === null) return label;
  const property = properties.find((p) => p.id === row.propertyId);
  if (!property)
    throw new Error(
      `A safety factor row names property ${row.propertyId}, which the model does not have`,
    );
  return `${elementBodyName(properties, property)} · ${label}`;
}
