// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, matrixEquation, tex } from "../operators/math.mjs";
import { gradient, worked } from "./stress-example.mjs";
import { revision, source } from "./sources.mjs";

export default {
  slug: "results/displacement-and-stress",
  description:
    "Follow displacement through strain and stress to von Mises, then distinguish KoFEM's element-centre results from nodal averaging, contour colours and deformation scale.",
  sections: [
    ["recovery", "From displacement to stress"],
    ["von-mises", "What von Mises measures"],
    ["worked-example", "Worked example: recover a stress tensor"],
    ["sampling", "What the solid solver returns"],
    ["averaging", "From element samples to a contour"],
    ["display", "Fields, units and deformation scale"],
    ["verification", "A public stress verification case"],
    ["sources", "Reviewed implementation and references"],
  ],
  body: `
    <p class="lede">How are nodal displacement and element von Mises stress produced and displayed?</p>
    <p>The linear solve finds displacement coefficients. Differentiating the
      displacement field gives strain; a material law gives stress. A contour
      plot adds averaging, colours and a deformed display shape. Each step
      changes what a reported value means.</p>
    <p>This page covers static, small-strain, isotropic linear-elastic solids.
      KoFEM details below refer to the ordinary solid solve. Shell surface
      stress and optimization results require their own interpretation.</p>

    <h2 id="recovery">From displacement to stress</h2>
    <p>The <a href="/theory/numerical-methods/elements-and-quadrature/">finite element approximation</a>
      reconstructs displacement ${tex("u_h")} from shape functions ${tex("N_a")}
      and solved vector coefficients ${tex("d_a")}. The subscript ${tex("h")}
      marks the discrete field and ${tex("a")} indexes its basis functions.</p>
    ${equation("u_h(x) = \\sum_a N_a(x)d_a, \\quad ∇u_h(x) = \\sum_a d_a⊗∇N_a(x).", "Displacement is the shape-function interpolation of solved coefficients; differentiating the shape functions gives its spatial gradient")}
    <p>Here ${tex("x")} is the original position. In the app’s N–mm convention,
      ${tex("u_h")} and ${tex("d_a")} are in mm; ${tex("N_a")} is dimensionless
      and ${tex("∇N_a")} has units 1/mm. Thus the gradient and strain are dimensionless.
      See <a href="/theory/notation/#discrete-displacement">discrete notation</a>
      and the <a href="/theory/operators/gradient-divergence/#symmetric-gradient">symmetric gradient</a>.</p>
    ${equation("ε_{ij} = \\frac{1}{2}(∂u_i/∂x_j + ∂u_j/∂x_i), \\quad σ_{ij} = λ ε_{kk}δ_{ij} + 2μ ε_{ij}.", "Small strain is the symmetric displacement gradient; isotropic stress is lambda times the strain trace on the diagonal plus twice mu times strain")}
    <p>${tex("ε_{ij}")} and ${tex("σ_{ij}")} are the
      <a href="/theory/notation/#strain">strain</a> and
      <a href="/theory/notation/#stress">Cauchy stress</a> components.
      Repeated ${tex("k")} sums the three diagonal strains, and
      ${tex("δ_{ij}")} is 1 on the diagonal and 0 elsewhere. The
      <a href="/theory/notation/#lame-parameters">Lamé material relations</a>
      give ${tex("μ = E/[2(1+ν)]")} and
      ${tex("λ = Eν/[(1+ν)(1-2ν)]")} from Young’s modulus ${tex("E")}
      and Poisson’s ratio ${tex("ν")}. Stress and both moduli have units MPa.
      Tensor shear strain is half engineering shear; stress shear is not doubled.</p>
    <p>Stress recovery evaluates these derivatives and the material law after
      the solve. Continuous displacement across element boundaries does not
      require continuous derivatives there. Adjacent elements can therefore
      predict different stresses at a shared location.</p>

    <h2 id="von-mises">What von Mises measures</h2>
    <p>Remove the mean normal stress to form the deviatoric tensor ${tex("s")};
      ${tex("σ_{\\mathrm{vm}}")} is its non-negative equivalent stress:</p>
    ${equation("s_{ij} = σ_{ij} - \\frac{σ_{kk}}{3}δ_{ij}, \\quad σ_{\\mathrm{vm}} = \\sqrt{\\frac{3}{2}s_{ij}s_{ij}}.", "Deviatoric stress subtracts the mean normal stress; von Mises is the square root of three halves times its double contraction")}
    ${equation("σ_{\\mathrm{vm}}^2 = \\frac{(σ_{xx}-σ_{yy})^2+(σ_{yy}-σ_{zz})^2+(σ_{zz}-σ_{xx})^2}{2} + 3(σ_{xy}^2+σ_{yz}^2+σ_{xz}^2).", "The squared von Mises stress combines half the squared normal-stress differences with three times the squared shear stresses")}
    <p>The double sum counts both symmetric off-diagonal entries. Von Mises
      has stress units and is independent of coordinate rotation. Uniaxial
      tension and compression of the same magnitude give the same value;
      hydrostatic stress alone gives zero. It discards signs and directions.</p>
    <p>Comparing it with a uniaxial yield stress is useful for a material that
      follows a von Mises yield criterion, commonly an isotropic ductile metal.
      It does not by itself assess brittle fracture, fatigue, buckling or a
      pressure-sensitive material. KoFEM’s linear-elastic calculation does not
      simulate yielding or stress redistribution after yield.</p>

    <h2 id="worked-example">Worked example: recover a stress tensor</h2>
    <p>Use ${tex("E = 200000")} MPa and ${tex("ν = 0.25")}, so
      ${tex("λ = μ = 80000")} MPa. With coordinates in mm, prescribe the
      affine displacement field ${tex("u_x = 0.000525x + 0.000375y")},
      ${tex("u_y = 0.000150y")} and ${tex("u_z = -0.000225z")}, in mm.</p>
    ${matrixEquation("∇u =", gradient, "Displacement gradient of the affine worked example, dimensionless")}
    <p>The diagonal strains are 0.000525, 0.000150 and −0.000225;
      their trace is 0.000450. Tensor shear ${tex("ε_{xy} = 0.0001875")}
      gives ${tex("σ_{xy} = 2 × 80000 × 0.0001875 = 30")} MPa.
      The volumetric contribution is ${tex("λ ε_{kk} = 36")} MPa:</p>
    ${matrixEquation(
      "σ =",
      worked.stress.map((row) => row.map((value) => Math.round(value))),
      "Recovered stress tensor in MPa",
    )}
    <p>The mean normal stress is 60 MPa, so the deviatoric diagonal is
      (60, 0, −60) MPa. The shear terms contribute twice:</p>
    ${equation("σ_{\\mathrm{vm}} = \\sqrt{\\frac{3}{2}(60^2+0^2+(-60)^2+2 × 30^2)} = \\sqrt{13500} \\approx 116.19\\,\\mathrm{MPa}.", "The example has von Mises stress square root of 13500, approximately 116.19 MPa")}
    <p>The <a href="https://github.com/mkofler96/KoFEM/blob/develop/web/theory/results/stress-example.mjs">checkable calculation</a>
      verifies the tensor, shear factor and invariant, including hydrostatic,
      pure-shear and reversed-sign checks:</p>
    <pre><code>bun web/theory/results/stress-example.mjs</code></pre>

    <h2 id="sampling">What the solid solver returns</h2>
    <p>The ordinary solid wrapper exports three translations per mesh vertex
      in vertex order, and one von Mises scalar per element in element order.
      It evaluates the full solved displacement gradient at the first point
      of MFEM’s order-1 integration rule: the reference-element centre for
      tetrahedra and hexahedra. It then applies that element’s material law.
      This is a point sample, not a volume average or a search for the element’s
      maximum stress.</p>
    <p>On a straight-sided linear tetrahedron the displacement gradient is
      constant. In a trilinear hexahedron or a quadratic element, stress can
      vary within the element; the one centre sample cannot reveal that
      variation. The quadratic solve uses its higher-order displacement field
      for recovery, but the returned displacement array contains only vertex
      values. The viewer does not reconstruct the complete quadratic field.</p>
    <p>The static result selector provides displacement magnitude,
      ${tex("U_x")}, ${tex("U_y")}, ${tex("U_z")} and von Mises stress.
      Strain and tensor stress are intermediate calculations here, not shipped
      static contour fields. Individual stress components, principal stresses
      and reaction-force fields are not returned by this solid result interface.
      Component output remains tracked in
      <a href="https://linear.app/kofem/issue/KOF-213">KOF-213</a>.</p>

    <h2 id="averaging">From element samples to a contour</h2>
    <p>The web viewer first averages the <em>scalar von Mises samples</em>
      of elements touching each node ${tex("a")}:</p>
    ${equation("σ_{\\mathrm{vm},a}^{\\mathrm{avg}} = \\frac{\\sum_{e∋a} w_e σ_{\\mathrm{vm},e}}{\\sum_{e∋a} w_e}.", "A displayed node takes the weighted mean of the von Mises samples of elements sharing that node")}
    <p>${tex("e")} indexes adjacent elements and ${tex("w_e")} is their
      averaging weight. Tetrahedra use absolute volume; triangular facets use
      area. Other element types, including hexahedra, currently use unit
      weights. Consequently “volume-weighted” does not describe every mesh.</p>
    <p>For two tetrahedra of volumes 1 and 3 mm³ with samples 100 and
      150 MPa, a shared node receives ${tex("(1 × 100 + 3 × 150)/4")}, or
      <strong>137.5 MPa</strong>. This is an average of equivalent stresses,
      not von Mises computed from an averaged tensor. Equal-volume uniaxial
      tensors of +100 and −100 MPa would average to zero stress, but their
      scalar von Mises values average to 100 MPa.</p>
    <p>The averaging traverses shared node IDs without a material/body filter;
      it can smooth a real jump across a material interface when those nodes
      are shared. Coincident but distinct nodes do not average together.
      Smoothing can hide element jumps and reduce a local peak. It provides
      no error estimate.</p>
    <p>The result summary and automatic legend range use extrema of this
      nodal field over all model nodes, including interior nodes. The viewport
      draws boundary faces, splits quads into triangles and assigns each
      vertex a colour from its nodal value. The renderer interpolates vertex
      colours over each triangle. A smooth-looking surface is a display of
      recovered values, not additional stress samples or proof of accuracy.</p>

    <h2 id="display">Fields, units and deformation scale</h2>
    <p>Displacement components keep their global-axis signs; magnitude is
      ${tex("|u| = \\sqrt{u_x^2+u_y^2+u_z^2}")}. The app labels them in mm and
      von Mises in MPa (N/mm²). The engine does no dimensional conversion:
      geometry, material inputs and loads must already be coherent. See
      <a href="/theory/foundations/consistent-units/#material-values">consistent units and modulus/stress conversion</a>.</p>
    <p>The shape uses original position plus scaled displacement. The UI’s
      “1×” multiplies an <em>automatic</em> scale, not physical displacement
      at true scale. For non-negligible displacement, KoFEM sets the largest
      absolute displacement component to 20% of the model’s largest bounding-box
      span, then multiplies by the slider value. At 0× the shape is undeformed.
      Scaling changes positions on screen; it does not change solved displacement,
      strain, stress or the small-strain assumptions.</p>
    <p>Automatic legend limits rescale for each result. Identical red regions
      in two plots can represent different stresses. Manual limits affect
      colours and saturate values outside the chosen range; the numerical
      result summary still uses the computed field extrema.</p>

    <h2 id="verification">A public stress verification case</h2>
    <p>The <a href="/examples/plate-with-hole/">plate-with-hole verification case</a>
      compares the largest element-centre von Mises sample in the first ring
      around the hole, divided by nominal tension, with Kirsch’s infinite-plate
      concentration factor of 3. At the free edge’s peak in that ideal problem,
      the remaining tangential stress is uniaxial, so its magnitude equals von Mises.</p>
    <p>The finite plate, support and element-centre sampling differ from the
      ideal boundary value. The public case explains sampling and discretization
      errors; its tolerance applies to that benchmark. Its measured peak is
      <em>unsmoothed</em>, whereas the app summary uses nodal averaging. Compare
      like measures before interpreting a difference. Reproduce the benchmark with:</p>
    <pre><code>bun examples/validation/run.mjs --case plate-with-hole</code></pre>
    <p>Continue with <a href="/theory/results/interpretation-and-convergence/">interpretation and convergence</a>
      before using a peak for a design decision.</p>

    <h2 id="sources">Reviewed implementation and references</h2>
    <p>Reviewed on 6 November 2026 at
      <a href="https://github.com/mkofler96/KoFEM/tree/${revision}"><code>${revision.slice(0, 7)}</code></a>,
      using MFEM 4.7.</p>
    <ul class="refs">
      <li>${source("engine/cpp/solve_mfem.cpp", 52, "Vertex extraction and element-centre recovery")},
        and ${source("engine/cpp/solve_mfem.cpp", 239, "result arrays after the linear solve")}.</li>
      <li>${source("web/src/lib/resultField.ts", 51, "Averaging weights, nodal field, extrema and units")},
        ${source("web/src/components/viewport/ResultsColormap.tsx", 90, "legend mapping and boundary colours")},
        ${source("web/src/components/viewport/MeshScene.tsx", 59, "automatic deformation scaling")},
        ${source("web/src/components/viewport/useMeshTopology.ts", 170, "model span")},
        ${source("web/src/components/panel/ResultsPanel.tsx", 372, "summary and display controls")}
        and ${source("web/src/store/resultsSlice.ts", 12, "static result interface")}.</li>
      <li>${source("examples/validation/cases/plate-with-hole.mjs", 90, "Benchmark measurement")}
        selects unsmoothed samples, not the app’s nodal extrema.</li>
      <li>Shells use membrane-plus-bending stress at the worse of their two
        surfaces: ${source("engine/cpp/solve_shell.cpp", 195, "shell result")}
        and ${source("engine/cpp/solve_coupled.cpp", 265, "coupled result")}. Auto-shell
        additionally ${source("web/src/lib/solve/autoShell.ts", 363, "maps shell stresses onto original elements")}.
        These are different measures from solid centre samples; see the
        <a href="/theory/shells/formulation/">shell chapter</a>.</li>
      <li>Malvern, <cite>Introduction to the Mechanics of a Continuous Medium</cite>
        (1969), small strain, isotropic elasticity and stress invariants;
        Timoshenko and Goodier, <cite>Theory of Elasticity</cite>, third edition
        (1970), the circular-hole solution.</li>
    </ul>`,
};
