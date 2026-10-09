// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Carrying supports, loads and ties over to a new mesh of the same geometry.
//
// A group entry is a node set, and node ids mean nothing on another mesh — so
// a re-mesh used to clear every group, and a finer mesh of a finished model
// came back with no supports and no loads. An entry picked as a whole CAD face
// remembers that face (BcFaceEntry.cadFaceId), and the new mesh says which of
// its surface triangles lie on which CAD face (surfaceFaceIds), so the entry is
// re-resolved to the new mesh's nodes of the same face. Everything else is
// dropped and named, so the user knows exactly what to pick again:
//   - an edge or node pick, or a flood-fill face (no CAD face behind it)
//   - a face the new mesh does not have on its surface — e.g. a wall the mesh
//     idealised as a shell mid-surface since the pick
//   - a coupling: its reference point was a node of the old mesh
// The geometry must be the one the entries were picked on: a geometry edit
// (split, import) renumbers the CAD faces and clears the groups itself.

import type {
  BcFaceEntry,
  CouplingGroup,
  NamedBcGroup,
  NamedLoadGroup,
  TieGroup,
} from "../store/boundarySlice";

export interface CarriedGroups {
  bcGroups: NamedBcGroup[];
  loadGroups: NamedLoadGroup[];
  tieGroups: TieGroup[];
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
  if (entry.cadFaceId !== undefined)
    return `CAD face ${entry.cadFaceId} is not on the new mesh's surface`;
  if (entry.geometry === "edge") return "an edge pick";
  if (entry.geometry === "point") return "a node pick";
  return "not a whole CAD face";
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
): CarriedGroups {
  const faceNodes =
    surfaceTriangles && surfaceFaceIds
      ? nodesByCadFace(surfaceTriangles, surfaceFaceIds, nodeIds)
      : new Map<number, number[]>();
  const dropped: string[] = [];
  let kept = 0;

  const carry = (owner: string, entries: BcFaceEntry[]): BcFaceEntry[] => {
    const out: BcFaceEntry[] = [];
    for (const entry of entries) {
      const nodes =
        entry.cadFaceId !== undefined
          ? faceNodes.get(entry.cadFaceId)
          : undefined;
      if (!nodes) {
        dropped.push(`${owner} ${entry.label} (${whyNotCarried(entry)})`);
        continue;
      }
      out.push({ ...entry, nodeIds: nodes });
      kept++;
    }
    return out;
  };

  const bcGroups: NamedBcGroup[] = [];
  for (const group of groups.bcGroups) {
    const faces = carry(group.name, group.faces);
    if (faces.length > 0) bcGroups.push({ ...group, faces });
    else dropped.push(`${group.name} — nothing left to apply it to`);
  }
  const loadGroups: NamedLoadGroup[] = [];
  for (const group of groups.loadGroups) {
    const faces = carry(group.name, group.faces);
    if (faces.length > 0) loadGroups.push({ ...group, faces });
    else dropped.push(`${group.name} — nothing left to apply it to`);
  }
  // A tie joins two surfaces; with either side gone there is nothing to join.
  const tieGroups: TieGroup[] = [];
  for (const tie of groups.tieGroups) {
    const facesA = carry(`${tie.name} side A`, tie.facesA);
    const facesB = carry(`${tie.name} side B`, tie.facesB);
    if (facesA.length > 0 && facesB.length > 0)
      tieGroups.push({ ...tie, facesA, facesB });
    else dropped.push(`${tie.name} — a side has nothing left to tie`);
  }
  for (const coupling of groups.couplingGroups)
    dropped.push(
      `${coupling.name} (its reference point was a node of the old mesh)`,
    );

  return { bcGroups, loadGroups, tieGroups, kept, dropped };
}

// One sentence for the mesh panel: what came across, and what the user has to
// pick again. Null when there was nothing to carry.
export function remeshNotice(carried: CarriedGroups): string | null {
  if (carried.kept === 0 && carried.dropped.length === 0) return null;
  const groups =
    carried.bcGroups.length +
    carried.loadGroups.length +
    carried.tieGroups.length;
  const keptText =
    groups > 0
      ? `Kept ${groups} support/load/tie group${groups === 1 ? "" : "s"} on their CAD faces.`
      : "No group could be kept on the new mesh.";
  if (carried.dropped.length === 0) return keptText;
  return `${keptText} Cleared — pick again: ${carried.dropped.join("; ")}.`;
}
