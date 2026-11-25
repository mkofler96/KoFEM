// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Carrying supports, loads and ties over to a new mesh of the same geometry.
//
// A group entry is a node set, and node ids mean nothing on another mesh — so
// a re-mesh used to clear every group, and a finer mesh of a finished model
// came back with no supports and no loads. An entry picked as a whole CAD face
// remembers that face (BcFaceEntry.cadFaceId), and the new mesh says which of
// its surface triangles lie on which CAD face (surfaceFaceIds), so the entry is
// re-resolved to the new mesh's nodes of the same face. An Edge entry picked on
// the rim a shell collapsed a CAD face to (lib/shellRim) remembers that face
// too, and is re-resolved to the face's rim on the new mesh. A coupling's
// surface follows its CAD faces the same way; its reference point, a node that
// belongs to no element, is re-created on the new mesh at the coupling's point,
// and a support or load picked on the old point is re-pointed to the new one
// (KOF-422). Everything else is dropped and named, so the user knows exactly
// what to pick again:
//   - an edge or node pick, or a flood-fill face (no CAD face behind it)
//   - a face the new mesh does not have on its surface — e.g. a wall the mesh
//     idealised as a shell mid-surface since the pick
//   - a support or load on the reference point of a coupling that was dropped
// The geometry must be the one the entries were picked on: a geometry edit
// (split, import) renumbers the CAD faces and clears the groups itself.

import type {
  BcFaceEntry,
  NamedBcGroup,
  NamedLoadGroup,
} from "../store/boundaryGroups";
import type { CouplingGroup } from "../store/couplingSlice";
import type { Node } from "../store/geometrySlice";
import type { TieGroup } from "../store/tieSlice";
import { tr } from "../i18n/useLocale";
import { meshMessages } from "../i18n/messages/mesh";

export interface CarriedGroups {
  bcGroups: NamedBcGroup[];
  loadGroups: NamedLoadGroup[];
  tieGroups: TieGroup[];
  couplingGroups: CouplingGroup[];
  // The reference point node of each carried coupling, numbered after the new
  // mesh's nodes: the caller appends them to the mesh.
  referenceNodes: Node[];
  // Entries re-resolved on the new mesh.
  kept: number;
  // One line per entry, group or coupling that could not be carried.
  dropped: string[];
}

// Node ids of every CAD face on the new mesh's surface.
function nodesByCadFace(
  surfaceTriangles: [number, number, number][],
  surfaceFaceIds: number[],
  nodeIds: Set<number>,
): Map<number, number[]> {
  const sets = new Map<number, Set<number>>();
  for (let t = 0; t < surfaceTriangles.length; t++) {
    const face = surfaceFaceIds[t];
    let set = sets.get(face);
    if (!set) {
      set = new Set();
      sets.set(face, set);
    }
    for (const node of surfaceTriangles[t])
      if (nodeIds.has(node)) set.add(node);
  }
  const out = new Map<number, number[]>();
  for (const [face, set] of sets)
    if (set.size > 0)
      out.set(
        face,
        [...set].sort((a, b) => a - b),
      );
  return out;
}

function whyNotCarried(entry: BcFaceEntry): string {
  const text = tr(meshMessages);
  if (entry.cadFaceId !== undefined && entry.geometry === "edge")
    return text.notOnShellRim(entry.cadFaceId);
  if (entry.cadFaceId !== undefined) return text.notOnSurface(entry.cadFaceId);
  if (entry.geometry === "edge") return text.edgePick;
  if (entry.geometry === "point") return text.nodePick;
  return text.notWholeFace;
}

