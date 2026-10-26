// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Geometry slice: FEM nodes/elements, the imported CAD geometry (tessellation
// + retained source bytes), and the meshing pipeline state.

import { current } from "immer";
import type { ModelState, SliceCreator } from "./modelStore";
import { addSelection } from "./viewSlice";
import { carryGroupsToMesh, remeshNotice } from "../lib/remeshGroups";
import {
  rebuildConstraints,
  rebuildLoads,
  rebuildSurfaceLoads,
} from "./boundarySlice";

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
// element order); "shell" idealises thin walls as Kirchhoff shells on the
// mid-surface, retaining solid sections at planar joints. Every body
// starts "solid"; a part that is only partly thin is split into bodies first.
export type BodyDiscretization = "shell" | "solid";

export interface Property {
  id: number;
  materialId: number;
  thickness?: number;
  discretization?: BodyDiscretization;
  // A suppressed CAD body is treated as deleted — not drawn, not meshed, not
  // analysed — but keeps its place, material and settings, so un-suppressing
  // brings it back exactly as it was. Takes effect in the mesh at the next mesh.
  suppressed?: boolean;
  // Set only on the PSHELL properties the mesh-time shell idealisation derives:
  // the id of the CAD body whose thin walls they replace. Absent on the CAD
  // bodies themselves, whose own id already is the body id. The geometry view
  // needs it because a derived PSHELL has no tessellation of its own.
  sourceBodyId?: number;
}

// A property the user owns: one CAD body of the imported file. Everything else
// in `properties` is a section property the mesh derived from such a body — one
// PSHELL per wall thickness — which is part of the discretisation, not a body.
// The Bodies list, the shell-body selection and thin-wall detection all speak
// in CAD bodies; only the solver and the mesh see the derived properties.
export function isCadBody(prop: Property): boolean {
  return prop.sourceBodyId === undefined;
}

// Where the current mesh and the bodies' suppression disagree: bodies
// suppressed after the mesh was made (still in it), and bodies restored after
// it (left out of it). Either way the mesh is not the model, and solving it
// would silently analyse the wrong assembly — it must be re-meshed first.
export function suppressionMismatch(
  properties: Property[],
  meshSuppressedIds: number[],
  hasMesh: boolean,
): { stillMeshed: number[]; missing: number[] } {
  if (!hasMesh) return { stillMeshed: [], missing: [] };
  const bodies = properties.filter(isCadBody);
  const now = new Set(bodies.filter((p) => p.suppressed).map((p) => p.id));
  const atMesh = new Set(meshSuppressedIds);
  return {
    stillMeshed: [...now].filter((id) => !atMesh.has(id)).sort((a, b) => a - b),
    missing: bodies
      .filter((p) => atMesh.has(p.id) && !now.has(p.id))
      .map((p) => p.id),
  };
}

// The pre-flight line for a mesh that disagrees with the suppression, or null.
export function suppressionMismatchMessage(m: {
  stillMeshed: number[];
  missing: number[];
}): string | null {
  const bodies = (ids: number[]) => ids.map((id) => `Body ${id}`).join(", ");
  if (m.stillMeshed.length > 0)
    return `Re-mesh: suppressed ${bodies(m.stillMeshed)} still in the mesh`;
  if (m.missing.length > 0)
    return `Re-mesh: restored ${bodies(m.missing)} not in the mesh`;
  return null;
}

// The section properties the mesh derived from `bodyId`, in id order.
export function shellSectionsOf(
  properties: Property[],
  bodyId: number,
): Property[] {
  return properties.filter((p) => p.sourceBodyId === bodyId);
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
  // 1-based CAD face id of each triangle, aligned with `triangles` — the ids the
  // split tool picks and the engine's split_geometry takes, numbered like the
  // mesh's surfaceFaceIds. Absent on analyses saved before the split tool: such
  // a tessellation draws fine but its faces cannot be picked for a split.
  faceIds?: number[];
}

