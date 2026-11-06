// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, tex } from "../operators/math.mjs";
import { reviewed, source, table } from "./evidence.mjs";
import {
  barStiffness,
  gray,
  inputs,
  linearGray,
  solidVoid,
} from "./simp-example.mjs";

const n = (value) => Number(value.toPrecision(6)).toString().replace("-", "−");

export default {
  slug: "optimization/simp",
  description:
    "How SIMP topology optimization turns a linear-elastic FEM model into a density design problem: element densities, the penalized stiffness with a floor, compliance and volume objectives, and the self-adjoint sensitivity, with a two-bar worked calculation.",
  sections: [
    ["design-variables", "One density per element"],
    ["interpolation", "Penalized stiffness and its floor"],
    ["problems", "Objectives and constraints"],
    ["sensitivities", "Compliance sensitivity without an extra solve"],
    ["worked-example", "Two bars sharing one load"],
    ["domains", "Solid, shell and coupled design domains"],
    ["references", "Reviewed implementation and references"],
  ],
  body: `
    <p class="lede">How does SIMP turn a solid FEM problem into a density optimization problem?</p>
    <p>A static analysis answers “how does this part deform?”. Topology
      optimization asks a different question: “where should material be,
      inside a given design space, so the part is as stiff as possible for a
      given amount of it?”. SIMP (solid isotropic material with penalization)
      answers it by giving every finite element a material density and letting
      an optimizer adjust those densities, one linear-elastic analysis at a time.</p>

    <h2 id="design-variables">One density per element</h2>
    <p>Mesh the whole design space once. Each element ${tex("e")} gets a
      <a href="/theory/notation/#design-density">design density</a>
      ${tex("ρ_e")} between 0 (void) and 1 (solid material). It is a
      dimensionless fraction, not the mass density of the material.
      The mesh, supports and loads stay fixed for the whole run; only the
      element densities change.</p>
    <p>Because ${tex("ρ_e")} is constant over an element, the element is
      also the smallest feature the design can describe. KoFEM’s solid
      optimizer always uses linear (order 1) tetrahedra or hexahedra with one
      density per element, whatever order a static solve of the same model
      uses. The resulting shape is therefore a pattern of elements, not a CAD
      surface; <a href="/theory/optimization/interpreting-designs/">interpreting optimized designs</a>
      explains how to read and export it.</p>

    <h2 id="interpolation">Penalized stiffness and its floor</h2>
    <p>The analysis needs a stiffness for every density. With full-material
      <a href="/theory/notation/#young-modulus">Young’s modulus</a> ${tex("E_0")},
      KoFEM uses the modified SIMP interpolation:</p>
    ${equation("E(ρ_e)=E_{\\mathrm{min}}+ρ_e^{p}(E_0-E_{\\mathrm{min}}),\\quad s(ρ_e)=\\frac{E(ρ_e)}{E_0}=\\frac{E_{\\mathrm{min}}}{E_0}+ρ_e^{p}\\left(1-\\frac{E_{\\mathrm{min}}}{E_0}\\right).", "Young's modulus is a stiffness floor plus density to the power p times the remaining modulus; s is its ratio to the full-material modulus")}
    <p>The <a href="/theory/notation/#simp-penalty">penalty</a> ${tex("p")}
      (default 3) makes intermediate density poor value: at ${tex("ρ_e=0.5")}
      an element costs half its volume but provides only
      ${tex("0.5^3=0.125")} of its stiffness. A stiffness-seeking optimizer
      is therefore pushed towards 0 or 1. With ${tex("p=1")}, stiffness and
      volume are proportional and a gray “half-material” region is as good
      as solid and void; the worked example below shows this. KoFEM uses the
      power law as a numerical device for reaching a solid–void layout; a
      gray element is not a validated porous material.</p>
    <p>The <a href="/theory/notation/#stiffness-floor">stiffness floor</a>
      ${tex("E_{\\mathrm{min}}/E_0=10^{-9}")} is fixed in the engine and is
      not a user input. Without it a void element would contribute zero
      stiffness, and a node surrounded by void would leave the global
      stiffness matrix singular. The floor keeps it positive definite for
      a supported model, at the price of very large stiffness contrasts that make the
      <a href="/theory/numerical-methods/linear-solve/">iterative solve</a> harder.</p>
    <p>Element stiffness is linear in ${tex("E")}, so the full-material
      element matrix ${tex("\\mathbf{K}_e^0")} is integrated once and only
      scaled afterwards:</p>
    ${equation("\\mathbf{K}(ρ)=\\sum_e s(ρ_e)\\,\\mathbf{K}_e^0.", "The global stiffness is the assembly of each full-material element matrix scaled by its stiffness ratio")}
    <p>Assembly follows the same rules as a static solve; see
      <a href="/theory/numerical-methods/assembly/">assembly</a>.</p>

    <h2 id="problems">Objectives and constraints</h2>
    <p>Let ${tex("\\mathbf{d}(ρ)")} solve ${tex("\\mathbf{K}(ρ)\\mathbf{d}=\\mathbf{f}")}
      for a fixed load vector ${tex("\\mathbf{f}")}. The
      <a href="/theory/notation/#compliance">compliance</a> is the work done
      by the load, twice the stored strain energy:</p>
    ${equation("c(ρ)=\\mathbf{f}^{\\mathrm{T}}\\mathbf{d}(ρ)=\\mathbf{d}^{\\mathrm{T}}\\mathbf{K}(ρ)\\mathbf{d}.", "Compliance is the load vector dotted with the displacement, equal to displacement times stiffness times displacement")}
    <p>Lower compliance means a stiffer structure under <em>that</em> load
      case. It is measured in work units (N·mm with N and mm). With element
      volume ${tex("V_e")}, the material volume is
      ${tex("V(ρ)=\\sum_e ρ_eV_e")}. KoFEM offers two formulations, both
      with ${tex("ρ_{\\mathrm{min}}≤ρ_e≤1")}:</p>
    ${equation("\\text{minimum compliance:}\\quad \\mathrm{min}_{ρ}\\; c(ρ)\\quad \\text{subject to}\\quad V(ρ)≤v_{\\mathrm{f}}\\sum_e V_e,", "Minimize compliance subject to the volume being at most the target volume fraction of the design space")}
    ${equation("\\text{minimum volume:}\\quad \\mathrm{min}_{ρ}\\; V(ρ)\\quad \\text{subject to}\\quad c(ρ)≤c_{\\mathrm{allow}}.", "Minimize volume subject to compliance at most an allowed value")}
    <p>The <a href="/theory/notation/#volume-fraction">volume fraction</a>
      ${tex("v_{\\mathrm{f}}")} is a fraction of the meshed design space.
      The compliance limit ${tex("c_{\\mathrm{allow}}")} is in the model’s
      own work units, so it has no universal default. A minimum-volume run
      starts from full material; if even that design exceeds
      ${tex("c_{\\mathrm{allow}}")}, the engine stops with an explicit error.
      Either formulation can also carry a maximum von Mises stress limit on
      all-solid models; <a href="/theory/optimization/constraints-and-convergence/#stress-constraint">stress-constrained runs</a>
      change several details of the loop.</p>
    <p>Both formulations need a load and at least one fixed support. The
      engine rejects non-zero prescribed displacements, for the reason given
      in the next section.</p>

    <h2 id="sensitivities">Compliance sensitivity without an extra solve</h2>
    <p>A gradient-based optimizer needs ${tex("∂c/∂ρ_e")} for every element.
      Differentiate the equilibrium equation with a design-independent load:</p>
    ${equation("\\frac{∂\\mathbf{K}}{∂ρ_e}\\mathbf{d}+\\mathbf{K}\\frac{∂\\mathbf{d}}{∂ρ_e}=\\mathbf{0}\\quad⇒\\quad \\frac{∂c}{∂ρ_e}=\\mathbf{f}^{\\mathrm{T}}\\frac{∂\\mathbf{d}}{∂ρ_e}=-\\mathbf{d}^{\\mathrm{T}}\\frac{∂\\mathbf{K}}{∂ρ_e}\\mathbf{d}.", "Differentiating K d equals f gives the derivative of compliance as minus d transpose times the stiffness derivative times d")}
    <p>The last step uses ${tex("\\mathbf{f}^{\\mathrm{T}}\\mathbf{K}^{-1}=\\mathbf{d}^{\\mathrm{T}}")},
      valid because ${tex("\\mathbf{K}")} is symmetric. Only element
      ${tex("e")} depends on ${tex("ρ_e")}, so with the
      <a href="/theory/notation/#element-strain-energy">element strain-energy measure</a>
      ${tex("q_e=\\mathbf{d}_e^{\\mathrm{T}}\\mathbf{K}_e^0\\mathbf{d}_e")}:</p>
    ${equation("\\frac{∂c}{∂ρ_e}=-s'(ρ_e)\\,q_e=-pρ_e^{p-1}\\left(1-\\frac{E_{\\mathrm{min}}}{E_0}\\right)q_e≤0,\\quad \\frac{∂V}{∂ρ_e}=V_e.", "The compliance sensitivity is minus the interpolation slope times the element strain energy and is never positive; the volume sensitivity is the element volume")}
    <p>The problem is <em>self-adjoint</em>: the displacement already solved
      for gives every sensitivity, with no second solve. Adding material never
      makes this structure more compliant. Two assumptions carry the result:
      the load does not depend on ${tex("ρ")}, and supports hold
      ${tex("\\mathbf{d}=\\mathbf{0}")}. A non-zero prescribed displacement would make
      ${tex("\\mathbf{f}^{\\mathrm{T}}\\mathbf{d}")} differ from the strain-energy
      expression and need a separate adjoint, which KoFEM does not implement;
      it rejects such models rather than follow a wrong gradient. Body loads
      that scale with density, such as self-weight, are not part of the
      current formulation.</p>
    <p class="note">The solid loop solves every SIMP analysis with conjugate
      gradients to a relative residual of ${tex("10^{-8}")}, tighter than the
      static solid solve. The sensitivity is quadratic in the displacement,
      so a loose solve would bias it.</p>

    <h2 id="worked-example">Two bars sharing one load</h2>
    <p>Two parallel bars connect a fixed support to one loaded node, so they
      share the same extension ${tex("u")}. Each has
      ${tex(`E_0=${inputs.young}\\text{ MPa}`)}, area
      ${tex(`A=${inputs.area}\\text{ mm}^2`)} and length
      ${tex(`L=${inputs.length}\\text{ mm}`)}, so its full-material stiffness
      is ${tex(`k_0=E_0A/L=${barStiffness}\\text{ N/mm}`)}. The load is
      ${tex(`P=${inputs.load}\\text{ N}`)}. The volume budget is one bar:
      ${tex("ρ_1+ρ_2=1")}. Then:</p>
    ${equation("k(ρ)=k_0[s(ρ_1)+s(ρ_2)],\\quad u=\\frac{P}{k},\\quad c=Pu,\\quad q_e=k_0u^2,\\quad \\frac{∂c}{∂ρ_e}=-s'(ρ_e)q_e.", "Parallel stiffness is the sum of scaled bar stiffnesses; extension, compliance, element energy and sensitivity follow")}
    ${table(
      "Two-bar SIMP calculation (N, mm; E_min/E_0 = 1e-9 is negligible here)",
      ["Design", "Stiffness k (N/mm)", "u (mm)", "c (N·mm)", "∂c/∂ρ (N·mm)"],
      [
        [
          `${tex("p=3")}, ${tex("ρ=(0.5,0.5)")}`,
          n(gray.stiffness),
          n(gray.extension),
          n(gray.compliance),
          `${n(gray.sensitivity[0])} each`,
        ],
        [
          `${tex("p=3")}, ${tex("ρ=(1,0)")}`,
          n(solidVoid.stiffness),
          n(solidVoid.extension),
          n(solidVoid.compliance),
          `${n(solidVoid.sensitivity[0])} and ${n(Math.abs(solidVoid.sensitivity[1]))}`,
        ],
        [
          `${tex("p=1")}, ${tex("ρ=(0.5,0.5)")}`,
          n(linearGray.stiffness),
          n(linearGray.extension),
          n(linearGray.compliance),
          `${n(linearGray.sensitivity[0])} each`,
        ],
      ],
    )}
    <p>For the gray design, ${tex("s(0.5)=0.125")}, so
      ${tex("k=1000(0.125+0.125)=250\\text{ N/mm}")},
      ${tex("u=100/250=0.4\\text{ mm}")} and
      ${tex("c=100×0.4=40\\text{ N·mm}")}. Each bar’s
      ${tex("q_e=1000×0.4^2=160\\text{ N·mm}")} and
      ${tex("s'(0.5)=3×0.5^2=0.75")}, giving
      ${tex("∂c/∂ρ_e=-0.75×160=-120\\text{ N·mm}")}.</p>
    <p>With the penalty, putting all material into one bar is four times
      stiffer than splitting it. With ${tex("p=1")} the split design is as stiff as the solid–void
      one, so nothing drives the optimizer to a crisp answer. The solid–void
      row also shows a weakness of the gradient: at ${tex("ρ_e=0")},
      ${tex("s'(0)=0")}, so a void element receives no direct
      signal to return. Filtering spreads neighbouring information into it;
      see <a href="/theory/optimization/constraints-and-convergence/#filtering">filtering</a>.
      The repository script below checks every number above and compares each
      sensitivity with a central finite difference of the compliance:</p>
    <pre><code>cd web &amp;&amp; bun theory/optimization/simp-example.mjs</code></pre>
    <p>This verifies the article’s arithmetic and the sensitivity formula, not
      the production optimizer. The engine’s own finite-difference checks are
      in the native test suites listed below.</p>

    <h2 id="domains">Solid, shell and coupled design domains</h2>
    <p>The app routes an optimization the same way as a static solve: by the
      element mix of the FEM discretisation. Each element in the model is a
      design variable; there is no separate design-space selection yet.</p>
    ${table(
      "Design domains at the reviewed revision",
      ["Model", "Design variables and current rules"],
      [
        [
          "All solid",
          "One density per tetrahedron or hexahedron, order 1. One design material: the run uses a single E and ν. Optional maximum-stress constraint. A separate level-set method is also available for minimum compliance; it is not described here.",
        ],
        [
          "All shell",
          "One density per triangular shell facet. Element volume is facet area × thickness, so per-facet thickness is respected. One shell material. No stress constraint.",
        ],
        [
          "Mixed shell and solid, or any coupling",
          "One density field over the tetrahedra followed by the facets. Couplings are geometric constraints, not design variables, and remain intact. One solid and one shell material, so their relative stiffness is kept. No stress constraint.",
        ],
      ],
    )}
    <p>Bodies marked Shell must already be idealised into shell elements by
      re-meshing; the optimizer refuses to idealise them itself. The shell
      element and coupling mechanics are explained in
      <a href="/theory/shells/formulation/">shell formulation</a> and
      <a href="/theory/shells/solid-coupling/">solid–shell coupling</a>.
      Supported and loaded elements are design variables too: the app does not
      yet pin any element solid or void. The engine already accepts such
      passive regions, but the keep-in/keep-out picker that would fill them is
      open work (<a href="https://linear.app/kofem/issue/KOF-238">KOF-238</a>).</p>

    <h2 id="references">Reviewed implementation and references</h2>
    <p>${reviewed}</p>
    <ol class="refs">
      <li>Bendsøe and Sigmund, <cite>Topology Optimization: Theory, Methods and Applications</cite>, Springer (2003); and Bendsøe and Sigmund (1999), <cite>Material interpolation schemes in topology optimization</cite>, Archive of Applied Mechanics 69, 635–654.</li>
      <li>Andreassen, Clausen, Schevenels, Lazarov and Sigmund (2011), <cite>Efficient topology optimization in MATLAB using 88 lines of code</cite>, Structural and Multidisciplinary Optimization 43, 1–16. Source of the modified SIMP form used here.</li>
      <li>${source("engine/cpp/topology_simp_core.cpp", 72, "interpolation and slope")},
        ${source("engine/cpp/topology_simp_core.cpp", 80, "once-per-run element stiffness cache")},
        ${source("engine/cpp/topology_simp_core.cpp", 148, "compliance and self-adjoint sensitivity")},
        ${source("engine/cpp/topology_formulation.h", 1, "objective and constraint rows")} and
        ${source("engine/cpp/topology_simp.cpp", 192, "order-1 design space")} with its
        ${source("engine/cpp/topology_simp.cpp", 204, "prescribed-displacement guard")}.</li>
      <li>${source("engine/cpp/topology_shell.h", 1, "shell and coupled SIMP")},
        ${source("web/src/lib/solve/route.ts", 76, "design-domain routing")} and
        ${source("web/src/hooks/useTopOpt.ts", 227, "one-material-per-domain check")}.</li>
      <li>Native checks of the per-iteration math, including finite-difference
        sensitivities: ${source("engine/tests/topology_simp_validation.cpp", 1, "solid SIMP core")} and
        ${source("engine/tests/topology_shell_validation.cpp", 1, "shell and coupled core")},
        run by <code>scripts/test-topology.sh</code> and
        <code>scripts/test-topology-shell.sh</code> in CI.</li>
      <li>Architecture record: <a href="https://linear.app/kofem/document/adr-0002-simp-topology-optimization-runs-as-an-in-engine-loop-dbb4630d0dfb">ADR-0002 — SIMP topology optimization runs as an in-engine loop</a>.
        Statements on this page follow the code at the reviewed revision.</li>
    </ol>`,
};
