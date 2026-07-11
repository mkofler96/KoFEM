// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Boundary slice: named BC / load groups (the primary source of truth), the
// flat constraint/load arrays derived from them for the solver, and the
// face-pick session state used to build groups in the viewport.

import type { SliceCreator } from "./modelStore";
import type { Element, Node } from "./geometrySlice";
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

export interface FaceSelection {
  nodeIds: number[];
  label: string; // e.g. "Min X face (9 nodes)"
  axis: "X" | "Y" | "Z";
  isMax: boolean;
}

// ── Named BC / Load groups ────────────────────────────────────────────────────

export interface BcFaceEntry {
  id: number;
  label: string; // e.g. "Face 1"
  nodeIds: number[];
}

export interface NamedBcGroup {
  id: number;
  name: string; // e.g. "BC1"
  dofs: number[];
  value: number;
  faces: BcFaceEntry[];
}

// A load group's physical kind. "force" and "pressure" are applied to the solver
// as work-equivalent surface tractions (SurfaceLoad); "moment" is still lumped to
// equivalent nodal forces (rebuildLoads). For backward-compat with saved analyses
// that predate this field, `kind` is optional and inferred from `dof` via
// loadKind().
export type LoadKind = "force" | "moment" | "pressure";

export interface NamedLoadGroup {
  id: number;
  name: string; // e.g. "Load1"
  dof: number; // force: 0=Fx,1=Fy,2=Fz · moment: 3=Mx,4=My,5=Mz · pressure: unused
  totalForce: number; // force/moment magnitude (N, N·mm), or pressure magnitude (MPa)
  // Componentwise force [Fx,Fy,Fz] (N) or moment [Mx,My,Mz] (N·mm) vector
  // (issues #219, #190). Present on force/moment groups created via the
  // componentwise UI, where it is the source of truth and supersedes
  // dof/totalForce. Absent on pressure groups and on payloads saved before
  // componentwise input existed — those reconstruct the vector from dof +
  // totalForce via loadComponents().
  components?: [number, number, number];
  faces: BcFaceEntry[];
  kind?: LoadKind;
}

// Physical kind of a load group, defaulting from `dof` for older payloads that
// have no explicit `kind` (dof ≤ 2 ⇒ force, dof ≥ 3 ⇒ moment).
export function loadKind(g: NamedLoadGroup): LoadKind {
  return g.kind ?? (g.dof <= 2 ? "force" : "moment");
}

// The force [Fx,Fy,Fz] (N) or moment [Mx,My,Mz] (N·mm) vector of a load group.
// Uses the explicit componentwise vector when present, else reconstructs the
// single-axis vector from the legacy dof + totalForce (force: axis 0–2; moment:
// axis dof−3). Pressure groups have no vector and return zeros.
export function loadComponents(g: NamedLoadGroup): [number, number, number] {
  if (g.components) return g.components;
  const vec: [number, number, number] = [0, 0, 0];
  const kind = loadKind(g);
  if (kind === "force" && g.dof >= 0 && g.dof <= 2) vec[g.dof] = g.totalForce;
  else if (kind === "moment" && g.dof >= 3 && g.dof <= 5)
    vec[g.dof - 3] = g.totalForce;
  return vec;
}

