// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { create } from "zustand";
import type { StepTessellation } from "../store/geometrySlice";
import {
  loadComponents,
  loadKind,
  type NamedBcGroup,
  type NamedLoadGroup,
} from "../store/boundarySlice";

// The sample simulation the empty workspace offers (KOF-261): a real CAD part,
// the wall bracket, opened as geometry only. The user takes the steps every
// model needs (mesh, supports, load, run) with a guide that says what to do
// next and marks the faces to pick. Nothing is set up for them.

export const SAMPLE = {
  // Its id in analytics, like a gallery example's.
  exampleId: "wall-bracket",
  url: "/samples/wall-bracket.step",
  fileName: "wall-bracket.step",
  // CAD face ids of public/samples/wall-bracket.step (the mesh's
  // surfaceFaceIds numbering; tests/test_sample_guide.mjs pins them).
  boltHoleFaces: [34, 35, 36],
  // The hub's bore (r = 10 mm), where a shaft would push on it.
  hubBoreFaces: [37],
  // The load the guide asks for: a shaft in the hub pushing down.
  loadFy: -2000,
} as const;

export type GuideStep = "mesh" | "support" | "load" | "run" | "done";

export const GUIDE_STEPS: Exclude<GuideStep, "done">[] = [
  "mesh",
  "support",
  "load",
  "run",
];

export interface GuideModel {
  meshed: boolean;
  bcGroups: NamedBcGroup[];
  loadGroups: NamedLoadGroup[];
  solved: boolean;
}

const covers = (picked: Set<number>, wanted: readonly number[]) =>
  wanted.every((id) => picked.has(id));

// The bolt holes are held when supports that fix all three translations
// cover all three of them (in one support or several).
function holesFixed(groups: NamedBcGroup[]): boolean {
  const fixed = new Set<number>();
  for (const g of groups) {
    if (g.value !== 0 || ![0, 1, 2].every((d) => g.dofs.includes(d))) continue;
    for (const f of g.faces)
      if (f.cadFaceId !== undefined) fixed.add(f.cadFaceId);
  }
  return covers(fixed, SAMPLE.boltHoleFaces);
}

// The hub is loaded when a non-zero force acts on its bore. The direction is
// the user's: the guide suggests one, any force is a load.
function hubLoaded(groups: NamedLoadGroup[]): boolean {
  const loaded = new Set<number>();
  for (const g of groups) {
    if (loadKind(g) !== "force" || loadComponents(g).every((c) => c === 0))
      continue;
    for (const f of g.faces)
      if (f.cadFaceId !== undefined) loaded.add(f.cadFaceId);
  }
  return covers(loaded, SAMPLE.hubBoreFaces);
}

// The first step the model has not done yet. Steps are checked in order, so a
// support picked before meshing (impossible) or a result from an older setup
// never skips one.
export function guideStep(model: GuideModel): GuideStep {
  if (!model.meshed) return "mesh";
  if (!holesFixed(model.bcGroups)) return "support";
  if (!hubLoaded(model.loadGroups)) return "load";
  if (!model.solved) return "run";
  return "done";
}

// The faces the current step asks the user to pick, if any.
export function guideTargets(step: GuideStep): readonly number[] | null {
  if (step === "support") return SAMPLE.boltHoleFaces;
  if (step === "load") return SAMPLE.hubBoreFaces;
  return null;
}

// The guide belongs to the sample's geometry: it shows while that tessellation
// is the model's, and goes away with it (another import, a saved analysis, a
// new analysis, or a split that made new geometry), or when dismissed.
export const useSampleGuide = create<{
  geometry: StepTessellation | null;
}>(() => ({ geometry: null }));

export function startSampleGuide(geometry: StepTessellation): void {
  useSampleGuide.setState({ geometry });
}

export function dismissSampleGuide(): void {
  useSampleGuide.setState({ geometry: null });
}
