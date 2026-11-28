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
//   recipeStudy({ id, caseId, title, note, dimension, expect | (expect: null, noRate),
//                 series: [{ label, caseId, order: 1 | 2, levels: [mm, …],
//                            scaleLocalSizes? }] })
//
// With scaleLocalSizes, the case's face sizes (mesh.localSizes) follow each
// level in their ratio to its max element size, so a refined hole edge stays
// refined in proportion instead of fixed.
//
// Rates (lib/rates.mjs, KOF-399): each series' observed rate is fitted over
// its finest levels against the result extrapolated to zero element size,
// and compared with the rate theory expects for the read-out:
//
//   dimension  the directions the mesh refines in: 3 for a solid, 2 for a slab
//              meshed one element thick at every level (h ∝ N^(−1/d))
//   expect     { readout: "energy" | "point",
//                corner?: { angleDeg, poisson, where },   a singular clamped–
//                                                         free edge: caps 2λ
//                loadCap?: { rate, why } }               a load refined with
//                                                         the mesh
//   noRate     with expect: null, why the study has no rate

// The clamped face of a solid meeting its free side faces at a right angle,
// in the app's steel.
const STEEL_CLAMP = { angleDeg: 90, poisson: 0.3, where: "the clamped edges" };

// Torsion moments are applied as point forces at the vertices of the loaded
// face (momentToNodalForces), where the twist is read: each gives locally by
// about F/(E·h) with F ∝ h², so the read-out carries an error ∝ h.
const VERTEX_MOMENT = {
  rate: 1,
  why: "the moment is applied as point forces at the vertices of the loaded face, where the twist is read, and their local give shrinks only as h",
};

// The NAFEMS read-outs (KOF-446) are stresses at a point, which the rate
// check (lib/rates.mjs) has no theory for: it knows energy-type results and
// displacements at a point.
const NAFEMS_STRESS_SOLID =
  "The read-out is a stress at a point, recovered at element corners; the rate check covers energy-type results and point displacements only.";
const NAFEMS_STRESS_SHELL =
  "The read-out is a stress at a point on a shell of flat facets; the rate check covers energy-type results and point displacements on solid meshes only.";

