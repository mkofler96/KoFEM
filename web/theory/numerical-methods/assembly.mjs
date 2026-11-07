// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, matrixEquation, tex } from "../operators/math.mjs";
import { source, mfemSource } from "./sources.mjs";
import { figure } from "../figures/index.mjs";

export default {
  slug: "numerical-methods/assembly",
  description:
    "A two-element bar and two tetrahedra sharing a face show how element stiffness and loads are summed into one sparse global system, and how KoFEM and MFEM number solid DOFs.",
  sections: [
    ["local-global", "Local and global degrees of freedom"],
    ["bar-example", "Worked example: two bar elements"],
    ["scatter", "Assembly as gather and scatter"],
    ["shared-face", "Two tetrahedra sharing a face"],
    ["dof-ordering", "DOF ordering"],
    ["global-properties", "Properties of the global matrix"],
    ["implementation", "KoFEM and MFEM responsibilities"],
    ["references", "Sources and further reading"],
  ],
  body: `
    <p class="lede">How do element contributions become the global linear system?</p>
    <p>Each element knows only its own nodes. Assembly adds every element’s
      <a href="/theory/numerical-methods/elements-and-quadrature/#element-stiffness">stiffness</a>
      and <a href="/theory/numerical-methods/elements-and-quadrature/#element-loads">load</a>
      into one global system. Where elements share a node, their contributions
      add. Units are N, mm and MPa.</p>

    <h2 id="local-global">Local and global degrees of freedom</h2>
    <p>A degree of freedom (DOF) is one unknown coefficient: one displacement
      component of one basis function. An element numbers its DOFs locally,
      ${tex("0")} to ${tex("3n_e - 1")}. The model numbers every DOF once, globally.
      The element’s connectivity, its list of global node numbers, links the
      two numberings.</p>
    <p>For a solid with ${tex("n_b")} scalar basis functions, the global
      <a href="/theory/notation/#discrete-displacement">coefficient vector</a>
      ${tex("\\mathbf{d}")} has ${tex("n_d = 3n_b")} entries. At order 1,
      ${tex("n_b")} is the number of mesh vertices. Order 2 adds one function
      per tetrahedral edge; on hexahedra it also adds one per face and one per
      element. For example, a 10 × 2 × 2 grid of hexahedra has ${tex("11 × 3 × 3 = 99")}
      vertices and 297 DOFs at order 1. At order 2 its nodes form a
      21 × 5 × 5 lattice: 525 functions and 1575 DOFs.</p>

    <h2 id="bar-example">Worked example: two bar elements</h2>
    <p>Use the axial bar from <a href="/theory/foundations/what-is-fem/#axial-bar">What is FEM?</a>:
      length ${tex("L = 1000\\text{ mm}")}, area ${tex("A = 10000\\text{ mm}^2")}, ${tex("E = 210000\\text{ MPa}")} and end force
      ${tex("P = 10^6\\text{ N}")}. Split it into two 500 mm elements with nodes 1, 2 and 3.
      Each node has one DOF, its axial displacement in mm.
      Each element is a spring of stiffness:</p>
    ${equation("k = \\frac{EA}{L_e} = \\frac{210000 × 10000}{500}\\text{ N}/\\text{mm} = 4.2 × 10^6\\text{ N}/\\text{mm}.", "Element axial stiffness equals modulus times area over element length, 4.2 million newtons per millimetre")}
    ${matrixEquation(
      "\\mathbf{K}^{(e)} = k",
      [
        ["1", "-1"],
        ["-1", "1"],
      ],
      "Two-node bar element stiffness: k times one, minus one; minus one, one",
    )}
    <p>Element 1 connects nodes (1, 2); element 2 connects (2, 3). Add each
      2 × 2 block into the rows and columns of its nodes. Node 2 belongs to
      both elements, so its diagonal receives ${tex("k")} twice:</p>
    ${matrixEquation(
      "\\mathbf{K} = k",
      [
        ["1", "-1", "0"],
        ["-1", "1+1", "-1"],
        ["0", "-1", "1"],
      ],
      "Assembled three-by-three bar stiffness: k times one, minus one, zero; minus one, one plus one, minus one; zero, minus one, one",
    )}
    <p>The load vector is ${tex("\\mathbf{f} = (R, 0, P)\\text{ N}")}, where ${tex("R")} is the unknown support
      reaction at node 1. As assembled, ${tex("\\mathbf{K}")} is singular: each row sums to zero
      because a rigid translation costs no energy. Fixing node 1
      (${tex("d_1 = 0")}) leaves two equations for the two unknowns:</p>
    ${equation("k(2d_2 - d_3) = 0, \\quad k(-d_2 + d_3) = P.", "Reduced bar equations after fixing node 1: k times two d 2 minus d 3 equals zero; k times minus d 2 plus d 3 equals P")}
    <p>Solving gives ${tex("d_2 = P/k = 5/21\\text{ mm} \\approx 0.238\\text{ mm}")} and
      ${tex("d_3 = 2P/k = 10/21\\text{ mm} \\approx 0.476\\text{ mm}")}. This equals the analytical
      ${tex("PL/(EA)")}. The first row then gives ${tex("R = -kd_2 = -10^6\\text{ N}")}, balancing
      ${tex("P")}. Linear elements are exact here because the true displacement of a
      uniform bar without body load is linear. Supports are treated in detail in
      <a href="/theory/numerical-methods/loads-and-constraints/">Loads and constraints</a>.</p>
    ${figure("assembly-two-bars", "Assembly of the two-element bar. Each element matrix is added into the rows and columns of its nodes; at the shared node 2 both contributions add.")}

    <h2 id="scatter">Assembly as gather and scatter</h2>
    <p>Formally, a Boolean matrix ${tex("A_e")} of size ${tex("3n_e × n_d")}
      gathers the element’s DOFs from the global vector:
      ${tex("\\mathbf{d}^{(e)} = A_e\\mathbf{d}")}. Equating the internal work
      of the elements with the global work gives:</p>
    ${equation("\\mathbf{K} = \\sum_e A_e^T \\mathbf{K}^{(e)} A_e, \\quad \\mathbf{f} = \\sum_e A_e^T \\mathbf{f}^{(e)}.", "Global stiffness is the sum over elements of A e transpose times element stiffness times A e; the global load is the sum of A e transpose times element load")}
    <p>${tex("A_e")} is never built. Implementations keep a list of the
      element’s global DOF indices and add entry ${tex("(i, j)")} of ${tex("\\mathbf{K}^{(e)}")} to
      entry ${tex("(g_i, g_j)")} of ${tex("\\mathbf{K}")}, where ${tex("g_i")} is the global index of local DOF ${tex("i")}. Elements may be processed in any order.
      In the bar, element 1 has indices (1, 2) and element 2 has (2, 3).</p>

    <h2 id="shared-face">Two tetrahedra sharing a face</h2>
    <p>Take five vertices, 0 to 4, and two order-1 tetrahedra: ${tex("T_1 = (0, 1, 2, 3)")}
      and ${tex("T_2 = (1, 2, 3, 4)")}. They share the face
      ${tex("(1, 2, 3)")}. With ${tex("n_b = 5")}, there are 15 global DOFs. Using the
      component-blocked order explained below, component ${tex("c = 0, 1, 2")}
      (${tex("x, y, z")}) of vertex ${tex("v")} has global index ${tex("v + 5c")}:</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Global DOF indices of two tetrahedra sharing a face; scroll horizontally if needed">
      <table>
        <caption>Global DOF indices per element</caption>
        <thead><tr><th scope="col">Element</th><th scope="col">x DOFs</th><th scope="col">y DOFs</th><th scope="col">z DOFs</th></tr></thead>
        <tbody>
          <tr><th scope="row">${tex("T_1")} (0, 1, 2, 3)</th><td>0, 1, 2, 3</td><td>5, 6, 7, 8</td><td>10, 11, 12, 13</td></tr>
          <tr><th scope="row">${tex("T_2")} (1, 2, 3, 4)</th><td>1, 2, 3, 4</td><td>6, 7, 8, 9</td><td>11, 12, 13, 14</td></tr>
        </tbody>
      </table>
    </div>
    <p>Each 12 × 12 element matrix lands in a 15 × 15 global matrix. Nine DOFs
      belong to both elements, so the 9 × 9 block of the shared face receives
      two contributions. Vertices 0 and 4 share no element, so their 3 × 3
      coupling block stays zero. Of the 25 vertex pairs, 23 are coupled:
      the global matrix has ${tex("23 × 9 = 207")} structural nonzeros out of 225.
      In a large mesh each vertex couples only to its neighbours, so almost
      all entries are zero and ${tex("\\mathbf{K}")} is stored as a sparse matrix.</p>

    <h2 id="dof-ordering">DOF ordering</h2>
    <p>Two orders are common for the same coefficients:</p>
    <ul>
      <li><strong>Interleaved</strong> (by node): ${tex("(d_{0x}, d_{0y}, d_{0z}, d_{1x}, …)")},
        index ${tex("3v + c")}. The
        <a href="/theory/notation/#discrete-displacement">notation reference</a>
        and the ${tex("\\mathbf{B}")} blocks on the elements page use this order.</li>
      <li><strong>Component-blocked</strong>: all ${tex("x")} coefficients, then all ${tex("y")},
        then all ${tex("z")}, index ${tex("v + n_bc")}.</li>
    </ul>
    <p>KoFEM’s solid solve uses MFEM’s default, component-blocked global order.
      MFEM’s elasticity integrator also orders each element matrix by
      component: local index ${tex("k + n_ec")}. The two orders differ only by a
      permutation matrix ${tex("P")}: ${tex("\\mathbf{K}_{\\mathrm{blocked}} = P\\mathbf{K}_{\\mathrm{interleaved}}P^T")}.
      For the worked tetrahedron, exact arithmetic confirms that MFEM’s form
      equals the permuted ${tex("\\mathbf{B}^T C\\mathbf{B}")} matrix. The displacement field and
      every physical result are unchanged; only array positions differ.</p>
    <p>At order 1 the scalar index of a vertex DOF is the input vertex index,
      so the ${tex("x, y, z")} displacement of vertex ${tex("v")} sits at ${tex("v")}, ${tex("v + n_b")} and
      ${tex("v + 2n_b")}. At order 2, edge functions follow all vertex
      functions. When MFEM corrects a tetrahedron’s orientation it reorders
      that element’s local corners; global vertex numbers do not change.</p>

    <h2 id="global-properties">Properties of the global matrix</h2>
    <ul>
      <li><strong>Size:</strong> ${tex("n_d × n_d")}, N/mm. The load
        vector has ${tex("n_d")} entries in N.</li>
      <li><strong>Symmetric</strong>, because every element matrix is.</li>
      <li><strong>Sparse</strong>: nonzero only where two DOFs share an element.</li>
      <li><strong>Positive semi-definite</strong> before supports: the strain
        energy ${tex("\\frac{1}{2}\\mathbf{d}^T\\mathbf{K}\\mathbf{d}")} is never negative.</li>
      <li><strong>Singular</strong> before supports: every unconnected body has
        six rigid-body modes. Supports must remove all of them before the
        system can be solved.</li>
    </ul>
    <p>Bodies with different materials still assemble into one ${tex("\\mathbf{K}")}. Each element
      uses its own body’s ${tex("λ")} and ${tex("μ")}, and contributions add at shared nodes.
      The <a href="/theory/numerical-methods/linear-solve/">Linear solve</a>
      page explains how the constrained system is solved.</p>
    ${figure("mesh-sparsity", "A small triangular mesh and the nonzero pattern of its plane-elasticity stiffness matrix, two DOFs per node. A node couples only to the nodes of its own elements (highlighted), so most entries are zero. Numbering the nodes from left to right keeps the nonzeros near the diagonal.")}

    <h2 id="implementation">KoFEM and MFEM responsibilities</h2>
    <p>KoFEM uses MFEM 4.7. The solid solve is
      ${source("engine/cpp/solve_mfem.cpp", 182, "solve_linear_elastic")}.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Map from textbook steps to the KoFEM and MFEM implementation; scroll horizontally if needed">
      <table class="responsibility-table">
        <caption>Textbook step to production code</caption>
        <thead><tr><th scope="col">Step</th><th scope="col">Owner</th><th scope="col">What happens</th></tr></thead>
        <tbody>
          <tr><th scope="row">Mesh and connectivity</th><td>KoFEM, MFEM</td><td>KoFEM adds vertices and tetrahedra/hexahedra with a material attribute per element
            (${source("engine/cpp/fem_mesh_io.cpp", 113, "fem_mesh_io.cpp")}); MFEM builds edges and faces and fixes element orientation.</td></tr>
          <tr><th scope="row">Shape functions and DOF numbering</th><td>MFEM</td><td>An order-${tex("k")} H1 space with three components, component-blocked
            (${source("engine/cpp/solve_mfem.cpp", 259, "solve_mfem.cpp")}).</td></tr>
          <tr><th scope="row">Material per element</th><td>KoFEM</td><td>${tex("λ")} and ${tex("μ")} from each body’s ${tex("E")} and ${tex("ν")}, selected by element attribute
            (${source("engine/cpp/solve_mfem.cpp", 288, "solve_mfem.cpp")}).</td></tr>
          <tr><th scope="row">Element stiffness and quadrature</th><td>MFEM</td><td>Elasticity integrator with its default rule
            (${mfemSource("fem/bilininteg.cpp", 3033, "bilininteg.cpp")}).</td></tr>
          <tr><th scope="row">Scatter-add into ${tex("\\mathbf{K}")}</th><td>MFEM</td><td>Bilinear-form assembly into a sparse matrix
            (${source("engine/cpp/solve_mfem.cpp", 291, "solve_mfem.cpp")}).</td></tr>
          <tr><th scope="row">Surface loads</th><td>KoFEM, MFEM</td><td>KoFEM builds the traction for each force, traction or pressure group and marks its faces; MFEM integrates ${tex("N_a\\mathbf{t}")}
            (${source("engine/cpp/fem_bc_io.cpp", 340, "fem_bc_io.cpp")}).</td></tr>
          <tr><th scope="row">Point loads</th><td>KoFEM</td><td>Added directly to the assembled load vector at a vertex’s three DOFs
            (${source("engine/cpp/fem_bc_io.cpp", 425, "fem_bc_io.cpp")}).</td></tr>
          <tr><th scope="row">Supports</th><td>KoFEM, MFEM</td><td>KoFEM lists constrained DOFs, extending them to order-2 edge DOFs
            (${source("engine/cpp/fem_bc_io.cpp", 177, "fem_bc_io.cpp")}); MFEM eliminates them
            (${source("engine/cpp/solve_mfem.cpp", 297, "solve_mfem.cpp")}).</td></tr>
          <tr><th scope="row">Mixed solid–shell</th><td>KoFEM, MFEM</td><td>The same order-1 MFEM solid matrix, renumbered into KoFEM’s coupled DOF list
            (${source("engine/cpp/solve_coupled.cpp", 71, "solve_coupled.cpp")}).</td></tr>
        </tbody>
      </table>
    </div>
    <p>KoFEM-specific decisions are the element order offered, the material
      mapping, the conversion of face forces to tractions and the treatment of
      supports. Shape functions, quadrature and the scatter-add are MFEM’s.
      The <a href="/examples/axial-bar/">axial bar example</a> runs this
      complete path in the browser engine; open it in the app and run it
      yourself.</p>

    <h2 id="references">Sources and further reading</h2>
    <ol class="refs">
      <li><a href="https://mfem.org/fem/">MFEM: Finite element methods</a>,
        finite element spaces, bilinear forms and assembly.</li>
      <li>Hughes, <cite>The Finite Element Method: Linear Static and Dynamic
        Finite Element Analysis</cite> (2000), the assembly operator and
        global DOF arrays.</li>
      <li>Bathe, <cite>Finite Element Procedures</cite> (1996), direct
        stiffness assembly and properties of the stiffness matrix.</li>
    </ol>
    <p>The worked numbers were checked with exact rational arithmetic.
      Related pages: <a href="/theory/notation/#stiffness">stiffness notation</a>
      and <a href="/theory/solid-mechanics/equilibrium-and-weak-form/">Equilibrium and weak form</a>.</p>`,
};