// Legacy single-axis summary (primary axis + signed magnitude) of a componentwise
// vector, stored alongside `components` so older readers and the pre-flight
// fallback still see a sensible dof/totalForce. For a single non-zero component
// this reproduces the vector exactly; for a general vector it names the first
// non-zero axis. `components` remains the source of truth.
function summarizeComponents(
  components: [number, number, number],
  kind: LoadKind,
): { dof: number; totalForce: number } {
  const found = components.findIndex((value) => value !== 0);
  const axis = found < 0 ? 0 : found;
  return {
    dof: kind === "moment" ? axis + 3 : axis,
    totalForce: components[axis],
  };
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

export function rebuildLoads(
  loadGroups: NamedLoadGroup[],
  nodes: Node[],
): Load[] {
  const nodeById = new Map<number, Node>();
  for (const n of nodes) nodeById.set(n.id, n);

  const result: Load[] = [];
  for (const g of loadGroups) {
    // Force and pressure loads are applied as work-equivalent surface tractions
    // (rebuildSurfaceLoads), not lumped nodal forces — they are skipped here.
    if (loadKind(g) !== "moment") continue;
    result.push(
      ...momentToNodalForces(loadComponents(g), g.faces, nodeById, g.name),
    );
  }
  return result;
}

// Build the work-equivalent surface loads (one per loaded face) for force and
// pressure groups. The engine integrates these over the face's boundary elements
// (f_i = ∫ N_i·t dS), which is both shape-function-correct and immune to the
// spurious moment that equal nodal splitting introduces on a non-uniform mesh.
//
// The loaded faces are derived from the element connectivity (loadedFaces), so a
// load works on tet meshes (triangle faces) and hex meshes (quad faces) alike,
// with no dependency on a separately-stored surface triangulation.
export function rebuildSurfaceLoads(
  loadGroups: NamedLoadGroup[],
  elements: Element[],
): SurfaceLoad[] {
  const result: SurfaceLoad[] = [];
  for (const g of loadGroups) {
    const kind = loadKind(g);
    if (kind === "moment") continue; // moments stay as equivalent point loads
    for (const f of g.faces) {
      const faces = loadedFaces(f, elements);
      if (faces.length === 0) continue;
      if (kind === "pressure") {
        result.push({ type: "pressure", pressure: g.totalForce, faces });
      } else {
        result.push({ type: "force", force: loadComponents(g), faces });
      }
    }
  }
  return result;
}

// ── Slice ─────────────────────────────────────────────────────────────────────

export interface BoundarySlice {
  // flat arrays derived from bcGroups / loadGroups — used by solver and visualization
  constraints: Constraint[];
  loads: Load[];
  // work-equivalent surface tractions (force/pressure groups) handed to the solver
  surfaceLoads: SurfaceLoad[];

  // Named BC / Load groups (primary source of truth for constraints & loads)
  bcGroups: NamedBcGroup[];
  loadGroups: NamedLoadGroup[];
  nextBcGroupId: number;
  nextLoadGroupId: number;
  nextFaceEntryId: number;

  pickMode: "bc" | "load" | null;
  pickTargetGroupId: number | null; // null = creating new group; id = adding to existing
  selectedFace: FaceSelection | null;
  pendingFaces: FaceSelection[]; // faces accumulated via shift-click within a pick session

  // Pick mode / face selection
  setPickMode(mode: "bc" | "load" | null, targetGroupId?: number | null): void;
  setSelectedFace(face: FaceSelection | null): void;
  setPendingFaces(faces: FaceSelection[]): void;

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

export const createBoundarySlice: SliceCreator<BoundarySlice> = (set) => ({
  constraints: [],
  loads: [],
  surfaceLoads: [],
  bcGroups: [],
  loadGroups: [],
  nextBcGroupId: 1,
  nextLoadGroupId: 1,
  nextFaceEntryId: 1,
  pickMode: null,
  pickTargetGroupId: null,
  selectedFace: null,
  pendingFaces: [],

  // Pick mode / face selection
  setPickMode: (
    mode: "bc" | "load" | null,
    targetGroupId: number | null = null,
  ) =>
    set((s) => {
      s.pickMode = mode;
      s.pickTargetGroupId = mode !== null ? (targetGroupId ?? null) : null;
      if (mode === null) {
        s.selectedFace = null;
        s.pendingFaces = [];
      }
    }),

  setSelectedFace: (face: FaceSelection | null) =>
    set((s) => {
      s.selectedFace = face;
    }),

  setPendingFaces: (faces: FaceSelection[]) =>
    set((s) => {
      s.pendingFaces = faces;
    }),

  // BC group actions
  createBcGroup: (
    faces: Omit<BcFaceEntry, "id">[],
    dofs: number[],
    value: number,
  ) =>
    set((s) => {
      const faceEntries = faces.map((f) => ({
        id: s.nextFaceEntryId++,
        label: f.label,
        nodeIds: f.nodeIds,
      }));
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
      const faceId = s.nextFaceEntryId++;
      group.faces.push({
        id: faceId,
        label: face.label,
        nodeIds: face.nodeIds,
      });
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
      const faceEntries = faces.map((f) => ({
        id: s.nextFaceEntryId++,
        label: f.label,
        nodeIds: f.nodeIds,
      }));
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
      s.loads = rebuildLoads(s.loadGroups, s.nodes);
      s.surfaceLoads = rebuildSurfaceLoads(s.loadGroups, s.elements);
      s.result = null;
    }),

  addFaceToLoadGroup: (groupId: number, face: Omit<BcFaceEntry, "id">) =>
    set((s) => {
      const group = s.loadGroups.find((g) => g.id === groupId);
      if (!group) return;
      const faceId = s.nextFaceEntryId++;
      group.faces.push({
        id: faceId,
        label: face.label,
        nodeIds: face.nodeIds,
      });
      s.loads = rebuildLoads(s.loadGroups, s.nodes);
      s.surfaceLoads = rebuildSurfaceLoads(s.loadGroups, s.elements);
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
      s.loads = rebuildLoads(s.loadGroups, s.nodes);
      s.surfaceLoads = rebuildSurfaceLoads(s.loadGroups, s.elements);
      s.result = null;
    }),

  removeFaceFromLoadGroup: (groupId: number, faceId: number) =>
    set((s) => {
      const group = s.loadGroups.find((g) => g.id === groupId);
      if (!group) return;
      group.faces = group.faces.filter((f) => f.id !== faceId);
      if (group.faces.length === 0)
        s.loadGroups = s.loadGroups.filter((g) => g.id !== groupId);
      s.loads = rebuildLoads(s.loadGroups, s.nodes);
      s.surfaceLoads = rebuildSurfaceLoads(s.loadGroups, s.elements);
      s.result = null;
    }),

  deleteLoadGroup: (id: number) =>
    set((s) => {
      s.loadGroups = s.loadGroups.filter((g) => g.id !== id);
      s.loads = rebuildLoads(s.loadGroups, s.nodes);
      s.surfaceLoads = rebuildSurfaceLoads(s.loadGroups, s.elements);
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
