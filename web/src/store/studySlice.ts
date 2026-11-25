// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Study slice: the analyses the model tree lists under Studies (a static solve,
// and a topology optimization or a mesh refinement study built on a static
// case) and the result plots under Results. Both are setup, not output: they survive a re-mesh or a cleared
// result, and a plot whose run is gone shows that instead of disappearing.

import type { ModelState, SliceCreator } from "./modelStore";
import type { ActiveResult, ResultSection, ResultType } from "./resultsSlice";
import {
  DEFAULT_REFINEMENT_INPUT,
  studyFingerprint,
  type RefinementSettings,
  type RefinementSettingsInput,
  type StudyLevel,
} from "../lib/refinementStudy";
import { endPickSessionOutside } from "./pickSlice";
import type { ReactionDisplay } from "../lib/reactionArrows";
import {
  addSelection,
  applyTreeSelection,
  itemSelection,
  REACTIONS_ITEM_ID,
} from "./viewSlice";
import { tr } from "../i18n/useLocale";
import { studiesMessages } from "../i18n/messages/studies";

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

// One result view: which run it shows and, for a static run, which field and
// its section cut (KOF-390), a result output the user adds under the plot.
export interface ResultPlot {
  id: number;
  source: PlotSource;
  field: ResultType | null;
  section: ResultSection | null;
}

// Where a new cut starts: across x, through the middle, keeping the part below.
export const NEW_SECTION: ResultSection = {
  axis: 0,
  position: 0.5,
  flipped: false,
};

function checkSection(section: ResultSection): void {
  if (!(
    [0, 1, 2].includes(section.axis) &&
    Number.isFinite(section.position) &&
    section.position >= 0 &&
    section.position <= 1
  ))
    throw new Error(
      `section needs axis 0, 1 or 2 and a position in [0, 1], got axis ${section.axis}, position ${section.position}`,
    );
}

// The cut the viewport draws: the shown plot's. A new or removed cut drops the
// last cut's measured range and error.
function drawSection(s: ModelState, section: ResultSection | null): void {
  if (section === null || s.section === null) {
    s.sectionRange = null;
    s.sectionError = null;
  }
  s.section = section === null ? null : { ...section };
}

export const STUDY_KIND_LABEL: Record<StudyKind, string> = {
  static: "Static",
  topopt: "Optimization",
  refinement: "Mesh refinement",
};

export function plotLabel(plot: ResultPlot): string {
  if (plot.source === "density") return tr(studiesMessages).density;
  if (plot.source === "refinement") return tr(studiesMessages).refinementKind;
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
    section: null,
  };
  s.resultPlots.push(plot);
  return plot;
}

// What the viewport shows for a plot: its run, its field and its cut.
export function showPlot(s: ModelState, plot: ResultPlot): void {
  s.shownPlotId = plot.id;
  drawSection(s, plot.section);
  s.activeResult = plot.source === "refinement" ? "static" : plot.source;
  if (plot.field !== null && s.resultType !== plot.field) {
    s.resultType = plot.field;
    s.legendRange = null;
  }
}

// A mesh refinement study (KOF-401): the levels solved so far and how the run
// ended. It is a record of meshes that are gone once the model is re-meshed,
// so it stays until the next study or a new geometry.
// Everything that makes a level the model's mesh and result again: the mesh,
// the supports and loads resolved on its nodes, and its solve. The arrays are
// the ones the store held at that level, shared, not copied.
export type RefinementLevelSnapshot = Pick<
  ModelState,
  | "nodes"
  | "elements"
  | "properties"
  | "surfaceTriangles"
  | "surfaceFaceIds"
  | "meshSizes"
  | "meshSuppressedIds"
  | "bcGroups"
  | "loadGroups"
  | "tieGroups"
  | "couplingGroups"
  | "constraints"
  | "loads"
  | "surfaceLoads"
  | "result"
>;

export interface RefinementStudyRun {
  status: "running" | "done" | "failed";
  // The settings the study ran with: its verdict is judged by them, whatever
  // the panel holds since.
  settings: RefinementSettings;
  // What the study is doing right now; null once it has ended.
  step: string | null;
  // What the level being worked on is at, for its row; null once ended.
  phase: "meshing" | "solving" | null;
  // The max element size of each planned level, so the levels still to come
  // can be listed while the study runs.
  plannedSizes: number[];
  levels: StudyLevel[];
  // One per solved level, in level order.
  snapshots: RefinementLevelSnapshot[];
  // The physical model the levels solved (studyFingerprint). A level can only
  // be opened while the model still matches it.
  fingerprint: string;
  // Why the study solved fewer levels than planned (the next mesh would be too
  // large for the browser), or null.
  stopNote: string | null;
  error: string | null;
}

// The centre shows the convergence chart in place of the 3D view: Results →
// Mesh refinement is open, with no level of it opened.
export function refinementChartVisible(s: ModelState): boolean {
  if (
    s.mode !== "results" ||
    s.refinementStudy === null ||
    s.refinementLevelShown !== null
  )
    return false;
  const { target } = s.treeSelection;
  if (target.type !== "item" || target.kind !== "plot") return false;
  return s.resultPlots.some(
    (p) => p.id === target.id && p.source === "refinement",
  );
}

