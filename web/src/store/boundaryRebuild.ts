// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The flat constraint / load arrays the solver consumes, derived from the named
// BC and load groups. Pure functions, no Zustand: every slice that changes a
// group (boundarySlice, couplingSlice, geometrySlice on re-mesh) and the
// whole-model lifecycle actions rebuild through these.

import type { Element, Node } from "./geometrySlice";
import type { PickGeometry } from "../lib/facePick";
import { referencePointIds } from "../lib/coupling";
import {
  loadComponents,
  loadKind,
  type NamedBcGroup,
  type NamedLoadGroup,
} from "./boundaryGroups";
import type { CouplingGroup } from "./couplingSlice";
import { momentToNodalForces } from "./momentLoad";

export interface Constraint {
  nodeId: number;
  dof: number; // 0=Ux 1=Uy 2=Uz 3=Rx 4=Ry 5=Rz
  prescribedValue?: number;
}

export interface Load {
  nodeId: number;
  dof: number;
  value: number;
}

// A work-equivalent surface load handed to the engine's boundary integrator.
// `faces` are the element boundary faces of one loaded face — triangles (tets) or
// quads (hexes) — each a list of node indices the engine matches to its generated
// boundary elements by vertex set.
//   force    — total force vector, spread by the engine as a uniform traction
//   pressure — scalar magnitude, applied as -p·n̂ (outward normal; + pushes in)
//   traction — traction vector applied directly (not surfaced in the UI yet)
export interface SurfaceLoad {
  type: "force" | "pressure" | "traction";
  faces: number[][];
  force?: [number, number, number];
  pressure?: number;
}

export function rebuildConstraints(bcGroups: NamedBcGroup[]): Constraint[] {
  const result: Constraint[] = [];
  for (const g of bcGroups)
    for (const f of g.faces)
      for (const nodeId of f.nodeIds)
        for (const dof of g.dofs)
          result.push({ nodeId, dof, prescribedValue: g.value });
  return result;
}

// Local vertex indices of each boundary face of a solid element, in the node
// ordering used by both the .inp/fixture meshes and MFEM's AddTet/AddHex (and so
// by the boundary elements the engine generates). Matching is by vertex set, so
// only the grouping matters, not the winding.
const TET_FACE_INDICES = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 2, 3],
  [1, 2, 3],
];
const HEX_FACE_INDICES = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
];
// A shell element's loadable face is the facet itself (a 2D element has no
// distinct boundary faces — loads act on its surface).
const TRIA_FACE_INDICES = [[0, 1, 2]];
const TRIA_EDGE_INDICES = [
  [0, 1],
  [1, 2],
  [2, 0],
];

// The element boundary faces lying on one loaded face: every element face whose
// nodes all belong to the face's node set — triangles for tets (and shell
// facets), quads for hexes. The engine matches these to its generated boundary
// elements by vertex set (and ignores any interior faces that aren't
// boundaries), so the load is integrated over the real surface, mesh type
// regardless.
//
// A selection on a shell mesh can also be an EDGE — a polyline of nodes (e.g.
// the pulled edge of a plate) that contains no whole facet. When no face
// matched, fall back to the shell-element edges whose both endpoints lie in
// the set, emitted as 2-node entries: the shell solve path applies them as a
// work-equivalent line load (the solid engine path never sees 2-node faces
// because only CTRIA3 elements produce them). The fallback only engages on an
// empty face match, so a region selection is never double-loaded along its
// perimeter.
function loadedFaces(
  face: { nodeIds: number[] },
  elements: Element[],
): number[][] {
  const nodeSet = new Set(face.nodeIds);
  const seen = new Set<string>();
  const faces: number[][] = [];
  for (const el of elements) {
    const local =
      el.type === "CTETRA"
        ? TET_FACE_INDICES
        : el.type === "CHEXA"
          ? HEX_FACE_INDICES
          : el.type === "CTRIA3"
            ? TRIA_FACE_INDICES
            : null;
    if (!local) continue;
    for (const lf of local) {
      const verts = lf.map((i) => el.nodeIds[i]);
      if (!verts.every((v) => nodeSet.has(v))) continue;
      const key = [...verts].sort((a, b) => a - b).join(",");
      if (seen.has(key)) continue; // a boundary face is owned by one element
      seen.add(key);
      faces.push(verts);
    }
  }
  if (faces.length > 0) return faces;

  const edges: number[][] = [];
  for (const el of elements) {
    if (el.type !== "CTRIA3") continue;
    for (const le of TRIA_EDGE_INDICES) {
      const verts = le.map((i) => el.nodeIds[i]);
      if (!verts.every((v) => nodeSet.has(v))) continue;
      const key = [...verts].sort((a, b) => a - b).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(verts);
    }
  }
  return edges;
}

// Whether a selection is applied AT ITS NODES rather than integrated over a
// surface. Two ways to be one, and neither spans an element face:
//
//   a coupling's reference point — a node belonging to no element at all
//   a point pick               — a single mesh node, which spans no face
//
// The single definition rebuildLoads and rebuildSurfaceLoads both consult to
// decide which of them owns a face. Written once on purpose: a load that both
// claim is applied twice, and a load neither claims disappears without a word.
function isNodalFace(
  face: { nodeIds: number[]; geometry?: PickGeometry },
  refPoints: Set<number>,
): boolean {
  if (face.geometry === "point") return true;
  return (
    face.nodeIds.length > 0 && face.nodeIds.every((id) => refPoints.has(id))
  );
}