/** A convergence study: levels are max element sizes (mm). */
export function recipeStudy(study) {
  if (study.expect === null) {
    if (typeof study.noRate !== "string" || !study.noRate)
      throw new Error(`study "${study.id}": expect: null needs noRate`);
  } else if (!study.expect || ![2, 3].includes(study.dimension))
    throw new Error(
      `study "${study.id}": needs dimension (2 or 3) and expect, or expect: null with noRate`,
    );
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
    dimension: 3,
    expect: { readout: "energy", corner: STEEL_CLAMP },
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
        levels: [50, 25, 12.5, 10],
      },
    ],
  }),
  recipeStudy({
    id: "beam-torsion",
    caseId: "beam-torsion",
    title: "Square beam in torsion, P1 vs. P2",
    note: "Linear tetrahedra lock and twist far too little. Quadratic ones are within 1.5 % on every mesh and, from 25 mm down, settle towards the reference from above as the loaded face's local deformation shrinks.",
    dimension: 3,
    expect: {
      readout: "energy",
      corner: STEEL_CLAMP,
      loadCap: VERTEX_MOMENT,
    },
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
    expect: null,
    noRate:
      "There is no rate to fit here. The quadratic series does not converge monotonically: the peak of element-centre stresses averaged to the nodes moves between nodes from one mesh to the next. The linear one falls steadily but has not yet reached the range where its slope settles. Recovering the stress at the integration points would give both a rate.",
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
    dimension: 3,
    expect: { readout: "energy", corner: STEEL_CLAMP },
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
        levels: [50, 25, 12.5, 10],
      },
    ],
  }),
  recipeStudy({
    id: "shaft-torsion",
    caseId: "shaft-torsion",
    title: "Hollow shaft, P1 vs. P2",
    note: "Quadratic elements approach the reference from above as the polygons of the circles close in on them. Linear elements are too stiff in torsion and approach from below, so their errors partly cancel.",
    dimension: 3,
    expect: {
      readout: "energy",
      corner: STEEL_CLAMP,
      loadCap: VERTEX_MOMENT,
    },
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
    // The 1 mm slab is meshed one element thick at every level here.
    dimension: 2,
    // The clamped edge meets the sloping top edge, from (0, 44) to (48, 60),
    // at 90° + atan(16/48) = 108.4°: the most singular corner of the panel.
    expect: {
      readout: "point",
      corner: {
        angleDeg: 90 + (Math.atan2(16, 48) * 180) / Math.PI,
        poisson: 1 / 3,
        where: "the clamped edge's upper corners",
      },
    },
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
    id: "cooks-membrane-incompressible",
    caseId: "cooks-membrane-incompressible",
    title: "Nearly incompressible Cook's membrane, P1 vs. P2",
    note: "Linear tetrahedra lock: each halving of the element size closes only part of the gap, and the finest linear mesh, with many times the unknowns, is still further off than the coarsest quadratic one. Quadratic tetrahedra are within about a percent from 8 mm on.",
    expect: null,
    noRate:
      "Linear tetrahedra lock at ν = 0.4999, so their error is not in the asymptotic range on any mesh solved here; quadratic tetrahedra are converged to the scatter of the read-out from the coarsest level on.",
    series: [
      {
        label: "P1 (linear)",
        caseId: "cooks-membrane-incompressible",
        order: 1,
        levels: [8, 4, 2, 1, 0.5],
      },
      {
        label: "P2 (quadratic)",
        caseId: "cooks-membrane-incompressible",
        order: 2,
        levels: [8, 4, 2],
      },
    ],
  }),
  recipeStudy({
    id: "plate-with-hole-shell",
    caseId: "plate-with-hole-shell",
    title: "Plate with a hole, shell triangles",
    note: "Kt rises steadily towards Howland's 3.14 from below as the plate and its hole edge are refined together, the hole edge at h/8: −2.2 % at 4 mm, −0.8 % at 1 mm, within a few hundredths of a percent at 0.5 mm.",
    expect: null,
    noRate: NAFEMS_STRESS_SHELL,
    series: [
      {
        label: "Shell (linear)",
        caseId: "plate-with-hole-shell",
        order: 1,
        levels: [4, 2, 1, 0.5],
        scaleLocalSizes: true,
      },
    ],
  }),
  recipeStudy({
    id: "nafems-le1",
    caseId: "nafems-le1",
    title: "NAFEMS LE1, quadratic tetrahedra",
    note: "The corner stresses of the few elements at D scatter around the peak: 1–2 % high on coarse meshes, a few tenths of a percent on the finest.",
    expect: null,
    noRate: NAFEMS_STRESS_SOLID,
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
    note: "The difference stays near 1.7 % as the mesh is refined: it comes from flat facets standing in for the curved panel, not from the mesh size.",
    expect: null,
    noRate: NAFEMS_STRESS_SHELL,
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
    title: "NAFEMS LE5, shell triangles",
    note: "The axial stress at A settles about a percent above NAFEMS' value from the coarsest mesh on.",
    expect: null,
    noRate: NAFEMS_STRESS_SHELL,
    series: [
      {
        label: "Shell (linear)",
        caseId: "nafems-le5",
        order: 1,
        levels: [200, 100, 70, 50],
      },
    ],
  }),
  recipeStudy({
    id: "nafems-le6",
    caseId: "nafems-le6",
    title: "NAFEMS LE6, flat shell triangles",
    note: "The principal stress settles about half a percent above the target.",
    expect: null,
    noRate: NAFEMS_STRESS_SHELL,
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
    expect: null,
    noRate: NAFEMS_STRESS_SOLID,
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
    expect: null,
    noRate: NAFEMS_STRESS_SOLID,
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
    note: "The displacement converges to about 1 % above the target: on 250 mm facets and finer the mesh no longer changes it.",
    expect: null,
    noRate:
      "The read-out is a displacement on a shell of flat facets, which approximate the doubly curved surface; the rate check covers solid meshes only.",
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
    note: "The meridional stress at the waist is within 0.6 % on every mesh.",
    expect: null,
    noRate: NAFEMS_STRESS_SHELL,
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
    note: "The bending stress near the junction is within half a percent of the target on every mesh.",
    expect: null,
    noRate: NAFEMS_STRESS_SHELL,
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
    note: "Rising slowly towards an axisymmetric thin-shell solution of the same geometry (2.6 % below it at 7.5 mm, 1.7 % at 3 mm), which itself lies below the NAFEMS target.",
    expect: null,
    noRate: NAFEMS_STRESS_SHELL,
    series: [
      {
        label: "Shell (linear)",
        caseId: "nafems-le8",
        order: 1,
        levels: [10, 7.5, 6, 5],
      },
    ],
  }),
  recipeStudy({
    id: "scordelis-lo-roof",
    caseId: "scordelis-lo-roof",
    title: "Scordelis–Lo roof, curved shell triangles",
    note: "The free-edge deflection rises to the reference from below and settles about 0.6 % short of it.",
    expect: null,
    noRate:
      "The read-out is a displacement on a shell of flat facets, which approximate the curved surface; the rate check covers solid meshes only.",
    series: [
      {
        label: "Shell (linear)",
        caseId: "scordelis-lo-roof",
        order: 1,
        levels: [4000, 2000, 1000, 500, 250],
      },
    ],
  }),
  recipeStudy({
    id: "pinched-cylinder",
    caseId: "pinched-cylinder",
    title: "Pinched cylinder, curved shell triangles",
    note: "The displacement under the load settles within 0.2 % of the reference.",
    expect: null,
    noRate:
      "The read-out is a displacement under a point load on a shell of flat facets; the rate check covers solid meshes only.",
    series: [
      {
        label: "Shell (linear)",
        caseId: "pinched-cylinder",
        order: 1,
        levels: [40, 20, 10, 5, 2.5],
      },
    ],
  }),
];
