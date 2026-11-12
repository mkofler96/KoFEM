// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, tex } from "../operators/math.mjs";
import { source } from "./sources.mjs";
import { figure } from "../figures/index.mjs";

export default {
  slug: "results/interpretation-and-convergence",
  description:
    "Interpret stress peaks, singularities and surprising FEM results, and compare locations, units, recovery measures and mesh refinements consistently before making a design decision.",
  sections: [
    ["question", "Choose a meaningful quantity"],
    ["singularities", "Concentration or singularity?"],
    ["convergence", "Compare a sequence of discretizations"],
    ["comparison", "Keep the comparison consistent"],
    ["surprises", "Explain a surprising result"],
    ["evidence", "Evidence and further reading"],
  ],
  body: `
    <p class="lede">Which conclusions are justified by a result, and when must the FEM discretisation be refined?</p>
    <p>A clean contour and a converged linear solve do not establish an accurate
      physical prediction. Choose the quantity needed for the engineering
      decision, understand its recovery, and compare it across suitable meshes
      and modelling assumptions. This page concerns static, small-strain,
      isotropic linear-elastic solids.</p>

    <h2 id="question">Choose a meaningful quantity</h2>
    <p>For a clearance, inspect displacement in the relevant direction at the
      relevant location. A global displacement magnitude can answer a different
      question. For a ductile yield check, von Mises may be appropriate; brittle
      or fatigue assessments need other material data and stress measures.
      See <a href="/theory/results/displacement-and-stress/#von-mises">what von Mises measures</a>.</p>
    ${figure("convergence-rates", "Expected error against element size for a smooth solution, on logarithmic axes. A singular peak stress grows instead of converging. Schematic; not a KoFEM measurement.")}
    <p>Record whether the value is a point sample, a regional average or a
      maximum, and whether it is smoothed. KoFEM’s ordinary solid result has
      vertex translations and centre-sampled element von Mises stress; the
      app’s summary reports extrema of the averaged nodal field. A single
      centre sample is not a bound on stress within an element. A displayed
      maximum is not automatically the stress at the physical point of interest.</p>

    <h2 id="singularities">Concentration or singularity?</h2>
    <p>A smooth hole or finite-radius fillet can produce a large but finite
      <strong>stress concentration</strong>. Refinement should resolve the
      geometry and stress gradient until the chosen measure stabilizes. The
      <a href="/examples/plate-with-hole/">plate-with-hole case</a> shows how
      nodal averages of centre samples read a finite boundary peak slightly low.</p>
    <p>An ideal point force in a 3D continuum, a sharp re-entrant corner, or
      an abrupt change between fixed and free boundary conditions can produce
      a <strong>stress singularity</strong>: the ideal elastic stress grows
      without a finite limit as distance to the singular point tends to zero.
      Smaller elements sample closer to it, so the reported peak can keep
      rising while displacement elsewhere settles.</p>
    <p>A rising peak can also mean an unresolved finite concentration or poor
      element quality; mesh dependence alone does not prove a singularity.
      Inspect where the peak sits and which idealisation causes it. Where
      the physical part has a radius or a distributed contact load, model
      those features if they matter to the question.</p>
    <p>If the idealisation is intentional, report a quantity with a justified
      physical meaning, such as stress at a specified distance or an average
      over a fixed physical region. Keep that distance or region unchanged
      during refinement and use an assessment method appropriate to the failure
      mode. Deleting the hottest elements or changing the averaging region with
      mesh size does not establish a safe design.</p>
    <p>Smoothing can lower a singular peak on screen without removing the
      singularity from the mathematical model. Linear elasticity also cannot
      predict plastic redistribution in the real part.</p>

    <h2 id="convergence">Compare a sequence of discretizations</h2>
    <p>Use several systematically refined meshes near the feature controlling
      the chosen result. Keep geometry, material, supports and total loading
      fixed. Resolve thickness and bending where relevant; one global size
      does not describe local resolution or element quality.</p>
    <p>Let ${tex("q_c")} and ${tex("q_f")} be the same scalar readout on
      consecutive coarse and fine meshes, in the same units. For a nonzero
      fine value, a useful change indicator is:</p>
    ${equation("Δ_q = \\frac{|q_f-q_c|}{|q_f|} × 100%.", "Percent change is the absolute difference between consecutive readouts divided by the magnitude of the fine readout, times 100")}
    <p>For example, 120 MPa followed by 126 MPa gives 4.76% change.
      Near zero, use an absolute change with stated units. Choose a tolerance
      appropriate to the decision and its margin; there is no universal
      acceptable percentage.</p>
    <p>A small consecutive change is evidence of stability, not a proven error
      bound. Check the trend across further refinements, the peak’s location,
      and the recovery measure. Results need not converge monotonically.
      Two coarse meshes can agree because both miss the same feature.</p>
    <p>Increasing element order changes the approximation. Linear tetrahedra
      have constant strain per straight-sided element and can be too stiff in
      bending. Quadratic elements resolve richer fields, but KoFEM still
      exports one solid stress sample per element and vertex-only translations.
      Centre-sample convergence does not establish convergence of the unreported
      maximum within a quadratic element. See
      <a href="/theory/numerical-methods/elements-and-quadrature/#strain-displacement">elements and strain recovery</a>.</p>
    <p>Keep <a href="/theory/numerical-methods/linear-solve/#accuracy">three accuracy questions</a>
      separate: the algebraic residual measures the solve of one discrete
      system; mesh/order convergence probes discretization error; comparison
      with physical evidence tests modelling assumptions. Tightening a solver
      tolerance cannot repair a singularity or an incorrect load.</p>

    <h2 id="comparison">Keep the comparison consistent</h2>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Consistent result comparison checklist; scroll horizontally if needed">
      <table class="responsibility-table">
        <caption>Record these with every compared result</caption>
        <thead><tr><th scope="col">Item</th><th scope="col">What must agree or be stated</th></tr></thead>
        <tbody>
          <tr><th scope="row">Physical model</th><td>Geometry, material law, dimensional assumptions, supports, load distribution and total load. A shell surface value and a solid centre value measure different locations.</td></tr>
          <tr><th scope="row">Quantity</th><td>Same displacement component or magnitude, stress invariant, and point/average/maximum definition. Von Mises cannot substitute for a signed normal stress.</td></tr>
          <tr><th scope="row">Location</th><td>The same physical location or fixed region, body and side of an interface. Element IDs change after remeshing; they do not define a common location.</td></tr>
          <tr><th scope="row">Recovery</th><td>Centre versus integration-point or extrapolated values; scalar versus tensor averaging; weights and material-interface treatment.</td></tr>
          <tr><th scope="row">Units</th><td>Coherent lengths, loads and moduli, and the same reported units. 1 MPa = 10⁶ Pa; convert both stiffness inputs and stress outputs.</td></tr>
          <tr><th scope="row">Discretization</th><td>Element family and order, local sizes, quality and refinement sequence. Record each mesh rather than comparing only element counts.</td></tr>
          <tr><th scope="row">Display</th><td>Common legend limits, camera and deformation scale for visual comparison. Use numerical readouts to compare values.</td></tr>
        </tbody>
      </table>
    </div>
    <p>The <a href="/theory/results/displacement-and-stress/#averaging">recovery page</a>
      documents KoFEM’s averaging, including equal weights for hexes and the
      absence of a material-boundary filter. The
      <a href="/theory/foundations/consistent-units/">unit reference</a>
      explains coherent systems without implying automatic conversion.</p>

    <h2 id="surprises">Explain a surprising result</h2>
    <dl class="operator-definitions">
      <dt>Displacement looks enormous, but the readout is small.</dt>
      <dd>Inspect the values and the
        <a href="/theory/results/displacement-and-stress/#display">automatic deformation scale</a>.
        An amplified shape does not demonstrate large physical deformation.
        If actual rotations or strains are large, revisit the linear model.</dd>
      <dt>The new mesh has a higher peak stress.</dt>
      <dd>Locate it. Check unresolved radii, point loading, fixed/free edges,
        element quality and sampling distance. Compare values away from a
        suspected singularity as well as the maximum.</dd>
      <dt>The contour is smooth across a material change.</dt>
      <dd>Shared-node scalar averaging can conceal a stress jump. Different
        materials can have different strain/stress states even with continuous
        displacement. A smooth band does not establish interface accuracy.</dd>
      <dt>The app maximum differs from another solver or benchmark.</dt>
      <dd>Match locations, units, stress measures and recovery. A nodal average
        differs from an unsmoothed centre sample, a surface value or an
        extrapolated integration-point peak.</dd>
      <dt>A support is hot, or the model is unexpectedly stiff.</dt>
      <dd>Check whether constraints suppress real Poisson contraction or
        intended rotation, whether disconnected parts retain rigid motions,
        and whether load transfer/ties match the assembly. Review
        <a href="/theory/numerical-methods/loads-and-constraints/">loads and constraints</a>
        and element order before changing material values.</dd>
      <dt>Compression and tension have the same von Mises value.</dt>
      <dd>The scalar discards sign. A low von Mises value can also coexist
        with a large hydrostatic stress. Use an appropriate failure criterion;
        the static selector does not expose tensor components or principal stresses.</dd>
    </dl>

    <h2 id="evidence">Evidence and further reading</h2>
    <p>${source("engine/cpp/solve_mfem.cpp", 64, "Solid recovery")}
      supplies centre samples; ${source("web/src/lib/resultField.ts", 83, "nodal averaging and extrema")}
      defines the app’s summarized measure. The preceding
      <a href="/theory/results/displacement-and-stress/#sources">source inventory</a>
      traces the display and shell/coupled distinctions.</p>
    <p>The hole benchmark reads the app’s own nodal field, so its result
      is a comparison you can reproduce in the app. A smooth hole is a finite concentration;
      this case does not verify singular stresses, plasticity, arbitrary
      material interfaces or every recovery method.</p>
    <ul class="refs">
      <li>Cook, Malkus, Plesha and Witt, <cite>Concepts and Applications of
        Finite Element Analysis</cite>, fourth edition (2002), stress recovery,
        modelling and convergence.</li>
      <li>Szabó and Babuška, <cite>Finite Element Analysis</cite> (1991),
        discretization error and singular solutions.</li>
      <li>Timoshenko and Goodier, <cite>Theory of Elasticity</cite>, third
        edition (1970), the circular-hole stress concentration.</li>
    </ul>`,
};
