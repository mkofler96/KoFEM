// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Contact slice: frictionless contacts between two picked surfaces (see
// lib/contact.ts, KOF-485). A contact has nothing to tune — no method, extent
// or distance: the solve finds where the surfaces touch. Its two surfaces are
// picked with the same two-sided pick session as a tie's (pickSlice).

import type { SliceCreator } from "./modelStore";
import type { ContactDefinition } from "../lib/contact";
import { faceEntry, type BcFaceEntry } from "./boundaryGroups";
import type { TieSide } from "./tieSlice";

export interface ContactGroup extends ContactDefinition {
  id: number;
  name: string; // e.g. "Contact1"
  facesA: BcFaceEntry[];
  facesB: BcFaceEntry[];
}

// The face list of one side of a contact.
export function contactFaces(
  group: ContactGroup,
  side: TieSide,
): BcFaceEntry[] {
  return side === "a" ? group.facesA : group.facesB;
}

export interface ContactSlice {
  contactGroups: ContactGroup[];
  nextContactGroupId: number;

  createContactGroup(
    facesA: Omit<BcFaceEntry, "id">[],
    facesB: Omit<BcFaceEntry, "id">[],
  ): void;
  addFaceToContactGroup(
    groupId: number,
    side: TieSide,
    face: Omit<BcFaceEntry, "id">,
  ): void;
  removeFaceFromContactGroup(
    groupId: number,
    side: TieSide,
    faceId: number,
  ): void;
  deleteContactGroup(id: number): void;
}

export const createContactSlice: SliceCreator<ContactSlice> = (set) => ({
  contactGroups: [],
  nextContactGroupId: 1,

  createContactGroup: (facesA, facesB) =>
    set((s) => {
      const entries = (faces: Omit<BcFaceEntry, "id">[]) =>
        faces.map((face) => faceEntry(face, () => s.nextFaceEntryId++));
      s.contactGroups.push({
        id: s.nextContactGroupId,
        name: `Contact${s.nextContactGroupId}`,
        facesA: entries(facesA),
        facesB: entries(facesB),
      });
      s.nextContactGroupId++;
      s.result = null;
    }),

  addFaceToContactGroup: (groupId, side, face) =>
    set((s) => {
      const group = s.contactGroups.find((contact) => contact.id === groupId);
      if (!group) return;
      contactFaces(group, side).push(
        faceEntry(face, () => s.nextFaceEntryId++),
      );
      s.result = null;
    }),

  // A contact needs both surfaces, so removing the last face of a side
  // removes the contact, as a tie goes with its last face.
  removeFaceFromContactGroup: (groupId, side, faceId) =>
    set((s) => {
      const group = s.contactGroups.find((contact) => contact.id === groupId);
      if (!group) return;
      const kept = contactFaces(group, side).filter(
        (face) => face.id !== faceId,
      );
      if (side === "a") group.facesA = kept;
      else group.facesB = kept;
      if (kept.length === 0)
        s.contactGroups = s.contactGroups.filter(
          (contact) => contact.id !== groupId,
        );
      s.result = null;
    }),

  deleteContactGroup: (id) =>
    set((s) => {
      s.contactGroups = s.contactGroups.filter((contact) => contact.id !== id);
      s.result = null;
    }),
});
