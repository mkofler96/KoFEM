// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Linear elements lock when the material is nearly incompressible: with ν
// close to ½ every element must keep its volume, so the mesh comes out far too
// stiff, and refining it helps only slowly. On the nearly incompressible
// Cook's membrane (ν = 0.4999) linear tetrahedra are 43 % too stiff where
// quadratic ones are within 0.4 % (KOF-400,
// /examples/cooks-membrane-incompressible/). This names the solid bodies at
// risk so the pre-flight can warn.

import type { Element, Material, Property } from "../../workers/solverTypes.js";

// Above this Poisson's ratio λ/μ exceeds 9 and linear elements stiffen
// noticeably; rubber and other elastomers sit at 0.49 and above.
export const INCOMPRESSIBLE_POISSON = 0.45;

export interface IncompressibleFinding {
  bodyId: number;
  poisson: number;
}

export interface IncompressibleCheckInput {
  elements: Element[];
  properties: Property[];
  materials: Material[];
  elementOrder: number;
}

// The meshed solid bodies on linear elements whose material has ν above
// INCOMPRESSIBLE_POISSON. Empty for a quadratic mesh. A body whose material is
// gone is left to the materials check, which already refuses the solve.
export function incompressibleFindings(
  input: IncompressibleCheckInput,
): IncompressibleFinding[] {
  if (input.elementOrder !== 1) return [];
  const solidBodies = new Set(
    input.elements.filter((e) => e.type !== "CTRIA3").map((e) => e.propertyId),
  );
  const materialById = new Map(input.materials.map((m) => [m.id, m]));
  const findings: IncompressibleFinding[] = [];
  for (const property of input.properties) {
    if (property.suppressed || property.discretization === "shell") continue;
    if (!solidBodies.has(property.id)) continue;
    const material = materialById.get(property.materialId);
    if (material === undefined) continue;
    if (material.poisson > INCOMPRESSIBLE_POISSON)
      findings.push({ bodyId: property.id, poisson: material.poisson });
  }
  return findings;
}

export function incompressibleMessage(finding: IncompressibleFinding): string {
  return (
    `Nearly incompressible material on body ${finding.bodyId} (ν = ${finding.poisson}): ` +
    "linear elements lock and give results far too stiff. " +
    "Use quadratic elements (Mesh panel)."
  );
}
