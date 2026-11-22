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
//                 series: [{ label, caseId, order: 1 | 2, levels: [mm, …] }] })
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
      "Neither order converges monotonically here, so there is no rate to fit: the peak of element-centre stresses averaged to the nodes moves between nodes from one mesh to the next. Recovering the stress at the integration points instead would give it one.",
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
    id: "plate-with-hole-shell",
    caseId: "plate-with-hole-shell",
    title: "Plate with a hole, shell triangles",
    note: "Kt scatters a few percent either side of Howland's 3.14 instead of converging: next to the 1 mm cut edge the triangle at the peak stays about 0.6 mm on every mesh, and the read-out is the constant stress of the one or two triangles that meet there. On the finest meshes the peak node is shared by more triangles and reads low.",
    expect: null,
    noRate:
      "The peak stress is read from the one or two triangles at the cut edge, whose size does not shrink with the maximum element size, so it has no rate to observe.",
    series: [
      {
        label: "Shell (linear)",
        caseId: "plate-with-hole-shell",
        order: 1,
        levels: [4, 2.5, 2, 1.5, 1, 0.75, 0.5],
      },
    ],
  }),
];
