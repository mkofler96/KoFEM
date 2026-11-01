// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Boundary slice: the named BC and load groups (the primary source of truth for
// supports and loads) and the flat constraint/load arrays derived from them for
// the solver. The group model lives in boundaryGroups, the derivation in
// boundaryRebuild; ties, couplings and the face-pick session have their own
// slices (tieSlice, couplingSlice, pickSlice).

import type { SliceCreator } from "./modelStore";
import type { Element, Node } from "./geometrySlice";
import type { CouplingGroup } from "./couplingSlice";
import {
  faceEntry,
  summarizeComponents,
  type BcFaceEntry,
  type LoadKind,
  type NamedBcGroup,
  type NamedLoadGroup,
} from "./boundaryGroups";
import {
  rebuildConstraints,
  rebuildLoads,
  rebuildSurfaceLoads,
  type Constraint,
  type Load,
  type SurfaceLoad,
} from "./boundaryRebuild";

export interface BoundarySlice {
  // flat arrays derived from bcGroups / loadGroups — used by solver and visualization
  constraints: Constraint[];
  loads: Load[];
  // work-equivalent surface tractions (force/pressure groups) handed to the solver
  surfaceLoads: SurfaceLoad[];

  bcGroups: NamedBcGroup[];
  loadGroups: NamedLoadGroup[];
  nextBcGroupId: number;
  nextLoadGroupId: number;
  // Shared by every group type (BC, load, tie, coupling), so face entry ids
  // are unique across the whole model.
  nextFaceEntryId: number;

  // BC group actions
  createBcGroup(
    faces: Omit<BcFaceEntry, "id">[],
    dofs: number[],
    value: number,
  ): void;
  addFaceToBcGroup(groupId: number, face: Omit<BcFaceEntry, "id">): void;
  updateBcGroup(id: number, dofs: number[], value: number): void;
  removeFaceFromBcGroup(groupId: number, faceId: number): void;
  deleteBcGroup(id: number): void;
  clearConstraints(): void;

  // Load group actions
  createLoadGroup(
    faces: Omit<BcFaceEntry, "id">[],
    dof: number,
    totalForce: number,
    kind?: LoadKind,
    components?: [number, number, number],
  ): void;
  addFaceToLoadGroup(groupId: number, face: Omit<BcFaceEntry, "id">): void;
  updateLoadGroup(
    id: number,
    kind: LoadKind,
    totalForce: number,
    components?: [number, number, number],
  ): void;
  removeFaceFromLoadGroup(groupId: number, faceId: number): void;
  deleteLoadGroup(id: number): void;
  clearLoads(): void;
}

// Both load arrays, rebuilt together after any change to the load groups: a
// group's faces are split between them (rebuildLoads takes the nodal ones,
// rebuildSurfaceLoads the rest), so rebuilding only one would apply part of a
// group twice or not at all.
function rebuildAllLoads(s: {
  loadGroups: NamedLoadGroup[];
  nodes: Node[];
  elements: Element[];
  couplingGroups: CouplingGroup[];
  loads: Load[];
  surfaceLoads: SurfaceLoad[];
}): void {
  s.loads = rebuildLoads(s.loadGroups, s.nodes, s.couplingGroups);
  s.surfaceLoads = rebuildSurfaceLoads(
    s.loadGroups,
    s.elements,
    s.couplingGroups,
  );
}

