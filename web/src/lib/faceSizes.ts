// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Element sizes on selected CAD faces (KOF-394). The user picks faces in the
// Mesh step and gives them a size; Netgen meshes each face at its size and
// grades the volume out to the body size. Face ids are the engine's 1-based
// CAD face indices, the ids the tessellation and the mesh report.

import type { FaceSize } from "../store/geometrySlice";
import { tr } from "../i18n/useLocale";
import { meshMessages } from "../i18n/messages/mesh";

// A face has one size: picking it again moves it to the new one.
export function assignFaceSize(
  entries: FaceSize[],
  faceIds: number[],
  size: string,
): FaceSize[] {
  if (faceIds.length === 0) throw new Error(tr(meshMessages).noFacePicked);
  const picked = new Set(faceIds);
  const kept = entries
    .map((e) => ({ ...e, faceIds: e.faceIds.filter((id) => !picked.has(id)) }))
    .filter((e) => e.faceIds.length > 0);
  return [...kept, { faceIds: [...picked].sort((a, b) => a - b), size }];
}

export function faceListLabel(faceIds: number[]): string {
  return tr(meshMessages).faceList(faceIds.length, faceIds.join(", "));
}

// Netgen applies the min element size everywhere, so a face size below it
// could not hold.
export function parseFaceSizes(
  entries: FaceSize[],
  min: number,
): Record<number, number> {
  const faces: Record<number, number> = {};
  for (const entry of entries) {
    const typed = entry.size.trim();
    const size = Number(typed);
    if (typed === "" || !Number.isFinite(size) || size <= 0)
      throw new Error(tr(meshMessages).faceSizeInvalid(typed));
    if (min > size)
      throw new Error(
        tr(meshMessages).minExceedsFaceSize(
          min,
          faceListLabel(entry.faceIds),
          size,
        ),
      );
    for (const id of entry.faceIds) faces[id] = size;
  }
  return faces;
}

// Text that is not a number never matches: meshing rejects it with its own
// message.
export function faceSizesMatch(
  entries: FaceSize[],
  meshed: Record<number, number>,
): boolean {
  const typed = new Map<number, number>();
  for (const entry of entries)
    for (const id of entry.faceIds) typed.set(id, Number(entry.size.trim()));
  const sized = Object.entries(meshed);
  return (
    typed.size === sized.length &&
    sized.every(([id, size]) => typed.get(Number(id)) === size)
  );
}
