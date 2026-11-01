// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mesh-convergence studies for the example pages (/examples/<id>/).
//
// Each study re-solves one validation case on a sequence of meshes through the
// case's own model builder, so the model is exactly the CI case with only the
// mesh changed. Errors are against the reference of the series' case, and every
// study includes the mesh that case is gated on in CI. Run by
// `run.mjs --report`; a full run takes about half a minute, which is why the
// default CI run does not repeat it.

import { solveModel } from "./lib/app-model.mjs";
import { cantileverModel, cantileverTip } from "./cases/cantilever-bending.mjs";
import { shaftModel, shaftTwist } from "./cases/shaft-torsion.mjs";
import { cookCorner, cookModel } from "./cases/cooks-membrane.mjs";

const grid = (d) => d.join(" × ");

// solve(solver, level, order): the study's model at one mesh level, solved
// with the app's loads, and the case's measured value read off it.
const study = (build, measure) => (solver, level, order) => {
  const model = build("study", level, order);
  return measure(model, solveModel(solver, model));
};

export default [
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
  {
    id: "cooks-membrane",
    caseId: "cooks-membrane",
    title: "Cook's membrane",
    note: "Both orders rise past the 23.9 reference under refinement, so the pass on the 16 × 16 CI mesh is a cancellation of errors; treat this case as a regression check until the reference is reconciled.",
    series: [
      {
        label: "P1 (linear)",
        caseId: "cooks-membrane",
        order: 1,
        levels: [4, 8, 16, 32, 64],
      },
      {
        label: "P2 (quadratic)",
        caseId: "cooks-membrane",
        order: 2,
        levels: [2, 4, 8, 16],
      },
    ],
    meshLabel: (n) => `${n} × ${n}`,
    solve: study(cookModel, cookCorner),
  },
];
