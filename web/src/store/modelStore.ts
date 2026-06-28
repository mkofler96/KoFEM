// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { AnalysisState } from "../lib/analysisFile";

export interface Node {
  id: number;
  x: number;
  y: number;
  z: number;
}

export type ElementType =
  | "CBAR"
  | "CBEAM"
  | "CTRIA3"
  | "CTRIA6"
  | "CQUAD4"
  | "CQUAD8"
  | "CTETRA"
  | "CPENTA"
  | "CHEXA"
  | "CPYRAM";

export type PropertyType = "PBAR" | "PBEAM" | "PSHELL" | "PLPLANE" | "PSOLID";

export interface Property {
  id: number;
  type: PropertyType;
  materialId: number;
  thickness?: number;
  planeFormulation?: "PlaneStress" | "PlaneStrain";
  area?: number;
  i1?: number;
  i2?: number;
  j?: number;
}

export interface Element {
  id: number;
  type: ElementType;
  nodeIds: number[];
  propertyId: number;
}

export interface Material {
  id: number;
  name: string;
  young: number;
  poisson: number;
  density: number;
}

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

export interface SolverResult {
  displacements: Float64Array;
  vonMises?: Float64Array;
}

export const RESULT_TYPES = [
  "Displacement (magnitude)",
  "Ux",
  "Uy",
  "Uz",
  "Von Mises stress",
] as const;
export type ResultType = (typeof RESULT_TYPES)[number];

// CAD geometry source format. The import pipeline reads STEP and IGES into the
// same OCCT shape, but a re-mesh reloads the file (the worker is torn down after
// each mesh), so the reader needs to know which format the retained bytes are.
export type GeometryFormat = "step" | "iges";

export interface StepSurfaceMesh {
  points: [number, number, number][];
  triangles: [number, number, number][];
}

