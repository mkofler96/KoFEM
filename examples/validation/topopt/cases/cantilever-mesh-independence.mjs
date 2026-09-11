// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mesh-independence of the 3D-cantilever design (the property the density/
// sensitivity filter exists to provide, KOF-229).
//
// The same cantilever problem (cantilever-3d.mjs) is optimized at two
// resolutions — a 10×5×5 coarse grid and a 20×10×10 grid, an exact factor-2
// refinement — while the PHYSICAL filter radius r_min is held fixed. Without a
// filter, refining the mesh lets ever-thinner members appear and the topology
// keeps changing (the classic checkerboard / mesh-dependence pathology). With
// the filter, r_min sets a real length scale, so the two grids must converge to
// the SAME design.
//
// We average the fine density onto the coarse grid (each coarse element covers
// 2×2×2 fine elements) and check three things: the converged compliances agree,
// the density fields correlate tightly, and the thresholded solid regions
// overlap. This is the heavier case (the fine solve dominates the suite's
// runtime); it is the mesh-independence evidence the issue (KOF-234) calls for.

import { buildCantilever, FILTER_RADIUS } from "./cantilever-3d.mjs";
import { projectToCoarse, pearson, solidIoU } from "../lib/topopt.mjs";

const COARSE = { nx: 10, ny: 5, nz: 5 };
const FINE = { nx: 20, ny: 10, nz: 10 };

// Reference agreement from the committed engine (see REPORT.md).
const MAX_COMPLIANCE_DIFF_PCT = 5; // measured ≈ 0.9 %
const MIN_CORRELATION = 0.9; // measured ≈ 0.99
const MIN_IOU = 0.85; // measured ≈ 0.95

function runGrid(optimize, g) {
  const { mesh, materials, bcs, settings } = buildCantilever(g.nx, g.ny, g.nz);
  const { density, history, converged } = optimize(
    mesh,
    materials,
    bcs,
    settings,
  );
  return {
    density,
    dims: mesh.dims,
    compliance: history.at(-1).objective,
    volume: history.at(-1).volume,
    iterations: history.length,
    converged,
  };
}

export default {
  name: "Cantilever mesh-independence",
  description: `${COARSE.nx}×${COARSE.ny}×${COARSE.nz} vs ${FINE.nx}×${FINE.ny}×${FINE.nz}, same r_min ${FILTER_RADIUS}`,
  run(optimize) {
    const coarse = runGrid(optimize, COARSE);
    const fine = runGrid(optimize, FINE);

    const projected = projectToCoarse(
      fine.density,
      fine.dims,
      coarse.density,
      coarse.dims,
    );
    const diffPct =
      (Math.abs(fine.compliance - coarse.compliance) / coarse.compliance) * 100;
    const corr = pearson(coarse.density, projected);
    const iou = solidIoU(coarse.density, projected);

    return {
      metrics: [
        {
          label: "coarse",
          value: `${coarse.density.length} elems, ${coarse.iterations} it, c = ${coarse.compliance.toFixed(1)}, vol ${coarse.volume.toFixed(4)}`,
        },
        {
          label: "fine",
          value: `${fine.density.length} elems, ${fine.iterations} it, c = ${fine.compliance.toFixed(1)}, vol ${fine.volume.toFixed(4)}`,
        },
        { label: "compliance difference", value: `${diffPct.toFixed(2)} %` },
        { label: "density correlation", value: corr.toFixed(4) },
        { label: "solid-region IoU @0.5", value: iou.toFixed(4) },
      ],
      checks: [
        {
          label: "both resolutions converged",
          pass: coarse.converged && fine.converged,
        },
        {
          label: `compliance agrees within ${MAX_COMPLIANCE_DIFF_PCT} %`,
          pass: diffPct < MAX_COMPLIANCE_DIFF_PCT,
        },
        {
          label: `density correlation > ${MIN_CORRELATION}`,
          pass: corr > MIN_CORRELATION,
        },
        { label: `solid-region IoU > ${MIN_IOU}`, pass: iou > MIN_IOU },
      ],
    };
  },
};
