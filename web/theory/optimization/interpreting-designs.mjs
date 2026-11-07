// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tex } from "../operators/math.mjs";
import { source, table } from "./evidence.mjs";

export default {
  slug: "optimization/interpreting-designs",
  description:
    "How to read a SIMP density result: live progress and cancellation, gray elements and the display threshold, STL export, why the thresholded shape needs a new static analysis, and which limitations remain open.",
  sections: [
    ["during-a-run", "Watching and cancelling a run"],
    ["threshold", "Densities, gray elements and the threshold"],
    ["export", "Exporting the shape"],
    ["reanalysis", "Re-analyse before trusting a design"],
    ["adequacy", "Why convergence is not adequacy"],
    ["open-work", "Current limits"],
    ["references", "Implementation and references"],
  ],
  body: `
    <p class="lede">What does an optimized density field tell you, and what must you check before using it?</p>
    <p>A SIMP run returns one density per element and the history of its
      iterations. That is a material layout for the chosen loads, supports,
      volume and filter radius. Turning it into a part is a separate
      engineering step, which this page explains.</p>

    <h2 id="during-a-run">Watching and cancelling a run</h2>
    <p>While the optimizer runs, the viewport draws the density of the
      design each iteration has just analysed, and the convergence plot adds
      that iteration’s compliance, volume fraction and, with a stress limit,
      the aggregated and maximum relaxed stress. The last streamed density is
      exactly the returned one.</p>
    <p>Early iterations look gray and blurred: densities start uniform and
      move by at most the move limit per step. A shape that looks finished can
      still be reorganising, so judge the final result, not an early frame.</p>
    <p><strong>Cancel</strong> terminates the engine worker. The partial run
      and its live density are discarded; there is no best-so-far design.
      Changing any optimization setting also clears an existing result. A
      saved analysis file keeps the optimization settings but not the density
      result, so re-run to restore it.</p>

    <h2 id="threshold">Densities, gray elements and the threshold</h2>
    <p>A density between 0 and 1 is a numerical intermediate, not a
      manufacturable porous material. Penalization and filtering push most
      elements towards 0 or 1, but gray elements remain along member
      boundaries, in a band whose width is set mainly by the filter radius.</p>
    <p>The Results view hides elements below a <strong>threshold</strong>
      (default ${tex("ρ≥0.5")}). The element view draws the boundary of the
      kept elements, which shows exactly what was analysed but makes curved
      members stair-stepped. The smooth view averages densities to the nodes,
      weighted by element volume, and draws the surface where that nodal field
      equals the threshold. Both are interpretations of the same result.</p>
    <p>The volume shown at a threshold is not the optimizer’s volume fraction.
      Raising the threshold removes gray material and can disconnect thin
      members; lowering it adds material. Choose a threshold where the load
      paths stay connected and the kept volume is close to the budget, and
      record that choice with the result.</p>

    <h2 id="export">Exporting the shape</h2>
    <p><strong>Export shape as STL</strong> writes the surface currently
      shown — element or smooth — at the current threshold, in the model’s
      length units; STL itself carries no units. Kept solid elements export as
      the closed outward boundary of the kept set. Kept shell facets export as
      zero-thickness mid-surface triangles: their thickness is lost and must be
      restored when the part is rebuilt.</p>
    <p>The STL is a mesh of triangles, not a CAD solid. It has the
      discretisation’s staircase or isosurface character, contains no design
      intent such as fillets or holes for fasteners, and is not re-imported
      into the model automatically. Treat it as a guide for redesign in CAD or
      as input to a mesh-repair and smoothing step.</p>

    <h2 id="reanalysis">Re-analyse before trusting a design</h2>
    <p>The optimizer’s compliance belongs to the density field with its
      ${tex("E_{\\mathrm{min}}")} floor and penalized gray elements, not to
      the thresholded or redesigned part. KoFEM does not yet re-analyse the
      thresholded shape for you. To check a candidate design:</p>
    <ol>
      <li>Rebuild the shape as CAD, using the exported STL as a guide, and add
        the features the optimizer could not know about.</li>
      <li>Import it, mesh it as a solid (or idealise walls as shells), and
        apply the <em>same</em> materials, supports and loads.</li>
      <li>Run a static analysis. Compare stiffness with the optimizer’s
        compliance as a sanity check, then check displacement and stress
        against your requirements.</li>
      <li>Refine the mesh where stresses concentrate, as for any static study;
        see <a href="/theory/results/interpretation-and-convergence/">interpretation and convergence</a>.</li>
    </ol>
    <p>Expect the re-analysed compliance to differ from the optimized value.
      Thresholding removes gray stiffness, smoothing changes cross-sections
      and new features add or remove material. A large difference means the
      interpretation, not the optimizer, changed the structure.</p>

    <h2 id="adequacy">Why convergence is not adequacy</h2>
    <p>A converged run meets the optimization problem it was given. The
      design can still be inadequate because that problem left things out:</p>
    <ul>
      <li><strong>One load case.</strong> The layout is stiff for the applied
        loads and may be weak for any other direction or combination.</li>
      <li><strong>Linear statics.</strong> There is no buckling, contact,
        large deformation, plasticity, fatigue or dynamics. Slender compression
        members found by a stiffness optimizer deserve a stability check.</li>
      <li><strong>Stiffness, not strength.</strong> Without a stress limit, peak
        stress is not controlled. With one, a relaxed element-centre aggregate
        is controlled, not the stress of the rebuilt part.</li>
      <li><strong>The design space and supports.</strong> Every element
        is a design variable, including those at supports and loads. Check
        that the interpreted shape still carries each load into each support.</li>
      <li><strong>Discretisation and filter.</strong> The minimum member size
        follows from ${tex("r_{\\mathrm{min}}")} and the mesh; a different
        choice gives a different, locally optimal design.</li>
      <li><strong>Manufacturing.</strong> Overhangs, draft, minimum wall
        thickness and tool access are not constraints.</li>
    </ul>
    <p>Physical adequacy is established by the
      <a href="#reanalysis">re-analysis</a> and by engineering checks, not by
      the optimizer’s convergence flag or volume fraction.</p>

    <h2 id="open-work">Current limits</h2>
    ${table(
      "Optimization scope in KoFEM",
      ["Topic", "Current behaviour", "Not yet available"],
      [
        [
          "Design domain",
          "Every element is a design variable. The engine accepts element indices pinned solid or void, but the app sends none.",
          "Keep-in and keep-out regions in the app.",
        ],
        [
          "Stress limit",
          "All-solid SIMP models only.",
          "Shell and coupled stress constraints.",
        ],
        [
          "Loads and supports",
          "One load case; fixed supports with zero displacement; design-independent loads.",
          "Multiple load cases, prescribed displacements, self-weight.",
        ],
        [
          "Materials",
          "One material per solid domain and one per shell domain.",
          "Per-body design materials.",
        ],
        [
          "Result and export",
          "Density, history and STL of the thresholded surface. No automatic reanalysis or CAD output.",
          "Re-analysis is a manual workflow.",
        ],
      ],
    )}
    <p><a href="/theory/verification/strategy/">Verification strategy</a>
      explains how evidence for the static solver is organised.</p>

    <h2 id="references">Implementation and references</h2>
    <ol class="refs">
      <li>${source("engine/cpp/topology_stream.h", 1, "density streaming")} and
        ${source("web/src/hooks/useTopOpt.ts", 332, "cancellation")}.</li>
      <li>${source("web/src/store/viewSlice.ts", 24, "default threshold")},
        ${source("web/src/lib/densityField.ts", 264, "thresholded STL export")} and
        ${source("web/src/lib/analysisFile.ts", 95, "settings, not densities, in saved files")}.</li>
      <li>${source("engine/cpp/topology_optimize.h", 84, "passive regions accepted by the engine")}.</li>
      <li>Bendsøe and Sigmund, <cite>Topology Optimization: Theory, Methods and Applications</cite>, Springer (2003), on interpreting and post-processing density results.</li>
    </ol>`,
};
