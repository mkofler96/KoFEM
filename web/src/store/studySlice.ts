// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Study slice: the analyses the model tree lists under Studies (a static solve,
// and a topology optimization or a mesh refinement study built on a static
// case) and the result plots under Results. Both are setup, not output: they survive a re-mesh or a cleared
// result, and a plot whose run is gone shows that instead of disappearing.

import type { ModelState, SliceCreator } from "./modelStore";
import type { ActiveResult, ResultType } from "./resultsSlice";
import type { StudyLevel } from "../lib/refinementStudy";

export type StudyKind = "static" | "topopt" | "refinement";

export interface Study {
  id: number;
  kind: StudyKind;
  name: string;
  // Optimization and refinement study: the static study whose supports and
  // loads it works on. Null when that study was deleted — it cannot run then.
  staticId: number | null;
}

// The kinds of study built on a static case.
export type DerivedStudyKind = Exclude<StudyKind, "static">;

export function isDerivedKind(kind: StudyKind): kind is DerivedStudyKind {
  return kind !== "static";
}

// What a result plot shows: the static solve, the optimization's density
// field, or the mesh refinement study's levels and verdict (KOF-401). The
// viewport shows the refinement study's finest solve, a static result.
export type PlotSource = ActiveResult | "refinement";

// One result view: which run it shows and, for a static run, which field.
export interface ResultPlot {
  id: number;
  source: PlotSource;
  field: ResultType | null;
}

export const STUDY_KIND_LABEL: Record<StudyKind, string> = {
  static: "Static",
  topopt: "Optimization",
  refinement: "Mesh refinement",
};

export function plotLabel(plot: ResultPlot): string {
  if (plot.source === "density") return "Density";
  if (plot.source === "refinement") return "Mesh refinement";
  if (plot.field === null)
    throw new Error(`Result plot ${plot.id} of the static solve has no field`);
  return plot.field;
}

// The study a run of `kind` belongs to — the first of that kind.
export function studyOf(studies: Study[], kind: StudyKind): Study | undefined {
  return studies.find((st) => st.kind === kind);
}

// A run that just finished gets a plot when it has none yet, so the hand-off to
// Results lands on something to look at. Returns the plot to show.
export function ensurePlot(s: ModelState, source: PlotSource): ResultPlot {
  const existing = s.resultPlots.find((p) => p.source === source);
  if (existing) return existing;
  const plot: ResultPlot = {
    id: s.nextPlotId++,
    source,
    field: source === "static" ? "Displacement (magnitude)" : null,
  };
  s.resultPlots.push(plot);
  return plot;
}

// What the viewport shows for a plot: its run, and its field.
export function showPlot(s: ModelState, plot: ResultPlot): void {
  s.activeResult = plot.source === "refinement" ? "static" : plot.source;
  if (plot.field !== null && s.resultType !== plot.field) {
    s.resultType = plot.field;
    s.legendRange = null;
  }
}

// A mesh refinement study (KOF-401): the levels solved so far and how the run
// ended. It is a record of meshes that are gone once the model is re-meshed,
// so it stays until the next study or a new geometry.
export interface RefinementStudyRun {
  status: "running" | "done" | "failed";
  // What the study is doing right now; null once it has ended.
  step: string | null;
  levels: StudyLevel[];
  // Why the study solved fewer levels than planned (the next mesh would be too
  // large for the browser), or null.
  stopNote: string | null;
  error: string | null;
}

export interface StudySlice {
  studies: Study[];
  nextStudyId: number;
  resultPlots: ResultPlot[];
  nextPlotId: number;
  refinementStudy: RefinementStudyRun | null;

  addStudy(kind: StudyKind, staticId?: number): number;
  setStudyStatic(id: number, staticId: number): void;
  deleteStudy(id: number): void;
  addResultPlot(source: PlotSource, field: ResultType | null): number;
  setPlotField(id: number, field: ResultType): void;
  deleteResultPlot(id: number): void;
  setRefinementStudy(run: RefinementStudyRun | null): void;
  // Open the refinement study's result under Results, adding its plot when
  // there is none yet.
  showRefinementResult(): void;
}

export const createStudySlice: SliceCreator<StudySlice> = (set, get) => ({
  studies: [],
  nextStudyId: 1,
  resultPlots: [],
  nextPlotId: 1,
  refinementStudy: null,

  addStudy: (kind, staticId) => {
    if (isDerivedKind(kind)) {
      const base = get().studies.find(
        (st) => st.id === staticId && st.kind === "static",
      );
      if (!base)
        throw new Error(
          `${STUDY_KIND_LABEL[kind]} needs a static study to work on — got ${String(staticId)}`,
        );
    }
    const id = get().nextStudyId;
    set((s) => {
      const n = s.studies.filter((st) => st.kind === kind).length + 1;
      s.studies.push({
        id,
        kind,
        name: `${STUDY_KIND_LABEL[kind]} ${n}`,
        staticId: isDerivedKind(kind) ? (staticId as number) : null,
      });
      s.nextStudyId = id + 1;
    });
    return id;
  },
  setStudyStatic: (id, staticId) =>
    set((s) => {
      const study = s.studies.find((st) => st.id === id);
      if (!study || !isDerivedKind(study.kind))
        throw new Error(`Study ${id} is not built on a static study`);
      if (!s.studies.some((st) => st.id === staticId && st.kind === "static"))
        throw new Error(`Study ${staticId} is not a static study`);
      study.staticId = staticId;
    }),
  deleteStudy: (id) =>
    set((s) => {
      s.studies = s.studies.filter((st) => st.id !== id);
      for (const st of s.studies) if (st.staticId === id) st.staticId = null;
    }),
  addResultPlot: (source, field) => {
    const id = get().nextPlotId;
    set((s) => {
      s.resultPlots.push({
        id,
        source,
        field: source === "static" ? field : null,
      });
      s.nextPlotId = id + 1;
    });
    return id;
  },
  setPlotField: (id, field) =>
    set((s) => {
      const plot = s.resultPlots.find((p) => p.id === id);
      if (!plot || plot.source !== "static")
        throw new Error(`Result plot ${id} has no field to set`);
      plot.field = field;
      showPlot(s, plot);
    }),
  deleteResultPlot: (id) =>
    set((s) => {
      s.resultPlots = s.resultPlots.filter((p) => p.id !== id);
    }),
  setRefinementStudy: (run) =>
    set((s) => {
      s.refinementStudy = run;
    }),
  showRefinementResult: () =>
    set((s) => {
      const plot = ensurePlot(s, "refinement");
      s.mode = "results";
      s.treeSelection = {
        group: "results",
        target: { type: "item", kind: "plot", id: plot.id },
      };
      showPlot(s, plot);
    }),
});