// A geometry the split tool can return to: the file, its view, and the body
// table that went with it (a body split renumbers the bodies).
export interface GeometryVersion {
  stepBytes: Uint8Array;
  geometryFormat: GeometryFormat;
  stepSurface: StepTessellation;
  properties: Property[];
}

// How the split tool cuts: imprint the plane on the picked faces (the part stays
// one body, the faces become several), or cut the bodies themselves in two.
export type SplitMode = "faces" | "bodies";

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
  // Geometry edits (the split tool), newest last — each entry is the geometry
  // as it was BEFORE that edit, so undo pops one. Cleared by an import or a
  // loaded analysis, which start a new geometry history.
  geometryHistory: GeometryVersion[];
  // Split-tool face picking: while on, a click on the geometry view toggles a
  // CAD face in `splitFaceIds` (the faces the next split cuts). Transient.
  splitPicking: boolean;
  splitFaceIds: number[];
  // The cut the split tool would make right now (`axis = position`, axis 0–2),
  // drawn as a plane in the geometry view while the tool is open. Transient.
  splitDraft: { axis: 0 | 1 | 2; position: number } | null;
  // Why the last split failed. In the store, not the panel: a split answers
  // after an await, and its error must still reach the user when they closed
  // the tool or left the Geometry step meanwhile.
  splitError: string | null;
  // What the last mesh did with the existing supports/loads/ties: which it
  // carried over on their CAD faces and which the user has to pick again.
  // Null when the mesh had nothing to carry. Shown by the mesh panel.
  remeshNotice: string | null;
  // The CAD bodies that were suppressed when the current mesh was made — and
  // so are missing from it. Compared with the bodies' suppression now to tell
  // whether the mesh still matches the model (suppressionMismatch).
  meshSuppressedIds: number[];

  addNode(node: Node): void;
  addElement(el: Element): void;
  addProperty(prop: Property): void;
  // Rebuild the body list after a CAD import: one property per body, all
  // defaulting to the first material (#353). Assignments are per-import —
  // body indices from different files don't correspond. Every body starts
  // Solid; Shell is the user's choice per body.
  setBodies(count: number): void;
  assignBodyMaterial(propertyId: number, materialId: number): void;
  setBodySuppressed(propertyId: number, suppressed: boolean): void;
  setBodyDiscretization(propertyId: number, disc: BodyDiscretization): void;
  setStepSurface(tessellation: StepTessellation | null): void;
  setStepBytes(bytes: Uint8Array | null): void;
  setGeometryFormat(format: GeometryFormat): void;
  setVolMesh(mesh: VolMesh | null): void;
  setSurfaceFaceIds(ids: number[] | null): void;
  setMeshing(v: boolean): void;
  setStepImportError(msg: string | null): void;
  // Replace the geometry with the result of an edit (a split): the new file and
  // its tessellation. The mesh, groups and results of the old geometry are
  // dropped — they no longer describe it. The body table survives when the body
  // count is unchanged (a face split); a body split renumbers the bodies and
  // rebuilds it as an import would.
  applyGeometryEdit(
    bytes: Uint8Array,
    tessellation: StepTessellation,
    bodyCount: number,
    // For an edit that knows where each new body came from (a Boolean): entry
    // j is the old id of new Body j+1, whose settings it inherits.
    bodySources?: number[],
  ): void;
  undoGeometryEdit(): void;
  setSplitPicking(on: boolean): void;
  toggleSplitFace(faceId: number): void;
  clearSplitFaces(): void;
  setSplitDraft(draft: { axis: 0 | 1 | 2; position: number } | null): void;
  setSplitError(message: string | null): void;
  setRemeshNotice(notice: string | null): void;
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
    // The bodies the mesh request left out as suppressed.
    meshSuppressedIds?: number[],
  ): void;
}

// One property per body, all made of the first material — the body table of a
// freshly loaded geometry (#353). A surface-only geometry reports 0 bodies;
// keep one property so the material UI stays functional (meshing fails loudly on
// its own).
function freshBodies(s: ModelState, count: number): Property[] {
  const mat = s.materials[0];
  if (!mat) throw new Error("Cannot list bodies: the model has no materials");
  return Array.from({ length: Math.max(1, count) }, (_, i) => ({
    id: i + 1,
    materialId: mat.id,
    discretization: "solid" as BodyDiscretization,
  }));
}

