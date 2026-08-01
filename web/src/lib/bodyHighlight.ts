// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Resolving a hovered Bodies-panel row to the CAD body the geometry view can
// actually highlight.
//
// The rows are PROPERTIES, and after a mesh-time shell idealisation not every
// property is a CAD body: buildMeshTimeShellModel emits one PSHELL per wall
// thickness, each with a fresh id the STEP tessellation knows nothing about.
// Highlighting is expressed as "dim every body except this one", so an id no
// tessellated body carries dims the whole assembly to 15 % opacity — the model
// appears to vanish. A PSHELL therefore resolves back to the CAD body it was
// idealised from (Property.sourceBodyId), and anything still unmatched — a
// mesh with no CAD geometry behind it, e.g. an imported .vtu — resolves to
// nothing, leaving the viewport as it was.

import type { Property, StepTessellation } from "../store/geometrySlice";

// Body ids the tessellation actually draws.
export function tessellationBodyIds(
  tessellation: StepTessellation | null,
): Set<number> {
  if (!tessellation || tessellation.triangles.length === 0) return new Set();
  // Analyses saved before per-body ids carry the whole tessellation as body 1
  // (see StepTessellation.bodyIds).
  if (!tessellation.bodyIds) return new Set([1]);
  return new Set(tessellation.bodyIds);
}

// The CAD body to highlight for a hovered property id, or null when the
// geometry view has nothing to highlight for it.
export function resolveHighlightedBody(
  highlightBodyId: number | null,
  properties: Property[],
  tessellation: StepTessellation | null,
): number | null {
  if (highlightBodyId === null) return null;
  const drawn = tessellationBodyIds(tessellation);
  if (drawn.size === 0) return null;
  // sourceBodyId marks a derived PSHELL; a property without one IS a CAD body,
  // so its own id already is the body id.
  const prop = properties.find((p) => p.id === highlightBodyId);
  const bodyId = prop?.sourceBodyId ?? highlightBodyId;
  return drawn.has(bodyId) ? bodyId : null;
}
