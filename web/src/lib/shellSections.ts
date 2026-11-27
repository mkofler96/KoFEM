// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The shell sections (PSHELL properties) of a meshed Shell body: one per body
// and wall thickness, inheriting the body's material. Both ways a Shell body
// is meshed build them here: the CAD mid-surface (lib/cadShell.ts, KOF-498)
// and the mesh-based idealisation (lib/solve/autoShell.ts).

import type { Property } from "../workers/solverTypes.js";
import { tr } from "../i18n/useLocale.js";
import { refusalMessages } from "../i18n/messages/refusals.js";

export interface ShellSections {
  // The CAD bodies' own properties, then one PSHELL per section.
  properties: Property[];
  // The thicknesses that have a PSHELL, ascending (mm).
  thicknesses: number[];
  // The PSHELL id of a body's wall of `thickness`.
  propertyOf: (body: number, thickness: number) => number;
}

// Thicknesses equal to a micrometre share one section.
const thicknessKey = (thickness: number): number =>
  Number(thickness.toFixed(6));

// The material of a body marked Shell, which its PSHELLs inherit. A body
// missing from the property table has none to give (KOF-413).
export function shellBodyMaterial(
  cadBodies: Property[],
  bodyId: number,
): number {
  const prop = cadBodies.find((p) => p.id === bodyId);
  if (!prop) throw new Error(tr(refusalMessages).shellBodyNoMaterial(bodyId));
  return prop.materialId;
}

// The CAD bodies keep their own ids, so material assignments survive a mesh.
// The PSHELLs of an earlier mesh are dropped: they describe walls that no
// longer exist, and carrying them over made every re-mesh append another dead
// body to the list.
export function shellSections(
  properties: Property[],
  sections: Iterable<{ body: number; thickness: number }>,
): ShellSections {
  const cadBodies = properties.filter((p) => p.sourceBodyId === undefined);
  const nextId = cadBodies.reduce((mx, p) => Math.max(mx, p.id), 0) + 1;
  const out: Property[] = cadBodies.map((p) => ({ ...p }));
  const idOf = new Map<string, number>();
  const thicknesses = new Set<number>();
  for (const { body, thickness } of sections) {
    const key = thicknessKey(thickness);
    const section = `${body}:${key}`;
    if (idOf.has(section)) continue;
    const id = nextId + idOf.size;
    idOf.set(section, id);
    thicknesses.add(key);
    out.push({
      id,
      materialId: shellBodyMaterial(cadBodies, body),
      thickness: key,
      discretization: "shell",
      sourceBodyId: body,
    });
  }
  return {
    properties: out,
    thicknesses: [...thicknesses].sort((a, b) => a - b),
    propertyOf: (body, thickness) => {
      const id = idOf.get(`${body}:${thicknessKey(thickness)}`);
      if (id === undefined)
        throw new Error(
          `shell section: body ${body} has no PSHELL of thickness ${thickness} mm`,
        );
      return id;
    },
  };
}
