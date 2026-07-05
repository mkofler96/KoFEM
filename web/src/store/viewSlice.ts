// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// View slice: transient viewport presentation settings — none of this is
// persisted in saved analyses except viewRepr.

import type { SliceCreator } from "./modelStore";

// How load glyphs are drawn in the viewport. "resultant" shows one arrow per
// force/pressure group at the centroid of its loaded nodes (the statically
// equivalent load the user specifies). "nodal" shows the work-equivalent load
// each individual node carries — the per-node tributary share of the group total
// — which is what actually reaches the solver as a surface traction (issue #196).
export type LoadDisplay = "resultant" | "nodal";

export type ViewRepr = "geometry" | "surface" | "volume" | "wireframe";

// Sidebar sizing (issue #339). Width is persisted so the user's preferred
// split survives reloads; the open/closed state is derived from screen size
// on startup (collapsed on small screens, expanded on desktop).
export const SIDEBAR_DEFAULT_WIDTH = 340;
export const SIDEBAR_MIN_WIDTH = 260;
export const SIDEBAR_MAX_WIDTH = 560;
// Must match the @media breakpoints in Sidebar.module.css.
export const SMALL_SCREEN_QUERY = "(max-width: 768px)";

const SIDEBAR_WIDTH_KEY = "kofem.sidebarWidth";

function clampSidebarWidth(w: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w));
}

function initialSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0
    ? clampSidebarWidth(stored)
    : SIDEBAR_DEFAULT_WIDTH;
}

export interface ViewSlice {
  viewRepr: ViewRepr;
  showUndeformedOverlay: boolean;
  // Whether load glyphs are drawn as a single resultant per group or as one
  // arrow per loaded node (issue #196). A transient view setting, not persisted.
  loadDisplay: LoadDisplay;
  // Deformation magnification applied to the result on top of the automatic
  // fit-to-view scale. 1 = the default visible deformation, 0 = undeformed.
  deformScale: number;
  fitViewTrigger: number;
  // Sidebar layout (issue #339): collapsed on small screens so the viewport
  // gets the full width, resizable on desktop.
  sidebarOpen: boolean;
  sidebarWidth: number;

  // Body (CAD solid) presentation in the geometry view (issue #353). Both are
  // transient — not persisted. highlightBodyId is the body whose material is
  // being assigned right now: when set, every OTHER body is dimmed so the one
  // in question stands out. hiddenBodyIds are bodies toggled off via the eye
  // control and not drawn at all.
  highlightBodyId: number | null;
  hiddenBodyIds: number[];

  setViewRepr(v: ViewRepr): void;
  setShowUndeformedOverlay(v: boolean): void;
  setLoadDisplay(v: LoadDisplay): void;
  setDeformScale(v: number): void;
  triggerFitView(): void;
  setSidebarOpen(v: boolean): void;
  setSidebarWidth(v: number): void;
  setHighlightBodyId(id: number | null): void;
  toggleBodyVisibility(id: number): void;
  setAllBodiesVisible(): void;
}

export const createViewSlice: SliceCreator<ViewSlice> = (set) => ({
  viewRepr: "surface",
  showUndeformedOverlay: true,
  loadDisplay: "resultant",
  deformScale: 1,
  fitViewTrigger: 0,
  sidebarOpen: !window.matchMedia(SMALL_SCREEN_QUERY).matches,
  sidebarWidth: initialSidebarWidth(),
  highlightBodyId: null,
  hiddenBodyIds: [],

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
  triggerFitView: () =>
    set((s) => {
      s.fitViewTrigger++;
    }),
  setSidebarOpen: (v) =>
    set((s) => {
      s.sidebarOpen = v;
    }),
  setSidebarWidth: (v) =>
    set((s) => {
      s.sidebarWidth = clampSidebarWidth(v);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(s.sidebarWidth));
    }),
  setHighlightBodyId: (id) =>
    set((s) => {
      s.highlightBodyId = id;
    }),
  toggleBodyVisibility: (id) =>
    set((s) => {
      s.hiddenBodyIds = s.hiddenBodyIds.includes(id)
        ? s.hiddenBodyIds.filter((b) => b !== id)
        : [...s.hiddenBodyIds, id];
    }),
  setAllBodiesVisible: () =>
    set((s) => {
      s.hiddenBodyIds = [];
    }),
});