export interface StudySlice {
  studies: Study[];
  nextStudyId: number;
  resultPlots: ResultPlot[];
  // The plot on the viewport (its run, field and cut), or null.
  shownPlotId: number | null;
  // Whether Results lists the support reactions, a result output added from
  // + Add (KOF-387). One per model; it reads the latest static solve.
  showReactions: boolean;
  // Whether the view draws one reaction arrow per support or per held node.
  reactionsDisplay: ReactionDisplay;
  // Whether the view shows the reactions (their tree row is selected) instead
  // of the shown plot's field.
  reactionsShown: boolean;
  nextPlotId: number;
  refinementStudy: RefinementStudyRun | null;
  // The level the centre shows in 3D, or null for the convergence chart.
  refinementLevelShown: number | null;
  // The study's settings as typed (KOF-424); parsed and checked when it runs
  // (parseRefinementSettings).
  refinementInput: RefinementSettingsInput;

  addStudy(kind: StudyKind, staticId?: number): number;
  setStudyStatic(id: number, staticId: number): void;
  deleteStudy(id: number): void;
  addResultPlot(source: PlotSource, field: ResultType | null): number;
  // The section cut of a static plot: added as a result output under it,
  // changed or (null) removed from its own panel.
  addPlotSection(plotId: number): void;
  // Add the reactions output and open it; it needs a static solve.
  addReactions(): void;
  deleteReactions(): void;
  setReactionsDisplay(display: ReactionDisplay): void;
  setPlotSection(plotId: number, section: ResultSection | null): void;
  setPlotField(id: number, field: ResultType): void;
  deleteResultPlot(id: number): void;
  setRefinementStudy(run: RefinementStudyRun | null): void;
  setRefinementSetting(
    field: keyof RefinementSettingsInput,
    value: string,
  ): void;
  // Open the refinement study's result under Results, adding its plot when
  // there is none yet.
  showRefinementResult(): void;
  // Show a level — make its mesh and solve the model's again — or, with null,
  // the convergence chart.
  showRefinementLevel(level: number | null): void;
}

export const createStudySlice: SliceCreator<StudySlice> = (set, get) => ({
  studies: [],
  nextStudyId: 1,
  resultPlots: [],
  shownPlotId: null,
  showReactions: false,
  reactionsDisplay: "nodal",
  reactionsShown: false,
  nextPlotId: 1,
  refinementStudy: null,
  refinementLevelShown: null,
  refinementInput: { ...DEFAULT_REFINEMENT_INPUT },

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
        section: null,
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
      if (s.shownPlotId === id) {
        s.shownPlotId = null;
        drawSection(s, null);
      }
    }),
  addReactions: () =>
    set((s) => {
      if (s.result === null)
        throw new Error("reactions need a static solve to read");
      if (s.showReactions) throw new Error("Results already lists reactions");
      s.showReactions = true;
      applyTreeSelection(
        s,
        itemSelection("results", "reactions", REACTIONS_ITEM_ID),
      );
    }),
  deleteReactions: () =>
    set((s) => {
      if (!s.showReactions) throw new Error("Results lists no reactions");
      s.showReactions = false;
      applyTreeSelection(s, addSelection("results"));
    }),
  setReactionsDisplay: (display) =>
    set((s) => {
      s.reactionsDisplay = display;
    }),
  addPlotSection: (plotId) =>
    set((s) => {
      const plot = s.resultPlots.find((p) => p.id === plotId);
      if (!plot || plot.source !== "static")
        throw new Error(`Result plot ${plotId} has no field to cut`);
      if (plot.section !== null)
        throw new Error(`Result plot ${plotId} already has a section cut`);
      plot.section = { ...NEW_SECTION };
      applyTreeSelection(s, itemSelection("results", "section", plotId));
    }),
  setPlotSection: (plotId, section) =>
    set((s) => {
      const plot = s.resultPlots.find((p) => p.id === plotId);
      if (!plot || plot.section === null)
        throw new Error(`Result plot ${plotId} has no section cut`);
      if (section !== null) checkSection(section);
      plot.section = section === null ? null : { ...section };
      if (s.shownPlotId === plotId) drawSection(s, section);
      if (section === null)
        applyTreeSelection(s, itemSelection("results", "plot", plotId));
    }),
  setRefinementStudy: (run) =>
    set((s) => {
      s.refinementStudy = run;
      s.refinementLevelShown = null;
    }),
  setRefinementSetting: (field, value) =>
    set((s) => {
      s.refinementInput[field] = value;
    }),
  showRefinementLevel: (level) => {
    const run = get().refinementStudy;
    if (run === null) throw new Error("There is no refinement study to show");
    if (level === null) {
      set((s) => {
        s.refinementLevelShown = null;
      });
      return;
    }
    if (run.status === "running")
      throw new Error("The study's levels open once it has finished");
    const snapshot = run.snapshots[level];
    if (snapshot === undefined)
      throw new Error(
        `The study has no level ${level + 1} — it solved ${run.snapshots.length}`,
      );
    if (studyFingerprint(get()) !== run.fingerprint)
      throw new Error(
        "The model changed since the study ran, so its levels are another model's. Run the study again.",
      );
    set((s) => {
      Object.assign(s, snapshot);
      s.refinementLevelShown = level;
      // Probes on CAD faces read the level's mesh; others belonged to the old.
      s.probes = s.probes.filter((p) => p.cadFaceId !== undefined);
      s.probing = false;
      s.remeshNotice = null;
      s.densityResult = null;
      s.selectedFace = null;
      s.pendingFaces = [];
      s.pickMode = null;
      s.activeResult = "static";
      s.legendRange = null;
    });
  },
  showRefinementResult: () =>
    set((s) => {
      const plot = ensurePlot(s, "refinement");
      s.mode = "results";
      endPickSessionOutside(s, s.mode);
      s.treeSelection = {
        group: "results",
        target: { type: "item", kind: "plot", id: plot.id },
      };
      showPlot(s, plot);
    }),
});