// Everything built ON the geometry — mesh, groups, results, transient body view
// state — which a new or edited geometry invalidates.
function dropAnalysis(s: ModelState): void {
  s.volMesh = null;
  s.viewRepr = "geometry";
  s.stepImportError = null;
  s.highlightBodyId = null;
  s.hiddenBodyIds = [];
  s.nodes = [];
  s.elements = [];
  s.meshSuppressedIds = [];
  s.surfaceTriangles = null;
  s.surfaceFaceIds = null;
  s.bcGroups = [];
  s.loadGroups = [];
  s.tieGroups = [];
  s.couplingGroups = [];
  s.constraints = [];
  s.loads = [];
  s.surfaceLoads = [];
  s.nextBcGroupId = 1;
  s.nextLoadGroupId = 1;
  s.nextTieGroupId = 1;
  s.nextCouplingGroupId = 1;
  s.nextFaceEntryId = 1;
  s.result = null;
  // New/edited geometry drops the element set a density was computed over
  // (KOF-233): clear it so the Optimize/Results steps don't read as complete
  // against a mesh that no longer exists.
  s.densityResult = null;
  s.splitPicking = false;
  s.splitFaceIds = [];
  s.splitError = null;
  s.remeshNotice = null;
  // A pick session picks on the mesh that is now gone — and an edit can land
  // while one is open on the Constraints step (a split answers after an
  // await), whose BC/load sections then unmount and could no longer end it.
  s.selectedFace = null;
  s.pendingFaces = [];
  s.pickMode = null;
  s.pickTargetGroupId = null;
  s.pickTieSide = "a";
  s.tieDraft = { a: [], b: [] };
  s.couplingDraft = null;
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
  geometryHistory: [],
  splitPicking: false,
  splitFaceIds: [],
  splitDraft: null,
  splitError: null,
  remeshNotice: null,
  meshSuppressedIds: [],

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
  setBodies: (count) =>
    set((s) => {
      s.properties = freshBodies(s, count);
    }),
  setBodySuppressed: (propertyId, suppressed) =>
    set((s) => {
      const prop = s.properties.find((p) => p.id === propertyId);
      if (!prop || !isCadBody(prop))
        throw new Error(`Cannot suppress: body ${propertyId} does not exist`);
      if (suppressed) prop.suppressed = true;
      else delete prop.suppressed;
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
      // A shell-idealised body owns no elements after meshing — its walls became
      // PSHELLs, and the solve resolves their material through those. Assigning
      // to the body alone would silently leave the shells on the old material.
      for (const section of s.properties)
        if (section.sourceBodyId === propertyId)
          section.materialId = materialId;
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
      // New (or cleared) geometry: body ids, the mesh and everything on it no
      // longer apply (issue #353), and the edits of the previous geometry are
      // not this one's to undo.
      dropAnalysis(s);
      s.geometryHistory = [];
      if (tessellation) {
        s.fitViewTrigger++;
        s.hasStarted = true;
        s.mode = "geometry";
        // Next step after an import: the mesh controls.
        s.treeSelection = addSelection("mesh");
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
  applyGeometryEdit: (bytes, tessellation, bodyCount, bodySources) =>
    set((s) => {
      if (!s.stepBytes || !s.stepSurface)
        throw new Error(
          "Cannot apply a geometry edit: no geometry is loaded to edit",
        );
      const cadBodies = s.properties.filter(isCadBody);
      s.geometryHistory.push({
        stepBytes: s.stepBytes,
        geometryFormat: s.geometryFormat,
        stepSurface: s.stepSurface,
        properties: cadBodies,
      });
      s.stepBytes = bytes;
      // The engine writes every edit as STEP, whatever the source format was.
      s.geometryFormat = "step";
      s.stepSurface = tessellation;
      // An edit that maps its bodies (a Boolean) carries each body's settings
      // to its new id. A face split keeps the bodies, so their materials and
      // element types stay; only the shell sections a mesh derived go, with the
      // mesh. A body split renumbers the bodies — start the table over, as an
      // import would.
      if (bodySources) {
        if (bodySources.length !== Math.max(1, bodyCount))
          throw new Error(
            `Geometry edit: ${bodySources.length} body sources for ${bodyCount} bodies`,
          );
        s.properties = bodySources.map((sourceId, j) => {
          const source = cadBodies.find((p) => p.id === sourceId);
          if (!source)
            throw new Error(
              `Geometry edit: new Body ${j + 1} comes from Body ${sourceId}, which does not exist`,
            );
          return { ...source, id: j + 1 };
        });
      } else
        s.properties =
          cadBodies.length === Math.max(1, bodyCount)
            ? cadBodies
            : freshBodies(s, bodyCount);
      dropAnalysis(s);
    }),
  undoGeometryEdit: () =>
    set((s) => {
      const previous = s.geometryHistory.pop();
      if (!previous)
        throw new Error("Cannot undo: there is no geometry edit to undo");
      s.stepBytes = previous.stepBytes;
      s.geometryFormat = previous.geometryFormat;
      s.stepSurface = previous.stepSurface;
      s.properties = previous.properties;
      dropAnalysis(s);
    }),
  setSplitPicking: (on) =>
    set((s) => {
      s.splitPicking = on;
    }),
  toggleSplitFace: (faceId) =>
    set((s) => {
      s.splitFaceIds = s.splitFaceIds.includes(faceId)
        ? s.splitFaceIds.filter((id) => id !== faceId)
        : [...s.splitFaceIds, faceId];
    }),
  clearSplitFaces: () =>
    set((s) => {
      s.splitFaceIds = [];
    }),
  setSplitDraft: (draft) =>
    set((s) => {
      s.splitDraft = draft;
    }),
  setSplitError: (message) =>
    set((s) => {
      s.splitError = message;
    }),
  setRemeshNotice: (notice) =>
    set((s) => {
      s.remeshNotice = notice;
    }),

  applyMeshResult: (
    nodes,
    elements,
    name,
    surfaceTriangles,
    surfaceFaceIds,
    properties,
    meshSuppressedIds,
  ) =>
    set((s) => {
      s.nodes = nodes;
      s.meshSuppressedIds = meshSuppressedIds ?? [];
      s.elements = elements;
      if (properties) s.properties = properties;
      s.surfaceTriangles = surfaceTriangles ?? null;
      s.surfaceFaceIds = surfaceFaceIds ?? null;
      // Groups picked on whole CAD faces follow those faces onto the new mesh
      // (lib/remeshGroups); the rest are cleared and named in the notice. The
      // id counters run on, so a carried group's id is never handed out again.
      const before = current(s);
      const carried = carryGroupsToMesh(
        {
          bcGroups: before.bcGroups,
          loadGroups: before.loadGroups,
          tieGroups: before.tieGroups,
          couplingGroups: before.couplingGroups,
        },
        surfaceTriangles ?? null,
        surfaceFaceIds ?? null,
        new Set(nodes.map((n) => n.id)),
      );
      s.bcGroups = carried.bcGroups;
      s.loadGroups = carried.loadGroups;
      s.tieGroups = carried.tieGroups;
      s.couplingGroups = [];
      s.constraints = rebuildConstraints(carried.bcGroups);
      s.loads = rebuildLoads(carried.loadGroups, nodes, []);
      s.surfaceLoads = rebuildSurfaceLoads(carried.loadGroups, elements, []);
      s.remeshNotice = remeshNotice(carried);
      s.result = null;
      // A fresh mesh changes the element set, so any density from a prior run is
      // stale (KOF-233) — drop it alongside the static result.
      s.densityResult = null;
      s.selectedFace = null;
      s.pendingFaces = [];
      s.pickMode = null;
      s.pickTargetGroupId = null;
      s.pickTieSide = "a";
      s.tieDraft = { a: [], b: [] };
      s.couplingDraft = null;
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