export interface VolMesh {
  points: [number, number, number][];
  edges: [number, number][];
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

// How load glyphs are drawn in the viewport. "resultant" shows one arrow per
// force/pressure group at the centroid of its loaded nodes (the statically
// equivalent load the user specifies). "nodal" shows the work-equivalent load
// each individual node carries — the per-node tributary share of the group total
// — which is what actually reaches the solver as a surface traction (issue #196).
export type LoadDisplay = "resultant" | "nodal";

export interface NamedLoadGroup {
  id: number;
  name: string; // e.g. "Load1"
  dof: number; // force: 0=Fx,1=Fy,2=Fz · moment: 3=Mx,4=My,5=Mz · pressure: unused
  totalForce: number; // force/moment magnitude (N, N·mm), or pressure magnitude (MPa)
  faces: BcFaceEntry[];
  kind?: LoadKind;
}

// Physical kind of a load group, defaulting from `dof` for older payloads that
// have no explicit `kind` (dof ≤ 2 ⇒ force, dof ≥ 3 ⇒ moment).
export function loadKind(g: NamedLoadGroup): LoadKind {
  return g.kind ?? (g.dof <= 2 ? "force" : "moment");
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

function rebuildConstraints(bcGroups: NamedBcGroup[]): Constraint[] {
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

// The element boundary faces lying on one loaded face: every solid-element face
// whose nodes all belong to the face's node set — triangles for tets, quads for
// hexes. The engine matches these to its generated boundary elements by vertex
// set (and ignores any interior faces that aren't boundaries), so the load is
// integrated over the real surface, mesh type regardless.
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
  return faces;
}

function rebuildLoads(loadGroups: NamedLoadGroup[], nodes: Node[]): Load[] {
  const nodeById = new Map<number, Node>();
  for (const n of nodes) nodeById.set(n.id, n);

  const result: Load[] = [];
  for (const g of loadGroups) {
    // Force and pressure loads are applied as work-equivalent surface tractions
    // (rebuildSurfaceLoads), not lumped nodal forces — they are skipped here.
    if (loadKind(g) !== "moment") continue;
    {
      // Moment load (dof 3=Mx, 4=My, 5=Mz) — convert to equivalent nodal forces.
      // For each face, find the centroid, then apply tangential forces F_i = M/S·(n̂×r_i)
      // where S = Σ|r_i⊥|² (perpendicular distance squared from moment axis).
      // This satisfies Σ(r_i × F_i) = M exactly with zero net force.
      const momentAxis = g.dof - 3; // 0=x, 1=y, 2=z
      let skippedFaces = 0;
      for (const f of g.faces) {
        let cx = 0,
          cy = 0,
          cz = 0,
          count = 0;
        for (const nodeId of f.nodeIds) {
          const n = nodeById.get(nodeId);
          if (n) {
            cx += n.x;
            cy += n.y;
            cz += n.z;
            count++;
          }
        }
        if (count === 0) continue;
        cx /= count;
        cy /= count;
        cz /= count;

        let S = 0;
        for (const nodeId of f.nodeIds) {
          const n = nodeById.get(nodeId);
          if (!n) continue;
          const rx = n.x - cx,
            ry = n.y - cy,
            rz = n.z - cz;
          if (momentAxis === 0) S += ry * ry + rz * rz;
          else if (momentAxis === 1) S += rx * rx + rz * rz;
          else S += rx * rx + ry * ry;
        }
        if (S === 0) {
          // All face nodes lie on the moment axis — the tangential force
          // direction is undefined, so this face contributes no moment.
          skippedFaces++;
          continue;
        }

        const scale = g.totalForce / S;
        for (const nodeId of f.nodeIds) {
          const n = nodeById.get(nodeId);
          if (!n) continue;
          const rx = n.x - cx,
            ry = n.y - cy,
            rz = n.z - cz;
          if (momentAxis === 0) {
            // Mx → F = scale·(0, −rz, ry)
            result.push({ nodeId, dof: 1, value: -scale * rz });
            result.push({ nodeId, dof: 2, value: scale * ry });
          } else if (momentAxis === 1) {
            // My → F = scale·(rz, 0, −rx)
            result.push({ nodeId, dof: 0, value: scale * rz });
            result.push({ nodeId, dof: 2, value: -scale * rx });
          } else {
            // Mz → F = scale·(−ry, rx, 0)
            result.push({ nodeId, dof: 0, value: -scale * ry });
            result.push({ nodeId, dof: 1, value: scale * rx });
          }
        }
      }
      if (skippedFaces > 0) {
        console.warn(
          `[moment load] "${g.name}": ${skippedFaces} of ${g.faces.length} ` +
            "face(s) skipped — all of their nodes lie on the moment axis, so " +
            "the applied moment is incomplete. Choose a different moment axis " +
            "or face selection.",
        );
      }
    }
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
function rebuildSurfaceLoads(
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
        const force: [number, number, number] = [0, 0, 0];
        force[g.dof] = g.totalForce;
        result.push({ type: "force", force, faces });
      }
    }
  }
  return result;
}

// ── Store types ───────────────────────────────────────────────────────────────

export type AppMode = "geometry" | "constraints" | "solve" | "results";

interface ModelState {
  nodes: Node[];
  elements: Element[];
  materials: Material[];
  properties: Property[];
  // flat arrays derived from bcGroups / loadGroups — used by solver and visualization
  constraints: Constraint[];
  loads: Load[];
  // work-equivalent surface tractions (force/pressure groups) handed to the solver
  surfaceLoads: SurfaceLoad[];

