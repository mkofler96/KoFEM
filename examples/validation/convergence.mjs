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
// A study is data only (recipeStudy below): each level is a Netgen max
// element size in mm, solved through lib/pipeline.mjs with the series' element
// order and the case's recipe otherwise unchanged. A series may solve its
// case at another order than the case's own (the cantilever's P1 series), as
// long as one level of the study is the case's own mesh:
//
//   recipeStudy({ id, caseId, title, note,
//                 series: [{ label, caseId, order: 1 | 2, levels: [mm, …] }] })

/** A convergence study: levels are max element sizes (mm). */
export function recipeStudy(study) {
  for (const s of study.series) {
    if (s.order !== 1 && s.order !== 2)
      throw new Error(`study "${study.id}", ${s.label}: order must be 1 or 2`);
    if (!s.levels.length || !s.levels.every((h) => h > 0))
      throw new Error(
        `study "${study.id}", ${s.label}: levels must be positive element sizes in mm`,
      );
  }
  return study;
}

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
  recipeStudy({
    id: "beam-torsion",
    caseId: "beam-torsion",
    title: "Square beam in torsion, P1 vs. P2",
    note: "Linear tetrahedra lock and twist far too little. Quadratic ones are within 1.5 % on every mesh and, from 25 mm down, settle towards the reference from above as the loaded face's local deformation shrinks.",
    series: [
      {
        label: "P1 (linear)",
        caseId: "beam-torsion",
        order: 1,
        levels: [50, 25, 12.5],
      },
      {
        label: "P2 (quadratic)",
        caseId: "beam-torsion",
        order: 2,
        levels: [50, 25, 12.5, 10],
      },
    ],
  }),
  recipeStudy({
    id: "plate-with-hole",
    caseId: "plate-with-hole",
    title: "Plate with a hole, P1 vs. P2",
    note: "Quadratic elements stay within 2 % below Howland's 3.14 on every mesh; the nodal average of element-centre stresses keeps them slightly low. Linear elements overshoot by several percent and come down only slowly.",
    series: [
      {
        label: "P1 (linear)",
        caseId: "plate-with-hole",
        order: 1,
        levels: [4, 2, 1],
      },
      {
        label: "P2 (quadratic)",
        caseId: "plate-with-hole",
        order: 2,
        levels: [4, 2, 1],
      },
    ],
  }),
  recipeStudy({
    id: "cantilever-beam",
    caseId: "cantilever-beam",
    title: "Cantilever beam, P1 vs. P2",
    note: "Linear tetrahedra lock in bending and approach from far below; quadratic ones are within half a percent on every mesh and level off just above the reference.",
    series: [
      {
        label: "P1 (linear)",
        caseId: "cantilever-beam",
        order: 1,
        levels: [50, 25, 12.5, 8],
      },
      {
        label: "P2 (quadratic)",
        caseId: "cantilever-beam",
        order: 2,
        levels: [50, 25, 12.5],
      },
    ],
  }),
  recipeStudy({
    id: "shaft-torsion",
    caseId: "shaft-torsion",
    title: "Hollow shaft, P1 vs. P2",
    note: "Quadratic elements approach the reference from above as the polygons of the circles close in on them. Linear elements are too stiff in torsion and approach from below, so their errors partly cancel.",
    series: [
      {
        label: "P1 (linear)",
        caseId: "shaft-torsion",
        order: 1,
        levels: [20, 10, 7.5],
      },
      {
        label: "P2 (quadratic)",
        caseId: "shaft-torsion",
        order: 2,
        levels: [20, 15, 10, 7.5, 5],
      },
    ],
  }),
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
  recipeStudy({
    id: "plate-with-hole-shell",
    caseId: "plate-with-hole-shell",
    title: "Plate with a hole, shell triangles",
    note: "Kt rises towards 3 as the mesh is refined: each triangle has one stress, and averaging them to the nodes reads the peak low until the triangles at the hole are small.",
    series: [
      {
        label: "Shell (linear)",
        caseId: "plate-with-hole-shell",
        order: 1,
        levels: [4, 2, 1, 0.75],
      },
    ],
  }),
];
