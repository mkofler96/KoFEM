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
    note: "Kt scatters a few percent either side of Howland's 3.14 instead of converging: next to the 1 mm cut edge the triangle at the peak stays about 0.6 mm on every mesh, and the read-out is the constant stress of the one or two triangles that meet there. On the finest meshes the peak node is shared by more triangles and reads low.",
    series: [
      {
        label: "Shell (linear)",
        caseId: "plate-with-hole-shell",
        order: 1,
        levels: [4, 2.5, 2, 1.5, 1, 0.75, 0.5],
      },
    ],
  }),
  recipeStudy({
    id: "nafems-le1",
    caseId: "nafems-le1",
    title: "NAFEMS LE1, quadratic tetrahedra",
    note: "The corner stresses of the few elements at D scatter around the peak: 1–2 % high on coarse meshes, a few tenths of a percent on the finest.",
    series: [
      {
        label: "P2 (quadratic)",
        caseId: "nafems-le1",
        order: 2,
        levels: [100, 50, 35],
      },
    ],
  }),
  recipeStudy({
    id: "nafems-le2",
    caseId: "nafems-le2",
    title: "NAFEMS LE2, curved shell triangles",
    note: "The difference stays near 1.6 % as the mesh is refined: it comes from flat facets standing in for the curved panel, not from the mesh size.",
    series: [
      {
        label: "Shell (linear)",
        caseId: "nafems-le2",
        order: 1,
        levels: [50, 25, 12.5],
      },
    ],
  }),
  recipeStudy({
    id: "nafems-le5",
    caseId: "nafems-le5",
    title: "NAFEMS LE5, quadratic tetrahedra",
    note: "The solid settles about 1.5 % beyond NAFEMS' thin-shell value: the walls are a tenth of a flange wide.",
    series: [
      {
        label: "P2 (quadratic)",
        caseId: "nafems-le5",
        order: 2,
        levels: [200, 100, 70],
      },
    ],
  }),
  recipeStudy({
    id: "nafems-le6",
    caseId: "nafems-le6",
    title: "NAFEMS LE6, flat shell triangles",
    note: "The principal stress settles about half a percent above the target.",
    series: [
      {
        label: "Shell (linear)",
        caseId: "nafems-le6",
        order: 1,
        levels: [25, 12.5, 8],
      },
    ],
  }),
  recipeStudy({
    id: "nafems-le10",
    caseId: "nafems-le10",
    title: "NAFEMS LE10, quadratic tetrahedra",
    note: "Read at the element corners, the surface stress at D is within half a percent on every mesh.",
    series: [
      {
        label: "P2 (quadratic)",
        caseId: "nafems-le10",
        order: 2,
        levels: [200, 150, 100, 75],
      },
    ],
  }),
  recipeStudy({
    id: "nafems-le11",
    caseId: "nafems-le11",
    title: "NAFEMS LE11, quadratic tetrahedra",
    note: "The thermal stress at A approaches the target from below as the mesh is refined.",
    series: [
      {
        label: "P2 (quadratic)",
        caseId: "nafems-le11",
        order: 2,
        levels: [100, 50, 35],
      },
    ],
  }),
  recipeStudy({
    id: "nafems-le3",
    caseId: "nafems-le3",
    title: "NAFEMS LE3, curved shell triangles",
    note: "The displacement falls as the mesh is refined and levels off a few percent below the target: flat facets on a doubly curved shell carry some membrane stiffness into bending.",
    series: [
      {
        label: "Shell (linear)",
        caseId: "nafems-le3",
        order: 1,
        levels: [500, 250, 125, 62.5],
      },
    ],
  }),
  recipeStudy({
    id: "nafems-le4",
    caseId: "nafems-le4",
    title: "NAFEMS LE4, curved shell triangles",
    note: "The meridional stress at the waist is within half a percent on every mesh.",
    series: [
      {
        label: "Shell (linear)",
        caseId: "nafems-le4",
        order: 1,
        levels: [50, 25, 12.5],
      },
    ],
  }),
  recipeStudy({
    id: "nafems-le7",
    caseId: "nafems-le7",
    title: "NAFEMS LE7, curved shell triangles",
    note: "The bending stress near the junction settles once the mesh resolves its decay length.",
    series: [
      {
        label: "Shell (linear)",
        caseId: "nafems-le7",
        order: 1,
        levels: [50, 35, 25, 17.5],
      },
    ],
  }),
  recipeStudy({
    id: "nafems-le8",
    caseId: "nafems-le8",
    title: "NAFEMS LE8, curved shell triangles",
    note: "Settled within a percent from 7.5 mm down, close to an axisymmetric thin-shell solution of the same geometry and below the NAFEMS target.",
    series: [
      {
        label: "Shell (linear)",
        caseId: "nafems-le8",
        order: 1,
        levels: [10, 7.5, 6, 5],
      },
    ],
  }),
];