  modelName: string;
  hasStarted: boolean;
  mode: AppMode;
  result: SolverResult | null;
  resultType: ResultType;
  stepSurface: StepSurfaceMesh | null;
  // Raw bytes of the imported STEP file, retained so the geometry can be
  // reloaded into the mesher for a re-mesh. The worker is torn down after every
  // mesh (resetWorker), discarding the OCCT shape it held, so re-meshing must
  // re-supply the original file. Not persisted in saved analyses (no STEP there).
  stepBytes: Uint8Array | null;
  // Format of the retained stepBytes — selects the OCCT reader on re-mesh.
  geometryFormat: GeometryFormat;
  isRunning: boolean;
  isMeshing: boolean;
  // FE polynomial order for the solve: 1 = linear, 2 = quadratic (second-order).
  // Quadratic elements resolve bending and stress gradients far better at the
  // cost of more DOFs and a slower solve (issue #215).
  elementOrder: number;
  nextMatId: number;
  pickMode: "bc" | "load" | null;
  pickTargetGroupId: number | null; // null = creating new group; id = adding to existing
  selectedFace: FaceSelection | null;
  pendingFaces: FaceSelection[]; // faces accumulated via shift-click within a pick session

  // Named BC / Load groups (primary source of truth for constraints & loads)
  bcGroups: NamedBcGroup[];
  loadGroups: NamedLoadGroup[];
  nextBcGroupId: number;
  nextLoadGroupId: number;
  nextFaceEntryId: number;

  volMesh: VolMesh | null;
  // Netgen surface element vertex indices (0-based, same node IDs as the volume
  // mesh) and their OCC face indices (1-based).  Both arrays have one entry per
  // surface triangle and are in Netgen surface-element order — NOT in the order
  // produced by the frontend's tet boundary extraction.  MeshScene builds a
  // sorted-vertex-key lookup to match them to tet boundary triangles correctly.
  surfaceTriangles: [number, number, number][] | null;
  surfaceFaceIds: number[] | null;
  viewRepr: "geometry" | "surface" | "volume" | "wireframe";
  showUndeformedOverlay: boolean;
  // Whether load glyphs are drawn as a single resultant per group or as one
  // arrow per loaded node (issue #196). A transient view setting, not persisted.
  loadDisplay: LoadDisplay;
  // Deformation magnification applied to the result on top of the automatic
  // fit-to-view scale. 1 = the default visible deformation, 0 = undeformed.
  deformScale: number;
  stepImportError: string | null;
  setStepSurface(mesh: StepSurfaceMesh | null): void;
  setStepBytes(bytes: Uint8Array | null): void;
  setGeometryFormat(format: GeometryFormat): void;
  setVolMesh(mesh: VolMesh | null): void;
  setSurfaceFaceIds(ids: number[] | null): void;
  setViewRepr(v: "geometry" | "surface" | "volume" | "wireframe"): void;
  setShowUndeformedOverlay(v: boolean): void;
  setLoadDisplay(v: LoadDisplay): void;
  setDeformScale(v: number): void;
  setStepImportError(msg: string | null): void;

  // Mode navigation
  setMode(mode: AppMode): void;

  // Solver
  addNode(node: Node): void;
  addElement(el: Element): void;
  addMaterial(mat: Material): void;
  addProperty(prop: Property): void;
  setResult(result: SolverResult): void;
  setResultType(t: ResultType): void;
  setElementOrder(order: number): void;
  setRunning(v: boolean): void;
  setMeshing(v: boolean): void;
  applyMeshResult(
    nodes: Node[],
    elements: Element[],
    modelName: string,
    surfaceTriangles?: [number, number, number][] | null,
    surfaceFaceIds?: number[] | null,
  ): void;
  loadAnalysis(analysis: AnalysisState): void;
  reset(): void;

  // Material CRUD
  createMaterial(mat: Omit<Material, "id">): void;
  updateMaterial(id: number, patch: Partial<Omit<Material, "id">>): void;
  deleteMaterial(id: number): void;

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
  removeFaceFromBcGroup(groupId: number, faceId: number): void;
  deleteBcGroup(id: number): void;
  clearConstraints(): void;

  // Load group actions
  createLoadGroup(
    faces: Omit<BcFaceEntry, "id">[],
    dof: number,
    totalForce: number,
    kind?: LoadKind,
  ): void;
  addFaceToLoadGroup(groupId: number, face: Omit<BcFaceEntry, "id">): void;
  removeFaceFromLoadGroup(groupId: number, faceId: number): void;
  deleteLoadGroup(id: number): void;
  clearLoads(): void;

