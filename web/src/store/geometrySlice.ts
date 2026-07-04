// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Geometry slice: FEM nodes/elements, the imported CAD geometry (tessellation
// + retained source bytes), and the meshing pipeline state.

import type { SliceCreator } from "./modelStore";

export interface Node {
  id: number;
  x: number;
  y: number;
  z: number;
}

// The live OCCT → Netgen → MFEM pipeline only ever produces solid elements:
// tetrahedra (CTETRA) and hexahedra (CHEXA). 1D (beam) and 2D (shell/plane)
// element types are not modelled — restore the relevant variants here when
// such support is actually added.
export type ElementType = "CTETRA" | "CHEXA";

// Reserved seam for #317 (multibody: per-body materials). Currently
// write-only — the solver reads `materials[0]` directly (solver.worker.ts)
// and does not consult `propertyId`/`materialId` to resolve an element's
// material. Every model still carries exactly one auto-created Property
// referencing the model's sole material; do not treat this as the current
// material-assignment mechanism until #317 wires per-element regions
// through it (see #320).
export interface Property {
  id: number;
  materialId: number;
}

export interface Element {
  id: number;
  type: ElementType;
  nodeIds: number[];
  propertyId: number;
}

// CAD geometry source format. The import pipeline reads STEP and IGES into the
// same OCCT shape, but a re-mesh reloads the file (the worker is torn down after
// each mesh), so the reader needs to know which format the retained bytes are.
export type GeometryFormat = "step" | "iges";

export interface StepTessellation {
  points: [number, number, number][];
  triangles: [number, number, number][];
}

export interface VolMesh {
  points: [number, number, number][];
  edges: [number, number][];
}

export interface GeometrySlice {
  nodes: Node[];
  elements: Element[];
  properties: Property[];
  modelName: string;
  stepSurface: StepTessellation | null;
  // Raw bytes of the imported STEP file, retained so the geometry can be
  // reloaded into the mesher for a re-mesh. The worker is torn down after every
  // mesh (resetWorker), discarding the OCCT shape it held, so re-meshing must
  // re-supply the original file. Not persisted in saved analyses (no STEP there).
  stepBytes: Uint8Array | null;
  // Format of the retained stepBytes — selects the OCCT reader on re-mesh.
  geometryFormat: GeometryFormat;
  isMeshing: boolean;
  volMesh: VolMesh | null;
  // Netgen surface element vertex indices (0-based, same node IDs as the volume
  // mesh) and their OCC face indices (1-based).  Both arrays have one entry per
  // surface triangle and are in Netgen surface-element order — NOT in the order
  // produced by the frontend's tet boundary extraction.  MeshScene builds a
  // sorted-vertex-key lookup to match them to tet boundary triangles correctly.
  surfaceTriangles: [number, number, number][] | null;
  surfaceFaceIds: number[] | null;
  stepImportError: string | null;

  addNode(node: Node): void;
  addElement(el: Element): void;
  addProperty(prop: Property): void;
  setStepSurface(tessellation: StepTessellation | null): void;
  setStepBytes(bytes: Uint8Array | null): void;
  setGeometryFormat(format: GeometryFormat): void;
  setVolMesh(mesh: VolMesh | null): void;
  setSurfaceFaceIds(ids: number[] | null): void;
  setMeshing(v: boolean): void;
  setStepImportError(msg: string | null): void;
  applyMeshResult(
    nodes: Node[],
    elements: Element[],
    modelName: string,
    surfaceTriangles?: [number, number, number][] | null,
    surfaceFaceIds?: number[] | null,
  ): void;
}

export const createGeometrySlice: SliceCreator<GeometrySlice> = (set) => ({
  nodes: [],
  elements: [],
  properties: [{ id: 1, materialId: 1 }],
  modelName: "",
  stepSurface: null,
  stepBytes: null,
  geometryFormat: "step",
  isMeshing: false,
  volMesh: null,
  surfaceTriangles: null,
  surfaceFaceIds: null,
  stepImportError: null,

  addNode: (node) =>
    set((s) => {
      s.nodes.push(node);
    }),
  addElement: (el) =>
    set((s) => {
      s.elements.push(el);
    }),
  addProperty: (prop) =>
    set((s) => {
      s.properties.push(prop);
    }),
  setStepBytes: (bytes) =>
    set((s) => {
      s.stepBytes = bytes;
    }),
  setGeometryFormat: (format) =>
    set((s) => {
      s.geometryFormat = format;
    }),
  setStepSurface: (tessellation) =>
    set((s) => {
      s.stepSurface = tessellation;
      // Clearing the geometry also drops the retained STEP bytes — keeping the
      // invariant "no surface ⇒ nothing left to re-mesh from".
      if (!tessellation) {
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
      if (tessellation) {
        s.fitViewTrigger++;
        s.hasStarted = true;
        s.mode = "geometry";
      }
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
  setMeshing: (v) =>
    set((s) => {
      s.isMeshing = v;
    }),
  setStepImportError: (msg) =>
    set((s) => {
      s.stepImportError = msg;
    }),

  applyMeshResult: (nodes, elements, name, surfaceTriangles, surfaceFaceIds) =>
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
      if (s.properties.length === 0) {
        const mat = s.materials[0];
        if (!mat)
          throw new Error(
            "Cannot create a default property: the model has no materials",
          );
        s.properties = [{ id: 1, materialId: mat.id }];
      }
    }),
});
