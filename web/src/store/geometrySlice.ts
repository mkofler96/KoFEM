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

// Solid elements from the live OCCT → Netgen → MFEM pipeline: tetrahedra
// (CTETRA) and hexahedra (CHEXA). CTRIA3 is a 3-node Kirchhoff shell triangle
// (DKT bending + CST membrane, 6 DOF/node) solved by the engine's solve_shell;
// shell models currently enter the app via saved analyses (.vtu), not the
// meshing pipeline. 1D (beam) elements are not modelled.
export type ElementType = "CTETRA" | "CHEXA" | "CTRIA3";

// Body → material mapping (#317/#353). One property per body of the imported
// assembly: the property id is the 1-based body (CAD solid) index — the same
// index Netgen assigns the body's tets as their mesh domain, carried on each
// element as `propertyId` — and `materialId` names the material the body is
// made of. The solver resolves every element's material through this mapping.
// For shell (CTRIA3) elements the property additionally carries the shell
// `thickness` (mm) — PSHELL semantics: thickness is a section property of the
// idealised wall, not a material constant. Required on properties referenced
// by shell elements; meaningless (and absent) on solid bodies.
// How a body is discretised for the solve, chosen per body before meshing.
// "solid" meshes the body as tetrahedra (linear or quadratic per the global
// element order); "shell" idealises its thin walls as Kirchhoff shells coupled to
// the solid bodies (the auto-shell path). Thin-walled bodies are auto-preselected
// "shell" at import (detectShellBodies); the user can switch any body.
export type BodyDiscretization = "shell" | "solid";

export interface Property {
  id: number;
  materialId: number;
  thickness?: number;
  discretization?: BodyDiscretization;
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
  // 1-based body (CAD solid) index of each triangle, aligned with `triangles`
  // (issue #353) — lets the geometry view colour, highlight and hide each body.
  // Absent on analyses saved before per-body colours; the viewer then treats
  // every triangle as body 1.
  bodyIds?: number[];
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
  // Rebuild the body list after a CAD import: one property per body, all
  // defaulting to the first material (#353). Assignments are per-import —
  // body indices from different files don't correspond. `shellBodyIds` (1-based
  // body ids detected as thin-walled) preselect those bodies as shells.
  setBodies(count: number, shellBodyIds?: number[]): void;
  assignBodyMaterial(propertyId: number, materialId: number): void;
  setBodyDiscretization(propertyId: number, disc: BodyDiscretization): void;
  // Re-apply an automatic thin-wall detection result: sets each body's
  // discretization from `shellBodyIds` (1-based) WITHOUT rebuilding the property
  // table, so per-body material assignments survive. Pass an empty list to make
  // every body Solid (automatic detection switched off).
  applyShellDetection(shellBodyIds: number[]): void;
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
    // Property table returned by a mesh that idealised thin walls as shells
    // (#397): the solid bodies' own properties plus one PSHELL per distinct wall
    // thickness. Absent for a plain all-solid mesh, which leaves properties as-is.
    properties?: Property[] | null,
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
  setBodies: (count, shellBodyIds) =>
    set((s) => {
      const mat = s.materials[0];
      if (!mat)
        throw new Error("Cannot list bodies: the model has no materials");
      // A surface-only import reports 0 bodies; keep one property so the
      // material UI stays functional (meshing fails loudly on its own).
      const n = Math.max(1, count);
      const shell = new Set(shellBodyIds ?? []);
      s.properties = Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        materialId: mat.id,
        discretization: shell.has(i + 1)
          ? ("shell" as BodyDiscretization)
          : ("solid" as BodyDiscretization),
      }));
    }),
  applyShellDetection: (shellBodyIds) =>
    set((s) => {
      const shell = new Set(shellBodyIds);
      for (const prop of s.properties)
        prop.discretization = shell.has(prop.id)
          ? ("shell" as BodyDiscretization)
          : ("solid" as BodyDiscretization);
    }),
  setBodyDiscretization: (propertyId, disc) =>
    set((s) => {
      const prop = s.properties.find((p) => p.id === propertyId);
      if (!prop)
        throw new Error(
          `Cannot set element type: body ${propertyId} does not exist`,
        );
      prop.discretization = disc;
    }),
  assignBodyMaterial: (propertyId, materialId) =>
    set((s) => {
      const prop = s.properties.find((p) => p.id === propertyId);
      if (!prop)
        throw new Error(
          `Cannot assign material: body ${propertyId} does not exist`,
        );
      if (!s.materials.some((m) => m.id === materialId))
        throw new Error(
          `Cannot assign material: material ${materialId} does not exist`,
        );
      prop.materialId = materialId;
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
      // New (or cleared) geometry: body ids no longer apply, drop the transient
      // per-body view state (issue #353).
      s.highlightBodyId = null;
      s.hiddenBodyIds = [];
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

  applyMeshResult: (
    nodes,
    elements,
    name,
    surfaceTriangles,
    surfaceFaceIds,
    properties,
  ) =>
    set((s) => {
      s.nodes = nodes;
      s.elements = elements;
      if (properties) s.properties = properties;
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
      // Every body present in the mesh needs a material assignment. The bodies
      // were listed at import (setBodies), so this only fills gaps — e.g. a
      // model built without a CAD import, or a body count that changed because
      // meshing split/merged domains unexpectedly.
      const knownBodies = new Set(s.properties.map((p) => p.id));
      const meshBodies = new Set(elements.map((e) => e.propertyId));
      for (const bodyId of [...meshBodies].sort((a, b) => a - b)) {
        if (knownBodies.has(bodyId)) continue;
        const mat = s.materials[0];
        if (!mat)
          throw new Error(
            `Cannot create a material assignment for body ${bodyId}: the model has no materials`,
          );
        s.properties.push({ id: bodyId, materialId: mat.id });
      }
    }),
});
