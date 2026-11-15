// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A general FEM introduction; product-specific implementation is not needed here.
import { tex, texBlock } from "../../examples/validation/lib/tex.mjs";
import { figure } from "./figures/index.mjs";
import { resultViewer } from "./viewers/index.mjs";

const symbol = (id, expression, label) =>
  `<a href="#${id}" aria-label="${label}">${tex(expression)}</a>`;

export default {
  slug: "foundations/what-is-fem",
  description:
    "What the finite element method is: a body divided into elements and nodes, unknown displacements at the nodes, one linear system, and the modelling choices and consistent units that make the answer meaningful.",
  sections: [
    ["idea", "The idea: divide and assemble"],
    ["from-cad", "From CAD geometry to a result"],
    ["scope", "What a model describes"],
    ["units", "Choose consistent units"],
    ["axial-bar", "A simple physical model"],
    ["limitations", "Assumptions and limitations"],
    ["references", "References"],
  ],
  body: `
    <p class="lede">What is the finite element method, and what makes a useful model?</p>

    <h2 id="idea">The idea: divide and assemble</h2>
    <p>The finite element method (FEM) computes how a body deforms under load
      when the shape is too complex for a formula. It divides the body into
      many small, simple pieces called <strong>elements</strong>: triangles or
      quadrilaterals in two dimensions, tetrahedra or hexahedra in three.
      Neighbouring elements share corner points called <strong>nodes</strong>.</p>
    ${figure(
      "fem-domain-mesh",
      "A body divided into triangular elements. The nodes carry the unknowns: each node can move in x and y, so it has two degrees of freedom (DOFs), u and v. Loads act on the boundary; supports prescribe the motion of some nodes.",
    )}
    <p>The unknowns are the displacements of the nodes. Each independent
      displacement component is a <strong>degree of freedom</strong> (DOF): two
      per node in a plane, three per node in a solid. Inside each element, the
      displacement is interpolated from its nodes by simple polynomials called
      <a href="/theory/notation/#shape-functions">shape functions</a>.</p>
    <p>For each element, the material law and the shape functions give a small
      matrix that relates its nodal forces to its nodal displacements. Adding
      these element matrices at shared nodes gives one global system, the
      <a href="/theory/notation/#stiffness">stiffness matrix</a> ${tex("\\mathbf{K}")}
      times the vector of all nodal displacements ${tex("\\mathbf{d}")} equals the
      <a href="/theory/notation/#load-vector">load vector</a> ${tex("\\mathbf{f}")}:</p>
    <div class="equation" tabindex="0" role="region" aria-label="Global finite element system: K times d equals f; scroll horizontally if needed">
      ${texBlock("\\mathbf{K}\\mathbf{d} = \\mathbf{f}.")}
    </div>
    <p>Supports fix some entries of ${tex("\\mathbf{d}")}; loads fill ${tex("\\mathbf{f}")}.
      Solving the system gives the displacement of every node. Strain and stress
      then follow from the displacement inside each element. Smaller or
      higher-order elements follow the true displacement more closely, at the
      cost of more unknowns.</p>
    <p>The rest of this guide develops each step:
      <a href="/theory/solid-mechanics/linear-elasticity/">the material law</a>,
      <a href="/theory/solid-mechanics/equilibrium-and-weak-form/">the equations of equilibrium</a>,
      <a href="/theory/numerical-methods/elements-and-quadrature/">elements</a>,
      <a href="/theory/numerical-methods/assembly/">assembly</a>,
      <a href="/theory/numerical-methods/linear-solve/">the solve</a> and
      <a href="/theory/results/displacement-and-stress/">the results</a>.</p>

    <h2 id="from-cad">From CAD geometry to a result</h2>
    <p>In practice the body comes from CAD. A mesher fills the geometry with
      elements; in three dimensions these are usually tetrahedra, because any
      solid shape can be filled with them. A quadratic tetrahedron has a node
      at each corner and one at the middle of each edge, so its edges can bend
      and its strain can vary linearly inside it.</p>
    ${figure(
      "fem-geometry-to-mesh",
      "CAD geometry (left) is filled with tetrahedral elements (middle; the lines are the element faces on the surface). Each quadratic tetrahedron (right) has 10 nodes: 4 at its corners and 6 at its edge midpoints. Node 7 lies on the hidden edge.",
    )}
    <p>KoFEM follows the same path in the browser: import a STEP file, mesh it,
      assign materials, supports and loads, solve, and inspect the displacement
      and stress. The result below is one of the
      <a href="/examples/">public examples</a>, a cantilever beam clamped at one
      end and loaded at the other. Drag to rotate it.</p>
    ${resultViewer("cantilever-beam", {
      caption:
        "Displacement magnitude of the cantilever example, solved by KoFEM, on the deformed shape. The colour bar gives the range in mm.",
    })}

    <h2 id="scope">What a model describes</h2>
    <p>A model is a deliberately simplified description of a physical problem.
      It identifies the body and its geometry, the material behaviour, the loads,
      and the supports or prescribed motion. Its assumptions determine which
      questions the calculation can answer.</p>
    <p>The physical model comes first; the finite element mesh only
      approximates it. Smaller elements improve the approximation to that
      model, but cannot repair an unsuitable material law or support
      condition.</p>
    <p>Static, small-strain, linear elasticity is a common starting point:
      applied forces balance elastic resistance, deformation is small, and stress
      varies linearly with strain. Other models are needed for effects such as
      plasticity, large deformation or time-dependent motion.</p>

    <h2 id="units">Choose consistent units</h2>
    <p>Every dimensional input must belong to one consistent system. For example,
      lengths in mm and forces in N require stiffness and stress in
      ${tex("\\text{N}/\\text{mm}^2 = \\text{MPa}")}.
      A steel modulus of 210 GPa is therefore entered numerically as 210000
      when the stress unit is MPa.</p>
    <p>In SI with metres, kilograms and seconds, the default stress unit is Pa;
      the same modulus is ${tex("2.10 × 10^{11}\\text{ Pa}")}. Changing the unit
      system changes the stress unit as well as the numerical input values.</p>
    <p>The choice is yours, but all quantities must agree. The
      <a href="/theory/foundations/consistent-units/">consistent unit systems reference</a>
      compares common SI, millimetre-based, CGS and US customary systems,
      including mass, time, energy and density.</p>

    <h2 id="axial-bar">A simple physical model</h2>
    <p>Consider a straight, prismatic bar held at one end and pulled along its
      axis. Assume uniform axial stress, small strain and a linear-elastic
      material. Force balance gives stress as force divided by area; Hooke’s law
      then gives strain as stress divided by Young’s modulus. Multiplying the
      strain by the original length gives the extension:</p>
    <div class="equation" tabindex="0" role="region" aria-label="Axial extension equation; scroll horizontally if needed">
      ${texBlock("δ = \\frac{P L}{E A}.")}
    </div>
    <dl class="symbols">
      <dt id="extension">${tex("δ")}</dt><dd>Extension of the loaded end.</dd>
      <dt id="force">${tex("P")}</dt><dd>Total tensile force along the bar axis; the axial magnitude of a <a href="/theory/notation/#point-force">force vector</a>.</dd>
      <dt id="length">${tex("L")}</dt><dd>Undeformed bar length.</dd>
      <dt id="young-modulus">${tex("E")}</dt><dd><a href="/theory/notation/#young-modulus">Young’s modulus</a>.</dd>
      <dt id="area">${tex("A")}</dt><dd>Cross-sectional area.</dd>
    </dl>
    ${figure(
      "axial-bar",
      "A one-dimensional idealisation of a bar in tension. The drawing describes the physical model, not a finite element discretisation.",
      "narrow",
    )}
    <p>For a generic example, take
      ${symbol("force", "P = 1000\\text{ N}", "P equals 1000 newtons; force definition")},
      ${symbol("length", "L = 1000\\text{ mm}", "L equals 1000 millimetres; length definition")},
      ${symbol("young-modulus", "E = 210000\\text{ MPa}", "E equals 210000 megapascals; Young’s modulus definition")} and
      ${symbol("area", "A = 100\\text{ mm}^2", "A equals 100 square millimetres; area definition")}.
      Substitution gives approximately 0.047619 mm:</p>
    <div class="equation" tabindex="0" role="region" aria-label="Axial bar dimensional check; scroll horizontally if needed">
      ${texBlock("δ = \\frac{P L}{E A} = \\frac{1000\\text{ N} × 1000\\text{ mm}}{210000\\text{ N}/\\text{mm}^2 × 100\\text{ mm}^2} = \\frac{10^6}{21 × 10^6}\\text{ mm} \\approx 0.047619\\text{ mm}.")}
    </div>
    <p>The <a href="/theory/verification/axial-bar/">axial-bar verification</a>
      solves a three-dimensional version of this bar in KoFEM and compares the
      result with this formula.</p>

    <h2 id="limitations">Assumptions and limitations</h2>
    <p>This one-dimensional bar model permits free lateral contraction and
      represents only axial deformation. A three-dimensional clamp that prevents
      lateral contraction creates a different local stress state. Bending,
      changes in cross-section and load introduction can require a richer model.</p>
    <p>Before refining a discretisation, check whether the geometry, material law,
      loading and supports capture the behaviour of interest. Then compare with
      an analytical reference, experiment or a suitable convergence study.
      A small numerical residual alone does not establish physical accuracy.</p>

    <h2 id="references">References</h2>
    <ol class="refs">
      <li>Gere and Goodno, <cite>Mechanics of Materials</cite>, axially loaded members.</li>
      <li>Bathe, <cite>Finite Element Procedures</cite>, mathematical models and finite element discretisation.</li>
      <li>Zienkiewicz, Taylor and Zhu, <cite>The Finite Element Method: Its Basis and Fundamentals</cite>, the general idea of discretisation and assembly.</li>
      <li><a href="/theory/foundations/consistent-units/">Consistent unit systems</a>: common choices and conversion examples.</li>
    </ol>`,
};
