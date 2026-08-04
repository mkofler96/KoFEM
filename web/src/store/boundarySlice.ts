// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Boundary slice: named BC / load / tie groups (the primary source of truth),
// the flat constraint/load arrays derived from them for the solver, and the
// face-pick session state used to build groups in the viewport.

import type { SliceCreator } from "./modelStore";
import type { Element, Node } from "./geometrySlice";
import type { TieDefinition, TieExtent } from "../lib/tie";
import type { PickGeometry } from "../lib/facePick";
import type { CouplingDefinition, CouplingKind } from "../lib/coupling";
import { ALL_DOFS, referencePointIds } from "../lib/coupling";
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
  // What was picked. Only "point" changes how the solver applies the group: a
  // single node spans no element face, so a load on it cannot be integrated as
  // a traction and is applied at the node instead (rebuildLoads). Absent on
  // entries saved before point picking existed, which were faces or edges —
  // both integrable — so absence reads correctly as "not a point".
  geometry?: PickGeometry;
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

// Which surface of a tie a pick session is currently filling.
export type TieSide = "a" | "b";

// What a pick session is being used to define. A coupling picks one surface,
// like a BC or a load; a tie picks two (pickTieSide selects which).
export type PickMode = "bc" | "load" | "tie" | "coupling";

// Default search distance (mm) offered for a region tie. A contact patch is a
// property of the assembly, so there is no right number — this is only the
// starting value in the form, which the user edits before applying.
export const DEFAULT_TIE_DISTANCE = 0.5;

// The face list of one side of a tie.
export function tieFaces(group: TieGroup, side: TieSide): BcFaceEntry[] {
  return side === "a" ? group.facesA : group.facesB;
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

// Mint a committed face entry from a picked one, taking the next id. Written
// once because every group type creates entries the same way, and a copy that
// forgets to carry a field — `geometry` is the one that matters, since it is
// what routes a load to its nodes rather than to a surface integral — fails
// only in the solve, far from here.
function faceEntry(
  face: Omit<BcFaceEntry, "id">,
  nextId: () => number,
): BcFaceEntry {
  return { ...face, id: nextId() };
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

// ── Slice ─────────────────────────────────────────────────────────────────────

export interface BoundarySlice {
  // flat arrays derived from bcGroups / loadGroups — used by solver and visualization
  constraints: Constraint[];
  loads: Load[];
  // work-equivalent surface tractions (force/pressure groups) handed to the solver
  surfaceLoads: SurfaceLoad[];

  // Named BC / Load / Tie / Coupling groups (primary source of truth for
  // constraints, loads, bonded connections and surface-to-point couplings)
  bcGroups: NamedBcGroup[];
  loadGroups: NamedLoadGroup[];
  tieGroups: TieGroup[];
  couplingGroups: CouplingGroup[];
  nextBcGroupId: number;
  nextLoadGroupId: number;
  nextTieGroupId: number;
  nextCouplingGroupId: number;
  nextFaceEntryId: number;

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

  // Pick mode / face selection
  setPickMode(mode: PickMode | null, targetGroupId?: number | null): void;
  setPickGeometry(geometry: PickGeometry): void;
  setSelectedFace(face: FaceSelection | null): void;
  setPendingFaces(faces: FaceSelection[]): void;
  setPickTieSide(side: TieSide): void;
  setCouplingDraft(
    draft: { point: [number, number, number]; nodeIds: number[] } | null,
  ): void;

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

  // Tie (connector) group actions
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

  // Surface-to-point coupling actions. Creating one also creates its reference
  // point node; deleting one removes that node again.
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

export const createBoundarySlice: SliceCreator<BoundarySlice> = (set) => ({
  constraints: [],
  loads: [],
  surfaceLoads: [],
  bcGroups: [],
  loadGroups: [],
  tieGroups: [],
  couplingGroups: [],
  nextBcGroupId: 1,
  nextLoadGroupId: 1,
  nextTieGroupId: 1,
  nextCouplingGroupId: 1,
  nextFaceEntryId: 1,
  pickMode: null,
  pickTargetGroupId: null,
  pickGeometry: "face",
  selectedFace: null,
  pendingFaces: [],
  pickTieSide: "a",
  tieDraft: { a: [], b: [] },
  couplingDraft: null,

  // Pick mode / face selection
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
      s.loads = rebuildLoads(s.loadGroups, s.nodes, s.couplingGroups);
      s.surfaceLoads = rebuildSurfaceLoads(
        s.loadGroups,
        s.elements,
        s.couplingGroups,
      );
      s.result = null;
    }),

  addFaceToLoadGroup: (groupId: number, face: Omit<BcFaceEntry, "id">) =>
    set((s) => {
      const group = s.loadGroups.find((g) => g.id === groupId);
      if (!group) return;
      group.faces.push(faceEntry(face, () => s.nextFaceEntryId++));
      s.loads = rebuildLoads(s.loadGroups, s.nodes, s.couplingGroups);
      s.surfaceLoads = rebuildSurfaceLoads(
        s.loadGroups,
        s.elements,
        s.couplingGroups,
      );
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
      s.loads = rebuildLoads(s.loadGroups, s.nodes, s.couplingGroups);
      s.surfaceLoads = rebuildSurfaceLoads(
        s.loadGroups,
        s.elements,
        s.couplingGroups,
      );
      s.result = null;
    }),

  removeFaceFromLoadGroup: (groupId: number, faceId: number) =>
    set((s) => {
      const group = s.loadGroups.find((g) => g.id === groupId);
      if (!group) return;
      group.faces = group.faces.filter((f) => f.id !== faceId);
      if (group.faces.length === 0)
        s.loadGroups = s.loadGroups.filter((g) => g.id !== groupId);
      s.loads = rebuildLoads(s.loadGroups, s.nodes, s.couplingGroups);
      s.surfaceLoads = rebuildSurfaceLoads(
        s.loadGroups,
        s.elements,
        s.couplingGroups,
      );
      s.result = null;
    }),

  deleteLoadGroup: (id: number) =>
    set((s) => {
      s.loadGroups = s.loadGroups.filter((g) => g.id !== id);
      s.loads = rebuildLoads(s.loadGroups, s.nodes, s.couplingGroups);
      s.surfaceLoads = rebuildSurfaceLoads(
        s.loadGroups,
        s.elements,
        s.couplingGroups,
      );
      s.result = null;
    }),

  clearLoads: () =>
    set((s) => {
      s.loadGroups = [];
      s.loads = [];
      s.surfaceLoads = [];
      s.result = null;
    }),

  // Tie (connector) group actions. A tie has no derived flat array: the weld it
  // describes is applied to the mesh at solve time (buildTie), and drawn from
  // the same definition in the viewport (tiedNodePairs).
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

  // Surface-to-point coupling actions. The reference point is a NODE, created
  // and destroyed with its coupling — see CouplingGroup.
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
