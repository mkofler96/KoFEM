// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A temperature change on a solid model (KOF-449): the expansion coefficient of
// every element and the temperature change at every node, as the Rust module's
// thermal load and thermal stress recovery take them.

import type {
  Element,
  Material,
  Property,
  TemperatureLoad,
} from "../../workers/solverTypes.js";

// The Rust module's formula evaluator: a value per node from xyz triples.
export type EvaluateField = (
  formula: string,
  coordinates: Float64Array,
) => Float64Array;

export interface ThermalInputs {
  // α per element, in the solve's element order (tets, then hexes), 1/°C.
  alpha: Float64Array;
  // ΔT per node of the solve mesh (vertices, then any edge nodes), °C.
  deltaT: Float64Array;
}

// α of every element, from its body's material. A material the temperature
// change reaches without an expansion coefficient is refused, naming it.
export function elementExpansion(
  elements: readonly Element[],
  materials: readonly Material[],
  properties: readonly Property[],
): Float64Array {
  const propertyById = new Map(properties.map((p) => [p.id, p]));
  const materialById = new Map(materials.map((m) => [m.id, m]));
  return Float64Array.from(elements, (element) => {
    const property = propertyById.get(element.propertyId);
    if (!property)
      throw new Error(
        `Element ${element.id} names property ${element.propertyId}, which the model does not have`,
      );
    const material = materialById.get(property.materialId);
    if (!material)
      throw new Error(
        `Property ${property.id} names material ${property.materialId}, which the model does not have`,
      );
    if (
      material.expansion === undefined ||
      !Number.isFinite(material.expansion)
    )
      throw new Error(
        `Material "${material.name}" has no thermal expansion coefficient: set α in its material to apply the temperature change.`,
      );
    return material.expansion;
  });
}

// The thermal inputs of a solid model: α per element in solve order, and the
// temperature formula evaluated at the solve mesh's nodes.
export function thermalInputs(
  evaluate: EvaluateField,
  temperature: TemperatureLoad,
  solveElements: readonly Element[],
  materials: readonly Material[],
  properties: readonly Property[],
  nodeCoordinates: Float64Array,
): ThermalInputs {
  const alpha = elementExpansion(solveElements, materials, properties);
  let deltaT: Float64Array;
  try {
    deltaT = evaluate(temperature.formula, nodeCoordinates);
  } catch (err) {
    throw new Error(
      `The temperature change "${temperature.formula}" cannot be evaluated: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { alpha, deltaT };
}
