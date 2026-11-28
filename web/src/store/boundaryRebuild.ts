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
  // Index of the BC group in bcGroups: the support whose reaction this DOF
  // adds to (KOF-387).
  group?: number;
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
//
// `name` is the load group's, for errors that refer to the load.
// `unmatchedSelections` counts the group's selections that span no loadable
// face of the mesh (a stale pick after a re-mesh, an edge of a solid). Such a
// load is kept, even with no faces at all, so the solve refuses it by name
// (surfaceLoadRefusal) instead of dropping it, or putting its total on the
// selections that did match (KOF-411).
export interface SurfaceLoad {
  type: "force" | "pressure" | "traction";
  faces: number[][];
  force?: [number, number, number];
  pressure?: number;
  name?: string;
  unmatchedSelections?: number;
}

export function rebuildConstraints(bcGroups: NamedBcGroup[]): Constraint[] {
  const result: Constraint[] = [];
  bcGroups.forEach((g, group) => {
    for (const f of g.faces)
      for (const nodeId of f.nodeIds)
        for (const dof of g.dofs)
          result.push({ nodeId, dof, prescribedValue: g.value, group });
  });
  return result;
}

// Local vertex indices of each boundary face of a solid element, in the node
// ordering used by the .inp/fixture meshes and the solver's elements (CHEXA /
// MFEM vertex order). Matching is by vertex set, so
// only the grouping matters, not the winding.
export const TET_FACE_INDICES = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 2, 3],
  [1, 2, 3],
];
export const HEX_FACE_INDICES = [
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

// A face's vertex-set key: its node ids sorted, so any winding matches.
export const faceKey = (ids: readonly number[]): string =>
  [...ids].sort((a, b) => a - b).join(",");

// The keys of every face a surface load can act on: a solid face owned by one
// solid element (a face shared by two is inside the body, and the solid
// solve's boundary integrator would not find it), every shell facet, and
// every edge of a shell facet (a line load). The one definition the load
// builder (rebuildSurfaceLoads) and the solve's check (surfaceLoadRefusal)
// both use, so they cannot disagree on what is loadable.
//
// Cached per element array: the Solve panel routes the model on every render,
// log lines included, and a re-mesh or element edit replaces the array
// (store updates are immutable), so the identity is the mesh's version.
type FaceElements = readonly { type: string; nodeIds: number[] }[];
const loadableCache = new WeakMap<FaceElements, ReadonlySet<string>>();

export function loadableFaceKeys(elements: FaceElements): ReadonlySet<string> {
  const cached = loadableCache.get(elements);
  if (cached !== undefined) return cached;
  const loadable = new Set(solidSurfaceFaceKeys(elements));
  for (const el of elements) {
    if (el.type !== "CTRIA3") continue;
    loadable.add(faceKey(el.nodeIds));
    for (const edge of TRIA_EDGE_INDICES)
      loadable.add(faceKey(edge.map((i) => el.nodeIds[i])));
  }
  loadableCache.set(elements, loadable);
  return loadable;
}

// TypeScript because the store builds loads without the Rust module.
export function solidSurfaceFaceKeys(elements: FaceElements): Set<string> {
  const owners = new Map<string, number>();
  const hexFaces: number[][] = [];
  for (const el of elements) {
    const local =
      el.type === "CTETRA"
        ? TET_FACE_INDICES
        : el.type === "CHEXA"
          ? HEX_FACE_INDICES
          : null;
    if (!local) continue;
    for (const lf of local) {
      const corners = lf.map((i) => el.nodeIds[i]);
      const key = faceKey(corners);
      owners.set(key, (owners.get(key) ?? 0) + 1);
      if (el.type === "CHEXA") hexFaces.push(corners);
    }
  }
  const surface = new Set<string>();
  for (const [key, count] of owners) if (count === 1) surface.add(key);
  for (const [first, second, third, fourth] of hexFaces) {
    const quad = faceKey([first, second, third, fourth]);
    if (!surface.has(quad)) continue;
    for (const halves of [
      [
        [first, second, third],
        [first, third, fourth],
      ],
      [
        [second, third, fourth],
        [second, fourth, first],
      ],
    ]) {
      const keys = halves.map(faceKey);
      if (!keys.every((key) => surface.has(key))) continue;
      surface.delete(quad);
      for (const key of keys) surface.delete(key);
    }
  }
  return surface;
}

// The element boundary faces lying on one loaded face: every loadable element
// face (loadableFaceKeys) whose nodes all belong to the face's node set —
// triangles for tets (and shell facets), quads for hexes. A face inside a
// solid can have all its nodes on a picked face (a sliver tet on a curved
// wall) and is left out: the solid solve would find no boundary face for it,
// and the coupled solve would load it. The engine matches the rest to its
// boundary elements by vertex set, so the load is integrated over the real
// surface, mesh type regardless.
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
  loadable: ReadonlySet<string>,
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
      const key = faceKey(verts);
      if (!loadable.has(key) || seen.has(key)) continue;
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
      const key = faceKey(verts);
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
  const loadable = loadableFaceKeys(elements);
  const result: SurfaceLoad[] = [];
  for (const g of loadGroups) {
    const kind = loadKind(g);
    if (kind === "moment") continue; // moments stay as equivalent point loads
    const faces: number[][] = [];
    const seen = new Set<string>();
    let selections = 0;
    let unmatchedSelections = 0;
    for (const f of g.faces) {
      // Nodal selections are rebuildLoads' half of the group: a reference point
      // belongs to no element and a picked point spans no face, so there is no
      // surface to integrate over. The two builders partition a group's faces by
      // the SAME test on purpose — leaving it to loadedFaces returning nothing
      // would make the split an accident of that function, and a change there
      // would either double-apply the load or drop it without a word.
      if (isNodalFace(f, refPoints)) continue;
      selections++;
      const spanned = loadedFaces(f, elements, loadable);
      // A selection that spans no face would vanish from the load, and its
      // share of a total force move to the other selections. Count it, for the
      // solve to refuse (surfaceLoadRefusal).
      if (spanned.length === 0) unmatchedSelections++;
      for (const face of spanned) {
        const key = faceKey(face);
        if (seen.has(key)) continue;
        seen.add(key);
        faces.push(face);
      }
    }
    // A group of nodal selections only is rebuildLoads' alone. Any other group
    // is kept, even with no faces, so it reaches the solve and is refused by
    // name rather than skipped.
    if (selections === 0) continue;
    const named = { faces, name: g.name, unmatchedSelections };
    if (kind === "pressure") {
      result.push({ type: "pressure", pressure: g.totalForce, ...named });
    } else {
      result.push({ type: "force", force: loadComponents(g), ...named });
    }
  }
  return result;
}
