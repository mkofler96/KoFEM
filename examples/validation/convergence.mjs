// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mesh-convergence studies for the example pages (/examples/<id>/).
//
// Each study re-solves cases on a sequence of meshes, so the model is exactly
// the CI case with only the mesh changed. Errors are against the reference of
// the series' case, and every study includes the mesh that case is gated on in
// CI (run.mjs checks that one level reproduces it). Run by `run.mjs --report`;
// a full run takes about half a minute, which is why the default CI run does
// not repeat it.
//
// A study of recipe cases is data only (recipeStudy below): each level is a
// Netgen max element size in mm, solved through lib/pipeline.mjs with the
// series' element order and the case's recipe otherwise unchanged:
//
//   recipeStudy({ id, caseId, title, note,
//                 series: [{ label, caseId, order: 1 | 2, levels: [mm, …] }] })
//
// KOF-322: legacy hex path, removed when all cases are recipes. A study of a
// legacy case carries solve(solver, level, order) and meshLabel(level), with
// levels of structured-grid divisions.

import { solveModel } from "./lib/app-model.mjs";
import { cantileverModel, cantileverTip } from "./cases/cantilever-bending.mjs";
import { shaftModel, shaftTwist } from "./cases/shaft-torsion.mjs";

/** A study of recipe cases: levels are max element sizes (mm). */
export function recipeStudy(study) {
  for (const s of study.series) {
    if (s.order !== 1 && s.order !== 2)
      throw new Error(`study "${study.id}", ${s.label}: order must be 1 or 2`);
    if (!s.levels.length || !s.levels.every((h) => h > 0))
      throw new Error(
        `study "${study.id}", ${s.label}: levels must be positive element sizes in mm`,
      );
  }
  return { ...study, meshLabel: (h) => `${h} mm` };
}

const grid = (d) => d.join(" × ");

// solve(solver, level, order): the study's model at one mesh level, solved
// with the app's loads, and the case's measured value read off it.
const study = (build, measure) => (solver, level, order) => {
  const model = build("study", level, order);
  return measure(model, solveModel(solver, model));
};

export default [
  recipeStudy({
    id: "axial-bar",
    caseId: "axial-bar",
    title: "Axial bar, P1 vs. P2",
    note: "Both orders level off a few tenths of a percent below P·L/(E·A): what remains is the clamp, which stops the lateral contraction at x = 0, not the mesh.",
    series: [
      {
        label: "P1 (linear)",
        caseId: "axial-bar",
        order: 1,
        levels: [50, 25, 12.5],
      },
      {
        label: "P2 (quadratic)",
        caseId: "axial-bar",
        order: 2,
        levels: [50, 25],
      },
    ],
  }),
  {
    id: "cantilever",
    caseId: "cantilever",
    title: "Cantilever beam, P1 vs. P2",
    note: "Linear elements lock in bending and approach from far below; quadratic ones are within a few percent on every mesh and level off slightly above the reference, since Euler–Bernoulli theory neglects shear deformation.",
    series: [
      {
        label: "P1 (linear)",
        caseId: "cantilever",
        order: 1,
        levels: [
          [10, 1, 1],
          [20, 2, 2],
          [40, 4, 4],
          [80, 8, 8],
        ],
      },
      {
        label: "P2 (quadratic)",
        caseId: "cantilever-p2",
        order: 2,
        levels: [
          [5, 1, 1],
          [10, 2, 2],
          [20, 4, 4],
        ],
      },
    ],
    meshLabel: grid,
    solve: study(cantileverModel, cantileverTip),
  },
  {
    id: "shaft-torsion",
    caseId: "shaft-torsion",
    title: "Hollow shaft",
    note: "The error falls steadily as the straight-sided elements approach the circle.",
    series: [
      {
        label: "P1 (linear)",
        caseId: "shaft-torsion",
        order: 1,
        levels: [
          [1, 8, 3],
          [2, 16, 6],
          [3, 32, 12],
          [4, 64, 24],
        ],
      },
    ],
    meshLabel: grid,
    solve: study(shaftModel, shaftTwist),
  },
  recipeStudy({
    id: "cooks-membrane",
    caseId: "cooks-membrane",
    title: "Cook's membrane, P1 vs. P2",
    note: "Linear elements lock in the panel's bending and approach from below; quadratic ones are within half a percent even at 16 mm and level off at 23.94, 0.1 % under the plane-stress reference, since the slab clamped over its whole end face is slightly stiffer than the plane-stress panel.",
    series: [
      {
        label: "P1 (linear)",
        caseId: "cooks-membrane",
        order: 1,
        levels: [8, 4, 2, 1],
      },
      {
        label: "P2 (quadratic)",
        caseId: "cooks-membrane",
        order: 2,
        levels: [16, 8, 4, 2, 1],
      },
    ],
  }),
];
