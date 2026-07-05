// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Thin combiner (issue #202): the model store is assembled from focused
// slices, each owning one area of state:
//
//   geometrySlice — nodes/elements, imported CAD geometry, meshing pipeline
//   materialSlice — material definitions + CRUD
//   boundarySlice — BC / load groups and the solver-facing flat arrays
//   resultsSlice  — solver output, solve settings, stage transitions
//   viewSlice     — transient viewport presentation settings
//   momentLoad    — pure math (moment → equivalent nodal forces), no Zustand
//
// Whole-model lifecycle actions that cut across every slice (loadAnalysis,
// reset) live here. All public types and helpers are re-exported so consumers
// keep importing from "store/modelStore".

import { create } from "zustand";
import type { StateCreator } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { AnalysisState } from "../lib/analysisFile";
import { createGeometrySlice, type GeometrySlice } from "./geometrySlice";
import {
  createMaterialSlice,
  DEFAULT_MATERIAL,
  MATERIAL_PALETTE,
  type MaterialSlice,
} from "./materialSlice";
import {
  createBoundarySlice,
  rebuildConstraints,
  rebuildLoads,
  rebuildSurfaceLoads,
  type BoundarySlice,
} from "./boundarySlice";
import { createResultsSlice, type ResultsSlice } from "./resultsSlice";
import { createViewSlice, type ViewSlice } from "./viewSlice";

export type {
  Node,
  ElementType,
  Property,
  Element,
  GeometryFormat,
  StepTessellation,
  VolMesh,
} from "./geometrySlice";
export type { Material } from "./materialSlice";
export type {
  Constraint,
  Load,
  FaceSelection,
  BcFaceEntry,
  NamedBcGroup,
  LoadKind,
  NamedLoadGroup,
  SurfaceLoad,
} from "./boundarySlice";
export { loadKind, loadComponents } from "./boundarySlice";
export type { SolverResult, ResultType, AppMode } from "./resultsSlice";
export { RESULT_TYPES } from "./resultsSlice";
export type { LoadDisplay, ViewRepr } from "./viewSlice";

// Whole-model lifecycle actions — they touch every slice, so they live in the
// combiner rather than in any single slice.
interface AnalysisActions {
  loadAnalysis(analysis: AnalysisState): void;
  reset(): void;
}

export type ModelState = GeometrySlice &
  MaterialSlice &
  BoundarySlice &
  ResultsSlice &
  ViewSlice &
  AnalysisActions;

// Common shape of a slice creator: `set` drafts the full combined state, so
// cross-slice transitions (e.g. a new mesh clearing BC groups and results)
// stay type-checked against the whole store.
export type SliceCreator<T> = StateCreator<
  ModelState,
  [["zustand/immer", never]],
  [],
  T
>;

const createAnalysisActions: SliceCreator<AnalysisActions> = (set) => ({
  // Restore a complete analysis parsed from a saved .vtu file — the inverse
  // of serializeAnalysis. Keeps the saved named groups, results, and
  // view/mode state instead of rebuilding.
  loadAnalysis: (a) =>
    set((s) => {
      s.nodes = a.nodes;
      s.elements = a.elements;
      // Analyses saved before per-body colours (issue #353) carry no material
      // colour — backfill from the palette so the geometry view can paint them.
      s.materials = a.materials.map((m, i) => ({
        ...m,
        color: m.color ?? MATERIAL_PALETTE[i % MATERIAL_PALETTE.length],
      }));
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
      s.materials = [DEFAULT_MATERIAL];
      s.properties = [{ id: 1, materialId: 1 }];
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
      s.resultType = "Displacement (magnitude)";
      s.stepSurface = null;
      s.stepBytes = null;
      s.geometryFormat = "step";
      s.volMesh = null;
      s.surfaceTriangles = null;
      s.surfaceFaceIds = null;
      s.viewRepr = "surface";
      s.deformScale = 1;
      s.elementOrder = 1;
      s.nextMatId = 2;
      s.selectedFace = null;
      s.pendingFaces = [];
      s.pickMode = null;
      s.pickTargetGroupId = null;
      s.mode = "geometry";
      s.stepImportError = null;
      s.isRunning = false;
      s.isMeshing = false;
      s.hasStarted = false;
      s.highlightBodyId = null;
      s.hiddenBodyIds = [];
    }),
});

export const useModelStore = create<ModelState>()(
  immer((...args) => ({
    ...createGeometrySlice(...args),
    ...createMaterialSlice(...args),
    ...createBoundarySlice(...args),
    ...createResultsSlice(...args),
    ...createViewSlice(...args),
    ...createAnalysisActions(...args),
  })),
);

// Expose store on window so Playwright tests can inject BCs/loads
// without requiring 3D face-picking interactions.
(window as Window & { __kofemStore?: typeof useModelStore }).__kofemStore =
  useModelStore;
