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

// The faces the mesher gave up on, each once.
export function unmeshedFaces(overlaps: MeshOverlap[]): number[] {
  return [
    ...new Set(
      overlaps.flatMap((overlap) =>
        overlap.kind === "unmeshed" ? Array.from(overlap.faceIds) : [],
      ),
    ),
  ];
}

// The width (mm) of the narrowest face the mesher gave up on, or null if none.
export function narrowestUnmeshedWidth(overlaps: MeshOverlap[]): number | null {
  const widths = overlaps.flatMap((overlap) => {
    if (overlap.kind !== "unmeshed") return [];
    if (overlap.width === undefined)
      throw new Error(
        `unmeshed face ${Array.from(overlap.faceIds).join()} has no width`,
      );
    return [overlap.width];
  });
  return widths.length > 0 ? Math.min(...widths) : null;
}

// The boundary of a triangle soup (xyz of 3 corners per triangle) as line
// segments: every edge only one triangle has. An unmeshed face is often a
// sliver too narrow to see filled, so the view draws its outline on top.
export function soupOutline(positions: ArrayLike<number>): Float32Array {
  if (positions.length % 9 !== 0)
    throw new Error(
      `soupOutline: ${positions.length} coordinates are not whole triangles`,
    );
  const corner = (index: number): string =>
    `${positions[3 * index]},${positions[3 * index + 1]},${positions[3 * index + 2]}`;
  const uses = new Map<string, { a: number; b: number; count: number }>();
  for (let first = 0; first < positions.length / 3; first += 3)
    for (const [a, b] of [
      [first, first + 1],
      [first + 1, first + 2],
      [first + 2, first],
    ]) {
      const [ka, kb] = [corner(a), corner(b)];
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const entry = uses.get(key);
      if (entry) entry.count++;
      else uses.set(key, { a, b, count: 1 });
    }
  const out: number[] = [];
  for (const { a, b, count } of uses.values()) {
    if (count !== 1) continue;
    for (const index of [a, b])
      out.push(
        positions[3 * index],
        positions[3 * index + 1],
        positions[3 * index + 2],
      );
  }
  return new Float32Array(out);
}

// The unmeshed faces narrower than the minimum element size (mm, as field
// text): detail below what the mesh resolves anyway, so removing them is offered.
// A wider face failed because the elements are too coarse for it; removing it
// would change the part, so a smaller element size is the fix there.
export function removableUnmeshedFaces(
  overlaps: MeshOverlap[],
  minElementSize: string,
): number[] {
  const limit = parseFloat(minElementSize);
  if (!Number.isFinite(limit) || limit <= 0) return [];
  return [
    ...new Set(
      overlaps.flatMap((overlap) => {
        if (overlap.kind !== "unmeshed") return [];
        if (overlap.width === undefined)
          throw new Error(
            `unmeshed face ${Array.from(overlap.faceIds).join()} has no width`,
          );
        return overlap.width < limit ? Array.from(overlap.faceIds) : [];
      }),
    ),
  ];
}
