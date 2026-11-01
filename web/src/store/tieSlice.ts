// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Tie slice: bonded connections between two picked surfaces (see lib/tie.ts).
// A tie has no derived flat array: the weld it describes is applied to the mesh
// at solve time (buildTie), and drawn from the same definition in the viewport
// (tiedNodePairs).

import type { SliceCreator } from "./modelStore";
import type { TieDefinition, TieExtent } from "../lib/tie";
import { faceEntry, type BcFaceEntry } from "./boundaryGroups";

// A bonded tie between two picked surfaces — the connector condition that
// replaced the model-wide "tie distance" (see lib/tie.ts). `extent` says whether
// the whole selected surface is coupled or only the part of it within
// `searchDistance` of the other side.
export interface TieGroup extends TieDefinition {
  id: number;
  name: string; // e.g. "Tie1"
  facesA: BcFaceEntry[];
  facesB: BcFaceEntry[];
  extent: TieExtent;
  searchDistance: number;
}

// Which surface of a tie a pick session is currently filling.
export type TieSide = "a" | "b";

// Default search distance (mm) offered for a region tie. A contact patch is a
// property of the assembly, so there is no right number — this is only the
// starting value in the form, which the user edits before applying.
export const DEFAULT_TIE_DISTANCE = 0.5;

// The face list of one side of a tie.
export function tieFaces(group: TieGroup, side: TieSide): BcFaceEntry[] {
  return side === "a" ? group.facesA : group.facesB;
}

export interface TieSlice {
  tieGroups: TieGroup[];
  nextTieGroupId: number;

  createTieGroup(
    facesA: Omit<BcFaceEntry, "id">[],
    facesB: Omit<BcFaceEntry, "id">[],
    extent: TieExtent,
    searchDistance: number,
  ): void;
  addFaceToTieGroup(
    groupId: number,
    side: TieSide,
    face: Omit<BcFaceEntry, "id">,
  ): void;
  updateTieGroup(id: number, extent: TieExtent, searchDistance: number): void;
  removeFaceFromTieGroup(groupId: number, side: TieSide, faceId: number): void;
  deleteTieGroup(id: number): void;
  clearTies(): void;
}

export const createTieSlice: SliceCreator<TieSlice> = (set) => ({
  tieGroups: [],
  nextTieGroupId: 1,

  createTieGroup: (
    facesA: Omit<BcFaceEntry, "id">[],
    facesB: Omit<BcFaceEntry, "id">[],
    extent: TieExtent,
    searchDistance: number,
  ) =>
    set((s) => {
      const entries = (faces: Omit<BcFaceEntry, "id">[]) =>
        faces.map((face) => faceEntry(face, () => s.nextFaceEntryId++));
      s.tieGroups.push({
        id: s.nextTieGroupId,
        name: `Tie${s.nextTieGroupId}`,
        facesA: entries(facesA),
        facesB: entries(facesB),
        extent,
        searchDistance,
      });
      s.nextTieGroupId++;
      s.result = null;
    }),

  addFaceToTieGroup: (
    groupId: number,
    side: TieSide,
    face: Omit<BcFaceEntry, "id">,
  ) =>
    set((s) => {
      const group = s.tieGroups.find((tie) => tie.id === groupId);
      if (!group) return;
      tieFaces(group, side).push(faceEntry(face, () => s.nextFaceEntryId++));
      s.result = null;
    }),

  updateTieGroup: (id: number, extent: TieExtent, searchDistance: number) =>
    set((s) => {
      const group = s.tieGroups.find((tie) => tie.id === id);
      if (!group) return;
      group.extent = extent;
      group.searchDistance = searchDistance;
      s.result = null;
    }),

  // Removing the last face of a side leaves a connection with nothing to tie
  // to, so the whole connection goes — mirroring how a BC group disappears with
  // its last face.
  removeFaceFromTieGroup: (groupId: number, side: TieSide, faceId: number) =>
    set((s) => {
      const group = s.tieGroups.find((tie) => tie.id === groupId);
      if (!group) return;
      const kept = tieFaces(group, side).filter((face) => face.id !== faceId);
      if (side === "a") group.facesA = kept;
      else group.facesB = kept;
      if (kept.length === 0)
        s.tieGroups = s.tieGroups.filter((tie) => tie.id !== groupId);
      s.result = null;
    }),

  deleteTieGroup: (id: number) =>
    set((s) => {
      s.tieGroups = s.tieGroups.filter((tie) => tie.id !== id);
      s.result = null;
    }),

  clearTies: () =>
    set((s) => {
      s.tieGroups = [];
      s.result = null;
    }),
});
