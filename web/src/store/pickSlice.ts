// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pick slice: the viewport face-pick session used to build BC, load, tie and
// coupling groups — what is being picked, what a click selects, the faces
// gathered so far, and the drafts (a tie's parked side, a coupling's reference
// point) previewed before the form is applied.

import type { SliceCreator } from "./modelStore";
import type { PickGeometry } from "../lib/facePick";
import type { TieSide } from "./tieSlice";

export interface FaceSelection {
  nodeIds: number[];
  label: string; // e.g. "Min X face (9 nodes)"
  axis: "X" | "Y" | "Z";
  isMax: boolean;
  // The CAD face the pick selected whole — see BcFaceEntry.cadFaceId.
  cadFaceId?: number;
}

// What a pick session is being used to define. A coupling picks one surface,
// like a BC or a load; a tie picks two (pickTieSide selects which).
export type PickMode = "bc" | "load" | "tie" | "coupling";

export interface PickSlice {
  pickMode: PickMode | null;
  pickTargetGroupId: number | null; // null = creating new group; id = adding to existing
  // What a click selects: a surface region ("face"), the boundary polyline near
  // the click ("edge" — the only way to grab the rim of a flat shell, whose
  // whole sheet is a single face-pick region), or the single nearest node
  // ("point"). Reset to "face" on exit.
  pickGeometry: PickGeometry;
  selectedFace: FaceSelection | null;
  pendingFaces: FaceSelection[]; // faces accumulated via shift-click within a pick session

  // A tie connects TWO surfaces, so its pick session fills one side at a time:
  // `pickTieSide` is the side the viewport clicks land on, and `tieDraft` holds
  // the side that is parked (so the viewport can still show it, and switching
  // back restores it). Cleared when the pick session ends.
  pickTieSide: TieSide;
  tieDraft: { a: FaceSelection[]; b: FaceSelection[] };

  // The reference point currently being placed, and the nodes it would grip —
  // the coupling as it stands in a form that has not been applied yet. A
  // reference point is a position in space with nothing in the mesh to anchor it
  // to, so typing coordinates without seeing them is guesswork; the viewport
  // draws this the way it draws a committed coupling. Null whenever no coupling
  // form is open. The form that owns it supplies both fields, rather than the
  // viewport inferring the nodes from whichever session it thinks is live.
  couplingDraft: { point: [number, number, number]; nodeIds: number[] } | null;

  setPickMode(mode: PickMode | null, targetGroupId?: number | null): void;
  setPickGeometry(geometry: PickGeometry): void;
  setSelectedFace(face: FaceSelection | null): void;
  setPendingFaces(faces: FaceSelection[]): void;
  setPickTieSide(side: TieSide): void;
  setCouplingDraft(
    draft: { point: [number, number, number]; nodeIds: number[] } | null,
  ): void;
}

export const createPickSlice: SliceCreator<PickSlice> = (set) => ({
  pickMode: null,
  pickTargetGroupId: null,
  pickGeometry: "face",
  selectedFace: null,
  pendingFaces: [],
  pickTieSide: "a",
  tieDraft: { a: [], b: [] },
  couplingDraft: null,

  setPickMode: (mode: PickMode | null, targetGroupId: number | null = null) =>
    set((s) => {
      s.pickMode = mode;
      s.pickTargetGroupId = mode !== null ? (targetGroupId ?? null) : null;
      s.pickTieSide = "a";
      s.tieDraft = { a: [], b: [] };
      // Leaving the pick session abandons the coupling being placed with it, so
      // its preview must not outlive the form that owned it.
      s.couplingDraft = null;
      if (mode === null) {
        s.selectedFace = null;
        s.pendingFaces = [];
        s.pickGeometry = "face";
      }
    }),

  setCouplingDraft: (draft) =>
    set((s) => {
      s.couplingDraft = draft;
    }),

  // Park the side being picked and bring the other one into the live session,
  // so a tie's two surfaces are filled by the same face-pick machinery.
  setPickTieSide: (side: TieSide) =>
    set((s) => {
      if (s.pickTieSide === side) return;
      s.tieDraft[s.pickTieSide] = s.selectedFace
        ? [...s.pendingFaces, s.selectedFace]
        : s.pendingFaces;
      const restored = s.tieDraft[side];
      s.pendingFaces = restored.slice(0, -1);
      s.selectedFace =
        restored.length > 0 ? restored[restored.length - 1] : null;
      s.tieDraft[side] = [];
      s.pickTieSide = side;
    }),

  setPickGeometry: (geometry: PickGeometry) =>
    set((s) => {
      s.pickGeometry = geometry;
    }),

  setSelectedFace: (face: FaceSelection | null) =>
    set((s) => {
      s.selectedFace = face;
    }),

  setPendingFaces: (faces: FaceSelection[]) =>
    set((s) => {
      s.pendingFaces = faces;
    }),
});
