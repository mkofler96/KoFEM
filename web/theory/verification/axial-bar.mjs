// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, tex } from "../operators/math.mjs";
import { evidence, source, number, publicCase } from "./evidence.mjs";
import { figure } from "../figures/index.mjs";
import { resultViewer } from "../viewers/index.mjs";

const { setup, runs } = evidence;
const baseline = runs.find((run) => run.order === 1 && run.elements === 320);
if (!baseline)
  throw new Error("Axial-bar evidence lacks the public example's mesh");

export default {
  slug: "verification/axial-bar",
  description:
    "Reproduce the axial-bar study with the production WASM engine: geometry, units, loads, constraints, solver settings, displacement and interior stress checks, mesh/order comparison and evidence limits.",
  sections: [
    ["model", "The model and the reference"],
    ["pipeline", "Trace the complete solve"],
    ["comparison", "Measured displacement and stress"],
    ["limits", "What the comparison establishes"],
    ["reproduce", "Open the study in KoFEM"],
    ["sources", "Run record and sources"],
  ],
  body: `
    <p class="lede">Does the complete KoFEM path reproduce a bar in tension?</p>
    <p>The <a href="/theory/foundations/reading-a-study/">connected reading path</a>
      leads here from assumptions to results. This study uses the existing
      <a href="/examples/axial-bar/">public axial-bar example</a> and the real
      C++/WASM solid solver. It checks end extension and stress away from the
      support, with separate limits for each claim.</p>

    <h2 id="model">The model and the reference</h2>
    <p>The bar occupies ${tex("0 ≤ x ≤ 1000\\text{ mm}")} with a 100 mm × 100 mm
      section. It is homogeneous, isotropic, static and small-strain elastic.
      There is no body force. All translations on ${tex("x = 0")} are zero;
      the ${tex("x = 1000\\text{ mm}")} face carries a total force in +x.
      The other faces are traction-free.</p>
    ${figure("axial-bar", "The one-dimensional reference model: a bar of length L, modulus E and area A, clamped at one end and pulled by P.", "narrow")}
    <div class="table-wrap" tabindex="0" role="region" aria-label="Axial-bar inputs; scroll horizontally if needed">
      <table><caption>Coherent N–mm–MPa inputs</caption>
        <thead><tr><th scope="col">Input</th><th scope="col">Value</th><th scope="col">Unit</th></tr></thead>
        <tbody>${setup.inputs.map(([symbol, value, unit]) => `<tr><th scope="row">${tex(symbol === "ν" ? "ν" : symbol === "W × H" ? "W × H" : symbol)}</th><td>${value}</td><td>${unit || "dimensionless"}</td></tr>`).join("")}</tbody>
      </table>
    </div>
    <p>${tex("L")} is length, ${tex("W, H")} are section dimensions,
      <a href="/theory/notation/#young-modulus">${tex("E")}</a> is Young’s modulus,
      <a href="/theory/notation/#poisson-ratio">${tex("ν")}</a> is Poisson’s ratio,
      and ${tex("P")} is total force. The area ${tex("A = WH = 10000\\text{ mm}^2")}.
      The reference assumes uniform uniaxial tension and free lateral contraction:</p>
    ${equation("δ = \\frac{PL}{EA}, \\quad σ_{xx} = \\frac{P}{A}, \\quad σ_{\\mathrm{vm}} = |σ_{xx}|.", "Bar extension is force times length divided by modulus times area; uniaxial normal stress is force divided by area, and von Mises is its magnitude")}
    <p>The references are ${tex(`δ = ${number(setup.referenceDisplacementMm, 9)}\\text{ mm}`)}
      and ${tex(`σ_{\\mathrm{vm}} = ${setup.referenceStressMpa}\\text{ MPa}`)}.
      The implied axial strain is about 0.000476, within the small-strain
      assumption. A material name alone supplies no yield strength, so this
      is an elastic verification problem rather than a strength assessment.</p>

    <h2 id="pipeline">Trace the complete solve</h2>
    <ol>
      <li>${source("examples/validation/cases/axial-bar.mjs", 29, "The shared case builder")}
        makes a structured hex volume mesh, material, support and end-force group.
        The public example uses order 1 on a 20 × 4 × 4 grid: 320 elements,
        525 vertices and 1575 displacement DOFs before elimination.</li>
      <li>${source("examples/validation/lib/app-model.mjs", 91, "The app-model adapter")}
        selects the loaded boundary quads and sends a face-force group.
        ${source("engine/cpp/fem_bc_io.cpp", 259, "Boundary assembly")}
        divides force by selected area and integrates
        ${tex("f_{ai} = \\int_{Γ_N} N_a t_i\\,dS")}.
        Thus the traction is 100 MPa and nodal contributions sum to 1000000 N.
        See <a href="/theory/numerical-methods/loads-and-constraints/">loads and constraints</a>.</li>
      <li>${source("engine/cpp/solve_mfem.cpp", 192, "The solid orchestrator")}
        creates an H1 displacement space, assembles isotropic elasticity and
        forms the constrained system. The
        <a href="/theory/operators/integration-by-parts/#weak-form">weak form</a>
        and <a href="/theory/numerical-methods/assembly/">assembly page</a>
        explain these steps.</li>
      <li>${source("engine/cpp/cg_mfem.cpp", 54, "MFEM CG with symmetric Gauss–Seidel")}
        uses relative tolerance ${tex("10^{-6}")}, absolute tolerance 0, and
        an initial 5000-iteration budget. This small study does not request
        continuation. See <a href="/theory/numerical-methods/linear-solve/#residual">which residual is tested</a>.</li>
      <li>${source("engine/cpp/solve_mfem.cpp", 51, "Recovery")}
        returns vertex translations and one von Mises sample per element centre.
        The study measures those arrays directly, before the app’s
        <a href="/theory/results/displacement-and-stress/#averaging">nodal averaging</a>.</li>
    </ol>

    <h2 id="comparison">Measured displacement and stress</h2>
    <p>Extension is the arithmetic mean of vertex ${tex("u_x")} on the loaded
      face, matching the public case’s measure. Stress is unsmoothed centre
      von Mises in the fixed physical region ${tex("400 ≤ x ≤ 600\\text{ mm}")},
      four section widths or more from either end. Each grid has equal-volume
      cells, so the arithmetic stress mean is also a volume-weighted mean of
      these samples. The JSON records their minimum, maximum and count.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Axial-bar mesh and order comparison; scroll horizontally if needed">
      <table><caption>Executed WASM solves; stress error is the worst sample in the middle region</caption>
        <thead><tr><th scope="col">Grid</th><th scope="col">Order</th><th scope="col">DOFs</th><th scope="col">Extension<br />(mm)</th><th scope="col">Error<br />(%)</th><th scope="col">Mean von Mises<br />(MPa)</th><th scope="col">Worst stress<br />error (%)</th></tr></thead>
        <tbody>${runs.map((run) => `<tr><th scope="row">${run.grid.join(" × ")}${run === baseline ? "<br /><small>public case</small>" : ""}</th><td>${run.order}${run.order === 2 ? "<br /><small>diagnostic</small>" : ""}</td><td>${run.dofs}</td><td>${number(run.displacementMm, 7)}</td><td>${number(run.displacementErrorPct, 4)}</td><td>${number(run.stressMeanMpa, 8)}</td><td>${number(run.stressWorstErrorPct, 4)}</td></tr>`).join("")}</tbody>
      </table>
    </div>
    <p>Displacement error is ${tex("100(δ_h-δ)/δ")}; stress error is the largest
      absolute percentage difference from 100 MPa among the selected centres.
      The existing ${setup.displacementTolerancePct}% extension band allows
      the 3D clamp disturbance absent from the 1D reference. The
      ${setup.stressTolerancePct}% interior stress band requires a nearly
      uniform tension state far from that disturbance; it applies to every
      selected sample, not just the mean. These regression tolerances are
      chosen for this benchmark, not for a design’s safety margin.</p>

    ${resultViewer("axial-bar", {
      caption:
        "Displacement magnitude of the public axial-bar case. The extension grows linearly along the bar; near the clamp, the suppressed lateral contraction disturbs the uniform state.",
    })}

    <h2 id="limits">What the comparison establishes</h2>
    <p>The three order-1 meshes halve the cell size in each direction. Their
      extensions approach the reference from below, with a smaller change
      on the second refinement. The fully fixed end suppresses Poisson
      contraction and differs from the analytical bar, so refinement alone
      need not remove the remaining discrepancy. These three levels do not
      establish an asymptotic rate or a continuum error bound.</p>
    <p><strong>The order-2 hex row is diagnostic.</strong> Currently,
      ${source("engine/cpp/fem_bc_io.cpp", 169, "Dirichlet extension")}
      constrains vertices and edge DOFs but leaves Q2 face-centre DOFs free.
      That support differs from a fully clamped face. Its extension therefore
      cannot establish order convergence for the same boundary-value problem,
      even though both readouts fall inside the stated bands. The app’s
      tetrahedral meshes do not have Q2 face-centre DOFs.</p>
    <p>The middle-region agreement checks a uniform stress invariant. It does
      not verify stress sign, individual tensor components, clamp peaks,
      material interfaces, curved geometry, bending, shells or coupling.
      The number of samples grows while the physical region stays fixed.
      One centre sample per element does not bound the stress everywhere.
      The <a href="/theory/verification/strategy/">verification strategy</a>
      separates these checks from physical validation.</p>

    <h2 id="reproduce">Open the study in KoFEM</h2>
    <p><a class="button" href="/app/?example=axial-bar">Open the axial bar in KoFEM →</a></p>
    <p>The <a href="/examples/axial-bar/">example page</a> also offers the saved
      analysis. Solve at order 1 and select Ux: the public case’s maximum
      readout is <code>${publicCase.readout.value}</code>. Its reference comparison uses the mean
      end displacement. The middle-region stress statistic uses the
      unsmoothed element samples; the app’s global smoothed maximum is a
      different quantity.</p>
    <p>KoFEM’s automated tests rerun all four mesh/order solves in the browser
      engine, check the bands and compare the results with the published
      record.</p>

    <h2 id="sources">Run record and sources</h2>
    <p><a href="/theory/axial-bar.json">Download inputs, solver settings and full-precision results</a>
      of the four solves.</p>
    <p>${source("examples/validation/axial-bar-study.mjs", 1, "Study and measurement source")}
      reuses the public fixture and solver wrapper. See also
      ${source("web/src/lib/resultField.ts", 83, "app averaging and extrema")}
      and the <a href="/theory/foundations/reading-a-study/">complete reading path</a>.</p>
    <ul class="refs"><li>Gere and Goodno, <cite>Mechanics of Materials</cite>, axially loaded members.</li>
      <li>Timoshenko and Goodier, <cite>Theory of Elasticity</cite>, third edition (1970), Saint-Venant’s principle and end effects.</li>
      <li>Hughes, <cite>The Finite Element Method</cite> (2000), displacement-based elasticity.</li></ul>`,
};