export const createBoundarySlice: SliceCreator<BoundarySlice> = (set) => ({
  constraints: [],
  loads: [],
  surfaceLoads: [],
  bcGroups: [],
  loadGroups: [],
  nextBcGroupId: 1,
  nextLoadGroupId: 1,
  nextFaceEntryId: 1,

  // BC group actions
  createBcGroup: (
    faces: Omit<BcFaceEntry, "id">[],
    dofs: number[],
    value: number,
  ) =>
    set((s) => {
      const faceEntries = faces.map((f) =>
        faceEntry(f, () => s.nextFaceEntryId++),
      );
      s.bcGroups.push({
        id: s.nextBcGroupId,
        name: `BC${s.nextBcGroupId}`,
        dofs,
        value,
        faces: faceEntries,
      });
      s.nextBcGroupId++;
      s.constraints = rebuildConstraints(s.bcGroups);
      s.result = null;
    }),

  addFaceToBcGroup: (groupId: number, face: Omit<BcFaceEntry, "id">) =>
    set((s) => {
      const group = s.bcGroups.find((g) => g.id === groupId);
      if (!group) return;
      group.faces.push(faceEntry(face, () => s.nextFaceEntryId++));
      s.constraints = rebuildConstraints(s.bcGroups);
      s.result = null;
    }),

  updateBcGroup: (id: number, dofs: number[], value: number) =>
    set((s) => {
      const group = s.bcGroups.find((g) => g.id === id);
      if (!group) return;
      group.dofs = dofs;
      group.value = value;
      s.constraints = rebuildConstraints(s.bcGroups);
      s.result = null;
    }),

  removeFaceFromBcGroup: (groupId: number, faceId: number) =>
    set((s) => {
      const group = s.bcGroups.find((g) => g.id === groupId);
      if (!group) return;
      group.faces = group.faces.filter((f) => f.id !== faceId);
      if (group.faces.length === 0)
        s.bcGroups = s.bcGroups.filter((g) => g.id !== groupId);
      s.constraints = rebuildConstraints(s.bcGroups);
      s.result = null;
    }),

  deleteBcGroup: (id: number) =>
    set((s) => {
      s.bcGroups = s.bcGroups.filter((g) => g.id !== id);
      s.constraints = rebuildConstraints(s.bcGroups);
      s.result = null;
    }),

  clearConstraints: () =>
    set((s) => {
      s.bcGroups = [];
      s.constraints = [];
      s.result = null;
    }),

  // Load group actions
  createLoadGroup: (
    faces: Omit<BcFaceEntry, "id">[],
    dofArg: number,
    totalForceArg: number,
    kind: LoadKind = dofArg <= 2 ? "force" : "moment",
    components?: [number, number, number],
  ) =>
    set((s) => {
      const faceEntries = faces.map((f) =>
        faceEntry(f, () => s.nextFaceEntryId++),
      );
      // A componentwise force/moment carries its vector in `components` (the
      // source of truth); dof/totalForce are derived as a legacy summary.
      const { dof, totalForce } = components
        ? summarizeComponents(components, kind)
        : { dof: dofArg, totalForce: totalForceArg };
      s.loadGroups.push({
        id: s.nextLoadGroupId,
        name: `Load${s.nextLoadGroupId}`,
        dof,
        totalForce,
        ...(components ? { components } : {}),
        faces: faceEntries,
        kind,
      });
      s.nextLoadGroupId++;
      rebuildAllLoads(s);
      s.result = null;
    }),

  addFaceToLoadGroup: (groupId: number, face: Omit<BcFaceEntry, "id">) =>
    set((s) => {
      const group = s.loadGroups.find((g) => g.id === groupId);
      if (!group) return;
      group.faces.push(faceEntry(face, () => s.nextFaceEntryId++));
      rebuildAllLoads(s);
      s.result = null;
    }),

  // Replace a load group's values in place, keeping its faces. Mirrors
  // createLoadGroup: force/moment carry their vector in `components` (the
  // source of truth, with dof/totalForce derived as the legacy summary);
  // pressure carries its magnitude in totalForce and has no vector.
  updateLoadGroup: (
    id: number,
    kind: LoadKind,
    totalForceArg: number,
    components?: [number, number, number],
  ) =>
    set((s) => {
      const group = s.loadGroups.find((g) => g.id === id);
      if (!group) return;
      const { dof, totalForce } = components
        ? summarizeComponents(components, kind)
        : { dof: 0, totalForce: totalForceArg };
      group.kind = kind;
      group.dof = dof;
      group.totalForce = totalForce;
      if (components) group.components = components;
      else delete group.components;
      rebuildAllLoads(s);
      s.result = null;
    }),

  removeFaceFromLoadGroup: (groupId: number, faceId: number) =>
    set((s) => {
      const group = s.loadGroups.find((g) => g.id === groupId);
      if (!group) return;
      group.faces = group.faces.filter((f) => f.id !== faceId);
      if (group.faces.length === 0)
        s.loadGroups = s.loadGroups.filter((g) => g.id !== groupId);
      rebuildAllLoads(s);
      s.result = null;
    }),

  deleteLoadGroup: (id: number) =>
    set((s) => {
      s.loadGroups = s.loadGroups.filter((g) => g.id !== id);
      rebuildAllLoads(s);
      s.result = null;
    }),

  clearLoads: () =>
    set((s) => {
      s.loadGroups = [];
      s.loads = [];
      s.surfaceLoads = [];
      s.result = null;
    }),
});
