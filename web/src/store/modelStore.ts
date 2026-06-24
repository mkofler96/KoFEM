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

export interface NamedLoadGroup {
  id: number;
  name: string; // e.g. "Load1"
  dof: number;
  totalForce: number; // applied per face, divided equally among the face's nodes
  faces: BcFaceEntry[];
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

function rebuildLoads(loadGroups: NamedLoadGroup[], nodes: Node[]): Load[] {
  const nodeById = new Map<number, Node>();
  for (const n of nodes) nodeById.set(n.id, n);

  const result: Load[] = [];
  for (const g of loadGroups) {
    if (g.dof <= 2) {
      // Force load — distribute total evenly across face nodes
      for (const f of g.faces) {
        const perNode = g.totalForce / f.nodeIds.length;
        for (const nodeId of f.nodeIds)
          result.push({ nodeId, dof: g.dof, value: perNode });
      }
    } else {
      // Moment load (dof 3=Mx, 4=My, 5=Mz) — convert to equivalent nodal forces.
      // For each face, find the centroid, then apply tangential forces F_i = M/S·(n̂×r_i)
      // where S = Σ|r_i⊥|² (perpendicular distance squared from moment axis).
      // This satisfies Σ(r_i × F_i) = M exactly with zero net force.
      const momentAxis = g.dof - 3; // 0=x, 1=y, 2=z
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
        if (S === 0) continue; // all nodes on the moment axis — undefined

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

  modelName: string;
  hasStarted: boolean;
  mode: AppMode;
  result: SolverResult | null;
  resultType: ResultType;
  stepSurface: StepSurfaceMesh | null;
  isRunning: boolean;
  isMeshing: boolean;
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
  stepImportError: string | null;
  setStepSurface(mesh: StepSurfaceMesh | null): void;
  setVolMesh(mesh: VolMesh | null): void;
  setSurfaceFaceIds(ids: number[] | null): void;
  setViewRepr(v: "geometry" | "surface" | "volume" | "wireframe"): void;
  setShowUndeformedOverlay(v: boolean): void;
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
    isRunning: false,
    isMeshing: false,
    volMesh: null,
    surfaceTriangles: null,
    surfaceFaceIds: null,
    viewRepr: "surface" as const,
    showUndeformedOverlay: true,
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
    setVolMesh: (mesh) =>
      set((s) => {
        s.volMesh = mesh;
        if (mesh) s.viewRepr = "volume";
      }),
    setSurfaceFaceIds: (ids) =>
      set((s) => {
        s.surfaceFaceIds = ids;
      }),
    setStepSurface: (mesh) =>
      set((s) => {
        s.stepSurface = mesh;
        s.volMesh = null;
        s.viewRepr = "geometry";
        s.stepImportError = null;
        s.nodes = [];
        s.elements = [];
        s.bcGroups = [];
        s.loadGroups = [];
        s.constraints = [];
        s.loads = [];
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
        s.nextBcGroupId = a.nextBcGroupId;
        s.nextLoadGroupId = a.nextLoadGroupId;
        s.nextFaceEntryId = a.nextFaceEntryId;
        s.nextMatId = a.nextMatId;
        s.stepSurface = a.stepSurface;
        s.volMesh = a.volMesh;
        s.surfaceTriangles = a.surfaceTriangles;
        s.surfaceFaceIds = a.surfaceFaceIds;
        s.modelName = a.modelName;
        s.result = a.result;
        s.resultType = a.resultType;
        s.viewRepr = a.viewRepr;
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
        s.nextBcGroupId = 1;
        s.nextLoadGroupId = 1;
        s.nextFaceEntryId = 1;
        s.modelName = "";
        s.result = null;
        s.stepSurface = null;
        s.volMesh = null;
        s.surfaceTriangles = null;
        s.surfaceFaceIds = null;
        s.viewRepr = "surface";
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
        });
        s.nextLoadGroupId++;
        s.loads = rebuildLoads(s.loadGroups, s.nodes);
        s.result = null;
      }),

    addFaceToLoadGroup: (groupId: number, face: Omit<BcFaceEntry, "id">) =>
      set((s) => {
        const g = s.loadGroups.find((g) => g.id === groupId);
        if (!g) return;
        const faceId = s.nextFaceEntryId++;
        g.faces.push({ id: faceId, label: face.label, nodeIds: face.nodeIds });
        s.loads = rebuildLoads(s.loadGroups, s.nodes);
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
        s.result = null;
      }),

    deleteLoadGroup: (id: number) =>
      set((s) => {
        s.loadGroups = s.loadGroups.filter((g) => g.id !== id);
        s.loads = rebuildLoads(s.loadGroups, s.nodes);
        s.result = null;
      }),

    clearLoads: () =>
      set((s) => {
        s.loadGroups = [];
        s.loads = [];
        s.result = null;
      }),
  })),
);

// Expose store on window so Playwright tests can inject BCs/loads
// without requiring 3D face-picking interactions.
(window as Window & { __kofemStore?: typeof useModelStore }).__kofemStore =
  useModelStore;
