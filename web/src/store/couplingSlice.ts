// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Coupling slice: surface-to-point couplings (see lib/coupling.ts) and the
// lifecycle of the reference-point node each one owns.

import type { SliceCreator } from "./modelStore";
import type { Element, Node } from "./geometrySlice";
import type { CouplingDefinition, CouplingKind } from "../lib/coupling";
import { ALL_DOFS } from "../lib/coupling";
import {
  faceEntry,
  type BcFaceEntry,
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

// A surface-to-point coupling — the picked surface, the reference point it is
// idealised to, and how the two are tied (see lib/coupling.ts).
//
// The reference point is a real node of the model: it is appended to `nodes`
// when the coupling is created and removed with it. That is what a reference
// point IS in a solver deck, and it means a BC or a load reaches it through
// exactly the machinery every other node uses — `refNodeId` in a face entry,
// nothing special anywhere downstream. The invariant it rests on: a node that
// belongs to no element exists only because a coupling created it, so deleting
// the coupling must delete the node (deleteCouplingGroup does).
export interface CouplingGroup extends CouplingDefinition {
  id: number;
  name: string; // e.g. "Coupling1"
  faces: BcFaceEntry[];
  // The reference point's position, mirrored from the node so the panel can
  // edit it without reaching into the mesh.
  point: [number, number, number];
}

export interface CouplingSlice {
  couplingGroups: CouplingGroup[];
  nextCouplingGroupId: number;

  // Creating a coupling also creates its reference point node; deleting one
  // removes that node again.
  createCouplingGroup(
    faces: Omit<BcFaceEntry, "id">[],
    point: [number, number, number],
    kind: CouplingKind,
    dofs: number[],
  ): void;
  addFaceToCouplingGroup(groupId: number, face: Omit<BcFaceEntry, "id">): void;
  updateCouplingGroup(
    id: number,
    kind: CouplingKind,
    dofs: number[],
    point: [number, number, number],
  ): void;
  removeFaceFromCouplingGroup(groupId: number, faceId: number): void;
  deleteCouplingGroup(id: number): void;
  clearCouplings(): void;
}

// The reference point is a NODE, created and destroyed with its coupling — see
// CouplingGroup.
export const createCouplingSlice: SliceCreator<CouplingSlice> = (set) => ({
  couplingGroups: [],
  nextCouplingGroupId: 1,

  createCouplingGroup: (
    faces: Omit<BcFaceEntry, "id">[],
    point: [number, number, number],
    kind: CouplingKind,
    dofs: number[],
  ) =>
    set((s) => {
      const refNodeId =
        s.nodes.reduce((highest, node) => Math.max(highest, node.id), -1) + 1;
      s.nodes.push({ id: refNodeId, x: point[0], y: point[1], z: point[2] });
      s.couplingGroups.push({
        id: s.nextCouplingGroupId,
        name: `Coupling${s.nextCouplingGroupId}`,
        kind,
        dofs: kind === "kinematic" ? dofs : ALL_DOFS,
        refNodeId,
        point,
        faces: faces.map((face) => faceEntry(face, () => s.nextFaceEntryId++)),
      });
      s.nextCouplingGroupId++;
      s.result = null;
    }),

  addFaceToCouplingGroup: (groupId: number, face: Omit<BcFaceEntry, "id">) =>
    set((s) => {
      const group = s.couplingGroups.find((c) => c.id === groupId);
      if (!group) return;
      group.faces.push(faceEntry(face, () => s.nextFaceEntryId++));
      s.result = null;
    }),

  updateCouplingGroup: (
    id: number,
    kind: CouplingKind,
    dofs: number[],
    point: [number, number, number],
  ) =>
    set((s) => {
      const group = s.couplingGroups.find((c) => c.id === id);
      if (!group) return;
      group.kind = kind;
      // A distributing coupling ties all six DOFs of its reference point by
      // construction — the mask is a kinematic-only control, so storing a
      // partial one would describe a constraint the solver does not apply.
      group.dofs = kind === "kinematic" ? dofs : ALL_DOFS;
      group.point = point;
      const refNode = s.nodes.find((node) => node.id === group.refNodeId);
      if (refNode) {
        refNode.x = point[0];
        refNode.y = point[1];
        refNode.z = point[2];
      }
      // Moving the point changes the lever arms of a moment applied to it.
      s.loads = rebuildLoads(s.loadGroups, s.nodes, s.couplingGroups);
      s.result = null;
    }),

  // A coupling with no surface grips nothing, so losing its last face removes
  // it — the same rule a BC group follows.
  removeFaceFromCouplingGroup: (groupId: number, faceId: number) =>
    set((s) => {
      const group = s.couplingGroups.find((c) => c.id === groupId);
      if (!group) return;
      group.faces = group.faces.filter((face) => face.id !== faceId);
      if (group.faces.length === 0) removeCoupling(s, groupId);
      s.result = null;
    }),

  deleteCouplingGroup: (id: number) =>
    set((s) => {
      removeCoupling(s, id);
      s.result = null;
    }),

  clearCouplings: () =>
    set((s) => {
      for (const group of [...s.couplingGroups]) removeCoupling(s, group.id);
      s.result = null;
    }),
});

// Drop a coupling and the reference point node it owns, together with the BCs
// and loads that were applied to that point. Leaving them behind would leave
// constraints on a node that no longer exists — and, because a reference point
// belongs to no element, a free node in the mesh that the all-solid solve would
// assemble into a singular system.
function removeCoupling(
  s: {
    couplingGroups: CouplingGroup[];
    bcGroups: NamedBcGroup[];
    loadGroups: NamedLoadGroup[];
    nodes: Node[];
    elements: Element[];
    constraints: Constraint[];
    loads: Load[];
    surfaceLoads: SurfaceLoad[];
  },
  id: number,
): void {
  const group = s.couplingGroups.find((c) => c.id === id);
  if (!group) return;
  s.couplingGroups = s.couplingGroups.filter((c) => c.id !== id);
  s.nodes = s.nodes.filter((node) => node.id !== group.refNodeId);

  const withoutPoint = <T extends { faces: BcFaceEntry[] }>(groups: T[]): T[] =>
    groups
      .map((g) => ({
        ...g,
        faces: g.faces.filter(
          (face) => !face.nodeIds.includes(group.refNodeId),
        ),
      }))
      .filter((g) => g.faces.length > 0);
  s.bcGroups = withoutPoint(s.bcGroups);
  s.loadGroups = withoutPoint(s.loadGroups);
  s.constraints = rebuildConstraints(s.bcGroups);
  s.loads = rebuildLoads(s.loadGroups, s.nodes, s.couplingGroups);
  s.surfaceLoads = rebuildSurfaceLoads(
    s.loadGroups,
    s.elements,
    s.couplingGroups,
  );
}
