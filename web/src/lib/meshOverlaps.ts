// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MeshOverlap, RepairHingesOptions } from "../wasm/pkg/kofem_wasm";

// Wide enough that the repair's new faces are resolved at this element size.
const REPAIR_WIDTH_PER_ELEMENT = 1.5;

// The repair suggested for a mesh of this max element size (mm), as field text.
// Empty when the size isn't a number yet, so the field asks for one.
export function defaultRepairWidth(maxElementSize: string): string {
  const size = parseFloat(maxElementSize);
  if (!Number.isFinite(size) || size <= 0) return "";
  return String(Number((size * REPAIR_WIDTH_PER_ELEMENT).toPrecision(3)));
}

// The overlaps that can be repaired, as the engine takes them.
export function hingeRepairs(
  overlaps: MeshOverlap[],
): RepairHingesOptions["hinges"] {
  return overlaps.flatMap((overlap) =>
    overlap.hinge
      ? [
          {
            bodyId: overlap.bodyId,
            start: Array.from(overlap.hinge.start),
            end: Array.from(overlap.hinge.end),
            normal: Array.from(overlap.hinge.normal),
          },
        ]
      : [],
  );
}

// The faces of the cone overlaps, as the engine takes them: each once, since
// separate overlaps can lie on one face.
export function coneTipFaces(overlaps: MeshOverlap[]): number[] {
  return [
    ...new Set(
      overlaps.flatMap((overlap) =>
        overlap.kind === "cone" ? Array.from(overlap.faceIds) : [],
      ),
    ),
  ];
}
