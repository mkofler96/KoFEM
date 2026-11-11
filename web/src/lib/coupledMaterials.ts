// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Element, Material, Property } from "../workers/solverTypes.js";

function materialResolver(materials: Material[], properties: Property[]) {
  const propertyById = new Map(
    properties.map((property) => [property.id, property]),
  );
  const materialById = new Map(
    materials.map((material) => [material.id, material]),
  );
  return (propertyId: number, context: string): Material => {
    const property = propertyById.get(propertyId);
    if (!property)
      throw new Error(
        `${context}: body ${propertyId} has no property — the model is inconsistent`,
      );
    const material = materialById.get(property.materialId);
    if (!material)
      throw new Error(
        `${context}: property ${propertyId} references material ${property.materialId}, which does not exist`,
      );
    return material;
  };
}

function singleDomainMaterial(
  materials: Material[],
  domain: "solid" | "shell",
): Material {
  const distinct = new Map(
    materials.map((material) => [material.id, material]),
  );
  if (distinct.size === 0)
    throw new Error(`coupled solve: the model has no ${domain} material`);
  if (distinct.size > 1) {
    const names = [...distinct.values()]
      .map((material) => material.name)
      .join(", ");
    throw new Error(
      `coupled solve: this path supports only one ${domain} material, but the ${domain} domain spans ` +
        `${distinct.size} distinct materials (${names}). Assign a single material to the ${domain} domain.`,
    );
  }
  return [...distinct.values()][0];
}

function engineMaterial(material: Material) {
  return { young_modulus: material.young, poisson_ratio: material.poisson };
}

// The legacy thin-wall path still supplies one material per domain.
export function coupledMaterials(
  materials: Material[],
  properties: Property[],
  shellBody: number,
  solidBodyIds: number[],
) {
  const resolve = materialResolver(materials, properties);
  const shell = singleDomainMaterial(
    [resolve(shellBody, "coupled shell")],
    "shell",
  );
  const solid = singleDomainMaterial(
    solidBodyIds.map((id) => resolve(id, "coupled solid")),
    "solid",
  );
  return { solid: engineMaterial(solid), shell: engineMaterial(shell) };
}

// The distinct materials a domain's elements use (in first-use order) plus one
// 1-based index into them per element — the engine's attributes contract.
function domainMaterials(
  elements: Element[],
  resolve: (propertyId: number, context: string) => Material,
  context: string,
) {
  const order: Material[] = [];
  const indexById = new Map<number, number>();
  const attributes = elements.map((element) => {
    const material = resolve(
      element.propertyId,
      `${context} element ${element.id}`,
    );
    let index = indexById.get(material.id);
    if (index === undefined) {
      index = order.push(material);
      indexById.set(material.id, index);
    }
    return index;
  });
  return { order, attributes };
}

// Explicit mixed models select materials with 1-based attributes: one per tet
// into `mat.solid` and one per shell facet into `mat.shell`, so each body keeps
// its own material in both domains. Pure-solid RBE2/RBE3 models have no shell
// facets, so the engine's unused shell material comes from the solid.
export function mixedCoupledMaterials(
  materials: Material[],
  properties: Property[],
  shellElements: Element[],
  solidElements: Element[],
) {
  const resolve = materialResolver(materials, properties);
  if (solidElements.length === 0)
    throw new Error("mixed solve: the model has no solid element");
  const solid = domainMaterials(solidElements, resolve, "mixed solve: solid");
  const shell = domainMaterials(shellElements, resolve, "mixed solve: shell");
  return {
    mat: {
      solid: solid.order.map(engineMaterial),
      shell:
        shellElements.length === 0
          ? [engineMaterial(solid.order[0])]
          : shell.order.map(engineMaterial),
    },
    solidAttributes: solid.attributes,
    shellAttributes: shell.attributes,
    solidMaterialNames: solid.order.map((material) => material.name),
    shellMaterialNames: shell.order.map((material) => material.name),
  };
}