export function rebuildLoads(
  loadGroups: NamedLoadGroup[],
  nodes: Node[],
  couplingGroups: CouplingGroup[] = [],
): Load[] {
  const nodeById = new Map<number, Node>();
  for (const n of nodes) nodeById.set(n.id, n);
  const refPoints = referencePointIds(couplingGroups);

  const result: Load[] = [];
  for (const g of loadGroups) {
    const kind = loadKind(g);
    if (kind === "pressure") continue; // no vector, and a point has no area
    const vector = loadComponents(g);

    // A load on a single NODE — a picked point, or a coupling's reference point
    // — is applied there directly, whichever kind it is, because neither of the
    // usual routes can carry it:
    //
    //   force  — rebuildSurfaceLoads integrates a traction over the boundary
    //            faces lying on the selection, and a lone node spans none, so
    //            the load would be integrated over nothing and vanish.
    //   moment — momentToNodalForces turns a couple into a ring of tangential
    //            forces about the face centroid, and a single node IS its own
    //            centroid, so every lever arm is zero and the couple vanishes.
    //
    // A reference point carries six real DOFs (it is a coupling reference — see
    // shell_core's is_coupling_ref), so it takes both the force and the couple,
    // and its coupling spreads them over the surface it grips. An ordinary mesh
    // node has only the three translations; a moment applied there reaches the
    // engine as a rotational DOF the solid solve does not carry, so it is
    // rejected at the panel rather than accepted and dropped here.
    //
    // The group's vector is its TOTAL, so several nodes in one group share it,
    // exactly as a surface selection shares a traction.
    const pointFaces = new Set(
      g.faces.filter((face) => isNodalFace(face, refPoints)),
    );
    const pointNodeIds = [...pointFaces].flatMap((face) => face.nodeIds);
    for (const nodeId of pointNodeIds)
      for (let axis = 0; axis < 3; axis++)
        if (vector[axis] !== 0)
          result.push({
            nodeId,
            dof: (kind === "moment" ? 3 : 0) + axis,
            value: vector[axis] / pointNodeIds.length,
          });

    // Faces of ordinary mesh nodes keep their existing routes: a force is a
    // work-equivalent surface traction (rebuildSurfaceLoads, not here), a moment
    // becomes equivalent nodal forces.
    if (kind !== "moment") continue;
    const meshFaces = g.faces.filter((face) => !pointFaces.has(face));
    result.push(...momentToNodalForces(vector, meshFaces, nodeById, g.name));
  }
  return result;
}

// Build the work-equivalent surface loads (ONE per load group) for force and
// pressure groups. The engine integrates these over the group's boundary elements
// (f_i = ∫ N_i·t dS), which is both shape-function-correct and immune to the
// spurious moment that equal nodal splitting introduces on a non-uniform mesh.
//
// One load per GROUP, not per picked selection: a force group's vector is its
// TOTAL, so the engine has to see the whole loaded region at once to spread that
// total over it (it divides by the area it matched). Emitting one load per
// selection instead handed the full total to each, so a 1000 N group picked as
// three faces pulled 3000 N — the same total-sharing rule rebuildLoads applies
// to a group's nodal selections (KOF-216). Pressure is intensive and unaffected
// either way, but it is merged too so both kinds reach the engine identically.
//
// The loaded faces are derived from the element connectivity (loadedFaces), so a
// load works on tet meshes (triangle faces) and hex meshes (quad faces) alike,
// with no dependency on a separately-stored surface triangulation. Selections
// that overlap contribute their shared element faces once — a face counted twice
// would take a double share of the traction, and inflate the area the total is
// divided by.
export function rebuildSurfaceLoads(
  loadGroups: NamedLoadGroup[],
  elements: Element[],
  couplingGroups: CouplingGroup[] = [],
): SurfaceLoad[] {
  const refPoints = referencePointIds(couplingGroups);
  const result: SurfaceLoad[] = [];
  for (const g of loadGroups) {
    const kind = loadKind(g);
    if (kind === "moment") continue; // moments stay as equivalent point loads
    const faces: number[][] = [];
    const seen = new Set<string>();
    for (const f of g.faces) {
      // Nodal selections are rebuildLoads' half of the group: a reference point
      // belongs to no element and a picked point spans no face, so there is no
      // surface to integrate over. The two builders partition a group's faces by
      // the SAME test on purpose — leaving it to loadedFaces returning nothing
      // would make the split an accident of that function, and a change there
      // would either double-apply the load or drop it without a word.
      if (isNodalFace(f, refPoints)) continue;
      for (const face of loadedFaces(f, elements)) {
        const key = [...face].sort((a, b) => a - b).join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        faces.push(face);
      }
    }
    if (faces.length === 0) continue;
    if (kind === "pressure") {
      result.push({ type: "pressure", pressure: g.totalForce, faces });
    } else {
      result.push({ type: "force", force: loadComponents(g), faces });
    }
  }
  return result;
}
