// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PickGeometry } from "./facePick";
import type { PickMode } from "../store/pickSlice";
import type { TreeGroup } from "../store/viewSlice";

// The store state that decides what the status bar is about.
export interface StatusPickState {
  pickMode: PickMode | null;
  pickGeometry: PickGeometry;
  selectedFace: { cadFaceId?: number } | null;
  faceSizePicking: boolean;
  faceSizePickIds: number[];
  splitPicking: boolean;
  splitFaceIds: number[];
}

/** True while a tool picks faces: a support, load, tie or coupling, a mesh
 *  face size, or a face split. */
export function isPicking(s: StatusPickState): boolean {
  return s.pickMode !== null || s.faceSizePicking || s.splitPicking;
}

/** The CAD face picked last by the tool that is picking, if any. */
export function pickedCadFaceId(s: StatusPickState): number | undefined {
  if (s.pickMode !== null)
    return s.pickGeometry === "face" ? s.selectedFace?.cadFaceId : undefined;
  if (s.faceSizePicking) return s.faceSizePickIds.at(-1);
  if (s.splitPicking) return s.splitFaceIds.at(-1);
  return undefined;
}

export interface ModelCounts {
  nodes: number;
  hexes: number;
  tets: number;
  fixedNodes: number;
  faceLoads: number;
  nodalLoadDofs: number;
}

export type CountKind = keyof ModelCounts;

const STEP_COUNTS: Record<TreeGroup, CountKind[]> = {
  geometry: [],
  materials: [],
  mesh: ["nodes", "hexes", "tets"],
  boundary: ["fixedNodes", "faceLoads", "nodalLoadDofs"],
  studies: [],
  results: [],
};

/** The non-zero counts the status bar shows on the step `group`. */
export function stepCounts(
  group: TreeGroup,
  counts: ModelCounts,
): { kind: CountKind; value: number }[] {
  return STEP_COUNTS[group]
    .filter((kind) => counts[kind] > 0)
    .map((kind) => ({ kind, value: counts[kind] }));
}
