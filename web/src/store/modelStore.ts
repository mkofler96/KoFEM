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
import { bodiesLeftOutOfMesh } from "../lib/suppressBodies";
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
import {
  createTopOptSlice,
  DEFAULT_TOPOPT_SETTINGS,
  type TopOptSlice,
} from "./topOptSlice";
import { createStudySlice, type StudySlice } from "./studySlice";
import {
  createViewSlice,
  DEFAULT_DENSITY_THRESHOLD,
  addSelection,
  applyTreeSelection,
  modeSelection,
  type ViewSlice,
} from "./viewSlice";

export type {
  Node,
  ElementType,
  Property,
  Element,
  GeometryFormat,
  StepTessellation,
  VolMesh,
  GeometryVersion,
  SplitMode,
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
  TieGroup,
  TieSide,
  PickMode,
  CouplingGroup,
} from "./boundarySlice";
export {
  loadKind,
  loadComponents,
  tieFaces,
  DEFAULT_TIE_DISTANCE,
} from "./boundarySlice";
export type { TieExtent } from "../lib/tie";
export type { PickGeometry } from "../lib/facePick";
export type { CouplingKind, ReferencePointOption } from "../lib/coupling";
export { ALL_DOFS, referencePointOptions } from "../lib/coupling";
export type {
  SolverResult,
  ResultType,
  AppMode,
  LegendRange,
} from "./resultsSlice";
export { RESULT_TYPES } from "./resultsSlice";
export type {
  TopOptMethod,
  TopOptObjective,
  StressAggregation,
  TopOptSettingsState,
  TopOptNumericField,
  DensityResult,
  LiveDensity,
} from "./topOptSlice";
export { DEFAULT_TOPOPT_SETTINGS } from "./topOptSlice";
export type { LoadDisplay, ViewRepr } from "./viewSlice";
export type { Study, StudyKind, ResultPlot } from "./studySlice";

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
  TopOptSlice &
  StudySlice &
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
      // Read the mesh-time suppression from the saved mesh, not from the saved
      // flags: a body suppressed or restored after meshing and saved without
      // re-meshing must still block the solve until it is re-meshed.
      s.meshSuppressedIds =
        a.nodes.length > 0 ? bodiesLeftOutOfMesh(a.properties, a.elements) : [];
      s.bcGroups = a.bcGroups;
      s.loadGroups = a.loadGroups;
      s.tieGroups = a.tieGroups;
      s.couplingGroups = a.couplingGroups;
      s.constraints = rebuildConstraints(a.bcGroups);
      s.loads = rebuildLoads(a.loadGroups, s.nodes, a.couplingGroups);
      s.surfaceLoads = rebuildSurfaceLoads(
        a.loadGroups,
        a.elements,
        a.couplingGroups,
      );
      s.nextBcGroupId = a.nextBcGroupId;
      s.nextLoadGroupId = a.nextLoadGroupId;
      s.nextTieGroupId = a.nextTieGroupId;
      s.nextCouplingGroupId = a.nextCouplingGroupId;
      s.nextFaceEntryId = a.nextFaceEntryId;
      s.nextMatId = a.nextMatId;
      s.stepSurface = a.stepSurface;
      // Saved analyses carry the tessellated surface but not the original STEP
      // file, so re-meshing a loaded analysis requires re-importing the STEP.
      s.stepBytes = null;
      s.geometryFormat = "step";
      s.geometryHistory = [];
      s.splitPicking = false;
      s.splitFaceIds = [];
      s.splitDraft = null;
      s.splitError = null;
      s.remeshNotice = null;
      s.volMesh = a.volMesh;
      s.surfaceTriangles = a.surfaceTriangles;
      s.surfaceFaceIds = a.surfaceFaceIds;
      s.modelName = a.modelName;
      s.result = a.result;
      s.resultType = a.resultType;
      s.elementOrder = a.elementOrder;
      s.handCheck = a.handCheck;
      s.legendRange = null;
      // A saved analysis restores its static result (density is not persisted).
      s.activeResult = "static";
      // TO settings persist with the analysis; the density result does not, so a
      // freshly loaded model carries the saved setup but no stale run. Files
      // written before TO existed carry no block — fall back to the defaults.
      // eslint-disable-next-line kofem/no-silent-fallback -- topOpt is genuinely optional: pre-TO analysis files carry no settings block, and the defaults are the intended starting setup, not fabricated solver data
      s.topOpt = a.topOpt ?? { ...DEFAULT_TOPOPT_SETTINGS };
      s.isOptimizing = false;
      s.densityResult = null;
      s.liveDensity = null;
      s.viewRepr = a.viewRepr;
      s.deformScale = 1;
      s.densityThreshold = DEFAULT_DENSITY_THRESHOLD;
      // Studies and plots are not saved. A meshed analysis reopens with the
      // static study its supports and loads describe — and with the
      // optimization of it when it was saved in that step — and a saved
      // result with its field plotted.
      s.studies =
        a.nodes.length > 0
          ? [{ id: 1, kind: "static", name: "Static 1", staticId: null }]
          : [];
      if (a.nodes.length > 0 && a.mode === "optimize")
        s.studies.push({
          id: 2,
          kind: "topopt",
          name: "Optimization 1",
          staticId: 1,
        });
      s.nextStudyId = s.studies.length + 1;
      s.resultPlots = a.result
        ? [{ id: 1, source: "static", field: a.resultType }]
        : [];
      s.nextPlotId = s.resultPlots.length + 1;
      s.mode = a.mode;
      applyTreeSelection(s, modeSelection(a.mode, s));
      s.stepImportError = null;
      s.isRunning = false;
      s.isMeshing = false;
      s.selectedFace = null;
      s.pendingFaces = [];
      s.pickMode = null;
      s.pickTargetGroupId = null;
      s.pickTieSide = "a";
      s.tieDraft = { a: [], b: [] };
      s.couplingDraft = null;
      s.hasStarted = true;
      s.fitViewTrigger++;
    }),

  reset: () =>
    set((s) => {
      s.nodes = [];
      s.elements = [];
      s.materials = [DEFAULT_MATERIAL];
      s.properties = [{ id: 1, materialId: 1 }];
      s.meshSuppressedIds = [];
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
      s.modelName = "";
      s.result = null;
      s.resultType = "Displacement (magnitude)";
      s.legendRange = null;
      s.activeResult = "static";
      s.topOpt = { ...DEFAULT_TOPOPT_SETTINGS };
      s.isOptimizing = false;
      s.densityResult = null;
      s.liveDensity = null;
      s.stepSurface = null;
      s.stepBytes = null;
      s.geometryFormat = "step";
      s.geometryHistory = [];
      s.splitPicking = false;
      s.splitFaceIds = [];
      s.splitDraft = null;
      s.splitError = null;
      s.remeshNotice = null;
      s.volMesh = null;
      s.surfaceTriangles = null;
      s.surfaceFaceIds = null;
      s.viewRepr = "surface";
      s.deformScale = 1;
      s.densityThreshold = DEFAULT_DENSITY_THRESHOLD;
      s.elementOrder = 1;
      s.handCheck = null;
      s.studies = [];
      s.nextStudyId = 1;
      s.resultPlots = [];
      s.nextPlotId = 1;
      s.nextMatId = 2;
      s.selectedFace = null;
      s.pendingFaces = [];
      s.pickMode = null;
      s.pickTargetGroupId = null;
      s.pickTieSide = "a";
      s.tieDraft = { a: [], b: [] };
      s.couplingDraft = null;
      s.mode = "geometry";
      s.treeSelection = addSelection("geometry");
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
    ...createTopOptSlice(...args),
    ...createStudySlice(...args),
    ...createViewSlice(...args),
    ...createAnalysisActions(...args),
  })),
);

// Expose store on window so Playwright tests can inject BCs/loads
// without requiring 3D face-picking interactions.
(window as Window & { __kofemStore?: typeof useModelStore }).__kofemStore =
  useModelStore;
