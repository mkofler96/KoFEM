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

  setViewRepr(v: ViewRepr): void;
  setShowUndeformedOverlay(v: boolean): void;
  setLoadDisplay(v: LoadDisplay): void;
  setDeformScale(v: number): void;
  triggerFitView(): void;
}

export const createViewSlice: SliceCreator<ViewSlice> = (set) => ({
  viewRepr: "surface",
  showUndeformedOverlay: true,
  loadDisplay: "resultant",
  deformScale: 1,
  fitViewTrigger: 0,

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
});
