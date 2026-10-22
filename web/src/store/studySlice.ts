// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Study slice: the analyses the model tree lists under Studies (a static solve,
// a topology optimization built on a static case) and the result plots under
// Results. Both are setup, not output: they survive a re-mesh or a cleared
// result, and a plot whose run is gone shows that instead of disappearing.

import type { ModelState, SliceCreator } from "./modelStore";
import type { ActiveResult, ResultType } from "./resultsSlice";

export type StudyKind = "static" | "topopt";

export interface Study {
  id: number;
  kind: StudyKind;
  name: string;
  // Optimization only: the static study whose supports and loads it optimizes
  // for. Null when that study was deleted — the optimization cannot run then.
  staticId: number | null;
}

// One result view: which run it shows (the static solve or the optimization's
// density field) and, for a static run, which field.
export interface ResultPlot {
  id: number;
  source: ActiveResult;
  field: ResultType | null;
}

export const STUDY_KIND_LABEL: Record<StudyKind, string> = {
  static: "Static",
  topopt: "Optimization",
};

export function plotLabel(plot: ResultPlot): string {
  if (plot.source === "density") return "Density";
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
export function ensurePlot(s: ModelState, source: ActiveResult): ResultPlot {
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
  s.activeResult = plot.source;
  if (plot.field !== null && s.resultType !== plot.field) {
    s.resultType = plot.field;
    s.legendRange = null;
  }
}

export interface StudySlice {
  studies: Study[];
  nextStudyId: number;
  resultPlots: ResultPlot[];
  nextPlotId: number;

  addStudy(kind: StudyKind, staticId?: number): number;
  setStudyStatic(id: number, staticId: number): void;
  deleteStudy(id: number): void;
  addResultPlot(source: ActiveResult, field: ResultType | null): number;
  setPlotField(id: number, field: ResultType): void;
  deleteResultPlot(id: number): void;
}

export const createStudySlice: SliceCreator<StudySlice> = (set, get) => ({
  studies: [],
  nextStudyId: 1,
  resultPlots: [],
  nextPlotId: 1,

  addStudy: (kind, staticId) => {
    if (kind === "topopt") {
      const base = get().studies.find(
        (st) => st.id === staticId && st.kind === "static",
      );
      if (!base)
        throw new Error(
          `An optimization needs a static study to optimize for — got ${String(staticId)}`,
        );
    }
    const id = get().nextStudyId;
    set((s) => {
      const n = s.studies.filter((st) => st.kind === kind).length + 1;
      s.studies.push({
        id,
        kind,
        name: `${STUDY_KIND_LABEL[kind]} ${n}`,
        staticId: kind === "topopt" ? (staticId as number) : null,
      });
      s.nextStudyId = id + 1;
    });
    return id;
  },
  setStudyStatic: (id, staticId) =>
    set((s) => {
      const study = s.studies.find((st) => st.id === id);
      if (!study || study.kind !== "topopt")
        throw new Error(`Study ${id} is not an optimization`);
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
});