export function carryGroupsToMesh(
  groups: {
    bcGroups: NamedBcGroup[];
    loadGroups: NamedLoadGroup[];
    tieGroups: TieGroup[];
    couplingGroups: CouplingGroup[];
  },
  surfaceTriangles: [number, number, number][] | null,
  surfaceFaceIds: number[] | null,
  nodeIds: Set<number>,
  // The rim nodes of each CAD face a shell collapsed (lib/shellRim) on the new
  // mesh.
  rimNodesByFace: Map<number, number[]> = new Map(),
): CarriedGroups {
  const faceNodes =
    surfaceTriangles && surfaceFaceIds
      ? nodesByCadFace(surfaceTriangles, surfaceFaceIds, nodeIds)
      : new Map<number, number[]>();
  const text = tr(meshMessages);
  const dropped: string[] = [];
  let kept = 0;
  // Old reference point node → the coupling it belonged to, and its new node
  // when the coupling came across.
  const referencePoints = new Map<
    number,
    { coupling: string; newId: number | null }
  >();
  const pointOf = (entry: BcFaceEntry) =>
    entry.nodeIds.length === 1
      ? referencePoints.get(entry.nodeIds[0])
      : undefined;

  const carry = (owner: string, entries: BcFaceEntry[]): BcFaceEntry[] => {
    const out: BcFaceEntry[] = [];
    for (const entry of entries) {
      const point = pointOf(entry);
      if (point !== undefined) {
        if (point.newId === null) {
          dropped.push(
            text.droppedReferencePoint(owner, entry.label, point.coupling),
          );
          continue;
        }
        out.push({ ...entry, nodeIds: [point.newId] });
        kept++;
        continue;
      }
      const nodes =
        entry.cadFaceId === undefined
          ? undefined
          : entry.geometry === "edge"
            ? rimNodesByFace.get(entry.cadFaceId)
            : faceNodes.get(entry.cadFaceId);
      if (!nodes) {
        dropped.push(
          text.droppedEntry(owner, entry.label, whyNotCarried(entry)),
        );
        continue;
      }
      out.push({ ...entry, nodeIds: nodes });
      kept++;
    }
    return out;
  };

  // Couplings first: a support or load on a reference point follows the point.
  let nextNodeId =
    [...nodeIds].reduce((highest, id) => Math.max(highest, id), -1) + 1;
  const couplingGroups: CouplingGroup[] = [];
  const referenceNodes: Node[] = [];
  for (const coupling of groups.couplingGroups) {
    const faces = carry(coupling.name, coupling.faces);
    if (faces.length === 0) {
      dropped.push(text.nothingToGrip(coupling.name));
      referencePoints.set(coupling.refNodeId, {
        coupling: coupling.name,
        newId: null,
      });
      continue;
    }
    const refNodeId = nextNodeId++;
    const [x, y, z] = coupling.point;
    referenceNodes.push({ id: refNodeId, x, y, z });
    referencePoints.set(coupling.refNodeId, {
      coupling: coupling.name,
      newId: refNodeId,
    });
    couplingGroups.push({ ...coupling, faces, refNodeId });
  }

  const bcGroups: NamedBcGroup[] = [];
  for (const group of groups.bcGroups) {
    const faces = carry(group.name, group.faces);
    if (faces.length > 0) bcGroups.push({ ...group, faces });
    else dropped.push(text.nothingToApplyTo(group.name));
  }
  const loadGroups: NamedLoadGroup[] = [];
  for (const group of groups.loadGroups) {
    const faces = carry(group.name, group.faces);
    if (faces.length > 0) loadGroups.push({ ...group, faces });
    else dropped.push(text.nothingToApplyTo(group.name));
  }
  // A tie joins two surfaces; with either side gone there is nothing to join.
  const tieGroups: TieGroup[] = [];
  for (const tie of groups.tieGroups) {
    const facesA = carry(text.tieSideA(tie.name), tie.facesA);
    const facesB = carry(text.tieSideB(tie.name), tie.facesB);
    if (facesA.length > 0 && facesB.length > 0)
      tieGroups.push({ ...tie, facesA, facesB });
    else dropped.push(text.nothingToTie(tie.name));
  }

  return {
    bcGroups,
    loadGroups,
    tieGroups,
    couplingGroups,
    referenceNodes,
    kept,
    dropped,
  };
}

// One sentence for the mesh panel: what came across, and what the user has to
// pick again. Null when there was nothing to carry.
export function remeshNotice(carried: CarriedGroups): string | null {
  if (carried.kept === 0 && carried.dropped.length === 0) return null;
  const groups =
    carried.bcGroups.length +
    carried.loadGroups.length +
    carried.tieGroups.length;
  const couplings = carried.couplingGroups.length;
  const text = tr(meshMessages);
  const keptGroups = groups > 0 ? text.keptGroups(groups) : null;
  const keptCouplings = couplings > 0 ? text.keptCouplings(couplings) : null;
  const kept =
    keptGroups !== null && keptCouplings !== null
      ? text.keptAndKept(keptGroups, keptCouplings)
      : (keptGroups ?? keptCouplings);
  const keptText = kept !== null ? text.keptOnFaces(kept) : text.noGroupKept;
  if (carried.dropped.length === 0) return keptText;
  return text.pickAgain(keptText, carried.dropped.join("; "));
}