  // Viewport
  fitViewTrigger: number;
  triggerFitView(): void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

const EMPTY_MODEL = {
  nodes: [] as Node[],
  elements: [] as Element[],
  materials: [
    // Canonical unit system: N · mm · MPa · tonne. Steel: E = 210 GPa = 210000 MPa,
    // ρ = 7850 kg/m³ = 7.85e-9 t/mm³. STEP geometry imports in mm, so materials,
    // loads (N), and results (mm, MPa) must share this system to stay consistent.
    { id: 1, name: "Steel", young: 210000, poisson: 0.3, density: 7.85e-9 },
  ] as Material[],
  properties: [{ id: 1, type: "PSOLID" as const, materialId: 1 }] as Property[],
  constraints: [] as Constraint[],
  loads: [] as Load[],
  surfaceLoads: [] as SurfaceLoad[],
  bcGroups: [] as NamedBcGroup[],
  loadGroups: [] as NamedLoadGroup[],
  nextBcGroupId: 1,
  nextLoadGroupId: 1,
  nextFaceEntryId: 1,
};

export const useModelStore = create<ModelState>()(
  immer((set) => ({
    ...EMPTY_MODEL,
    modelName: "",
    hasStarted: false,
    mode: "geometry" as AppMode,
    result: null,
    resultType: "Displacement (magnitude)" as ResultType,
    stepSurface: null,
    stepBytes: null,
    geometryFormat: "step" as GeometryFormat,
    isRunning: false,
    isMeshing: false,
    // Default to linear: it's fast and reliable for every mesh size. Quadratic is
    // an opt-in upgrade (Solver settings) — far more accurate but ~8× the DOFs.
    elementOrder: 1,
    volMesh: null,
    surfaceTriangles: null,
    surfaceFaceIds: null,
    viewRepr: "surface" as const,
    showUndeformedOverlay: true,
    loadDisplay: "resultant" as LoadDisplay,
    deformScale: 1,
    stepImportError: null,
    nextMatId: 2,
    pickMode: null,
    pickTargetGroupId: null,
    selectedFace: null,
    pendingFaces: [] as FaceSelection[],
    fitViewTrigger: 0,

    setStepImportError: (msg) =>
      set((s) => {
        s.stepImportError = msg;
      }),
    setViewRepr: (v) =>
      set((s) => {
        s.viewRepr = v;
      }),
    setShowUndeformedOverlay: (v) =>
      set((s) => {
        s.showUndeformedOverlay = v;
      }),
    setLoadDisplay: (v) =>
      set((s) => {
        s.loadDisplay = v;
      }),
    setDeformScale: (v) =>
      set((s) => {
        s.deformScale = v;
      }),
    setVolMesh: (mesh) =>
      set((s) => {
        s.volMesh = mesh;
        if (mesh) s.viewRepr = "volume";
      }),
    setSurfaceFaceIds: (ids) =>
      set((s) => {
        s.surfaceFaceIds = ids;
      }),
    setStepBytes: (bytes) =>
      set((s) => {
        s.stepBytes = bytes;
      }),
    setGeometryFormat: (format) =>
      set((s) => {
        s.geometryFormat = format;
      }),
    setStepSurface: (mesh) =>
      set((s) => {
        s.stepSurface = mesh;
        // Clearing the geometry also drops the retained STEP bytes — keeping the
        // invariant "no surface ⇒ nothing left to re-mesh from".
        if (!mesh) {
          s.stepBytes = null;
          s.geometryFormat = "step";
        }
        s.volMesh = null;
        s.viewRepr = "geometry";
        s.stepImportError = null;
        s.nodes = [];
        s.elements = [];
        s.bcGroups = [];
        s.loadGroups = [];
        s.constraints = [];
        s.loads = [];
        s.surfaceLoads = [];
        s.nextBcGroupId = 1;
        s.nextLoadGroupId = 1;
        s.nextFaceEntryId = 1;
        s.result = null;
        if (mesh) {
          s.fitViewTrigger++;
          s.hasStarted = true;
          s.mode = "geometry";
        }
      }),
    triggerFitView: () =>
      set((s) => {
        s.fitViewTrigger++;
      }),

    setMode: (mode) =>
      set((s) => {
        s.mode = mode;
      }),

    addNode: (node) =>
      set((s) => {
        s.nodes.push(node);
      }),
    addElement: (el) =>
      set((s) => {
        s.elements.push(el);
      }),
    addMaterial: (mat) =>
      set((s) => {
        s.materials.push(mat);
      }),
    addProperty: (prop) =>
      set((s) => {
        s.properties.push(prop);
      }),
    setResult: (result) =>
      set((s) => {
        s.result = result;
        s.resultType = "Displacement (magnitude)";
      }),
    setResultType: (t) =>
      set((s) => {
        s.resultType = t;
      }),
    setElementOrder: (order) =>
      set((s) => {
        s.elementOrder = order;
      }),
    setRunning: (v) =>
      set((s) => {
        s.isRunning = v;
      }),
    setMeshing: (v) =>
      set((s) => {
        s.isMeshing = v;
      }),

    applyMeshResult: (
      nodes,
      elements,
      name,
      surfaceTriangles,
      surfaceFaceIds,
    ) =>
      set((s) => {
        s.nodes = nodes;
        s.elements = elements;
        s.surfaceTriangles = surfaceTriangles ?? null;
        s.surfaceFaceIds = surfaceFaceIds ?? null;
        s.bcGroups = [];
        s.loadGroups = [];
        s.constraints = [];
        s.loads = [];
        s.surfaceLoads = [];
        s.nextBcGroupId = 1;
        s.nextLoadGroupId = 1;
        s.nextFaceEntryId = 1;
        s.result = null;
        s.selectedFace = null;
        s.pendingFaces = [];
        s.pickMode = null;
        s.pickTargetGroupId = null;
        s.modelName = name;
        s.viewRepr = "surface";
        s.fitViewTrigger++;
        if (!s.properties.find((p) => p.type === "PSOLID")) {
          const matId = s.materials[0]?.id ?? 1;
          s.properties = [{ id: 1, type: "PSOLID", materialId: matId }];
        }
      }),

    // Restore a complete analysis parsed from a saved .vtu file — the inverse
    // of serializeAnalysis. Keeps the saved named groups, results, and
    // view/mode state instead of rebuilding.
    loadAnalysis: (a) =>
      set((s) => {
        s.nodes = a.nodes;
        s.elements = a.elements;
        s.materials = a.materials;
        s.properties = a.properties;
        s.bcGroups = a.bcGroups;
        s.loadGroups = a.loadGroups;
        s.constraints = rebuildConstraints(a.bcGroups);
        s.loads = rebuildLoads(a.loadGroups, s.nodes);
        s.surfaceLoads = rebuildSurfaceLoads(a.loadGroups, a.elements);
        s.nextBcGroupId = a.nextBcGroupId;
        s.nextLoadGroupId = a.nextLoadGroupId;
        s.nextFaceEntryId = a.nextFaceEntryId;
        s.nextMatId = a.nextMatId;
        s.stepSurface = a.stepSurface;
        // Saved analyses carry the tessellated surface but not the original STEP
        // file, so re-meshing a loaded analysis requires re-importing the STEP.
        s.stepBytes = null;
        s.geometryFormat = "step";
        s.volMesh = a.volMesh;
        s.surfaceTriangles = a.surfaceTriangles;
        s.surfaceFaceIds = a.surfaceFaceIds;
        s.modelName = a.modelName;
        s.result = a.result;
        s.resultType = a.resultType;
        s.viewRepr = a.viewRepr;
        s.deformScale = 1;
        s.mode = a.mode;
        s.stepImportError = null;
        s.isRunning = false;
        s.isMeshing = false;
        s.selectedFace = null;
        s.pendingFaces = [];
        s.pickMode = null;
        s.pickTargetGroupId = null;
        s.hasStarted = true;
        s.fitViewTrigger++;
      }),

    reset: () =>
      set((s) => {
        s.nodes = [];
        s.elements = [];
        s.materials = [
          {
            id: 1,
            name: "Steel",
            young: 210000,
            poisson: 0.3,
            density: 7.85e-9,
          },
        ];
        s.properties = [{ id: 1, type: "PSOLID", materialId: 1 }];
        s.bcGroups = [];
        s.loadGroups = [];
        s.constraints = [];
        s.loads = [];
        s.surfaceLoads = [];
        s.nextBcGroupId = 1;
        s.nextLoadGroupId = 1;
        s.nextFaceEntryId = 1;
        s.modelName = "";
        s.result = null;
        s.stepSurface = null;
        s.stepBytes = null;
        s.geometryFormat = "step";
        s.volMesh = null;
        s.surfaceTriangles = null;
        s.surfaceFaceIds = null;
        s.viewRepr = "surface";
        s.deformScale = 1;
        s.nextMatId = 2;
        s.selectedFace = null;
        s.pickMode = null;
        s.pickTargetGroupId = null;
        s.hasStarted = false;
      }),

    // Material CRUD
    createMaterial: (mat) =>
      set((s) => {
        s.materials.push({ ...mat, id: s.nextMatId++ });
      }),

    updateMaterial: (id, patch) =>
      set((s) => {
        const idx = s.materials.findIndex((m) => m.id === id);
        if (idx >= 0) Object.assign(s.materials[idx], patch);
      }),

    deleteMaterial: (id) =>
      set((s) => {
        s.materials = s.materials.filter((m) => m.id !== id);
      }),

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
        const g = s.bcGroups.find((g) => g.id === groupId);
        if (!g) return;
        const faceId = s.nextFaceEntryId++;
        g.faces.push({ id: faceId, label: face.label, nodeIds: face.nodeIds });
        s.constraints = rebuildConstraints(s.bcGroups);
        s.result = null;
      }),

    removeFaceFromBcGroup: (groupId: number, faceId: number) =>
      set((s) => {
        const g = s.bcGroups.find((g) => g.id === groupId);
        if (!g) return;
        g.faces = g.faces.filter((f) => f.id !== faceId);
        if (g.faces.length === 0)
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
      dof: number,
      totalForce: number,
      kind: LoadKind = dof <= 2 ? "force" : "moment",
    ) =>
      set((s) => {
        const faceEntries = faces.map((f) => ({
          id: s.nextFaceEntryId++,
          label: f.label,
          nodeIds: f.nodeIds,
        }));
        s.loadGroups.push({
          id: s.nextLoadGroupId,
          name: `Load${s.nextLoadGroupId}`,
          dof,
          totalForce,
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
        const g = s.loadGroups.find((g) => g.id === groupId);
        if (!g) return;
        const faceId = s.nextFaceEntryId++;
        g.faces.push({ id: faceId, label: face.label, nodeIds: face.nodeIds });
        s.loads = rebuildLoads(s.loadGroups, s.nodes);
        s.surfaceLoads = rebuildSurfaceLoads(s.loadGroups, s.elements);
        s.result = null;
      }),

    removeFaceFromLoadGroup: (groupId: number, faceId: number) =>
      set((s) => {
        const g = s.loadGroups.find((g) => g.id === groupId);
        if (!g) return;
        g.faces = g.faces.filter((f) => f.id !== faceId);
        if (g.faces.length === 0)
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
  })),
);

// Expose store on window so Playwright tests can inject BCs/loads
// without requiring 3D face-picking interactions.
(window as Window & { __kofemStore?: typeof useModelStore }).__kofemStore =
  useModelStore;
