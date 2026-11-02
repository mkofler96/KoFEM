// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tex } from "../../../examples/validation/lib/tex.mjs";
import { equation, matrixEquation } from "../operators/math.mjs";
import { revision, source, mfemSource } from "./sources.mjs";

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
      0 to 3n<sub>e</sub> − 1. The model numbers every DOF once, globally.
      The element’s connectivity, its list of global node numbers, links the
      two numberings.</p>
    <p>For a solid with n<sub>b</sub> scalar basis functions, the global
      <a href="/theory/notation/#discrete-displacement">coefficient vector</a>
      <b>d</b> has n<sub>d</sub> = 3n<sub>b</sub> entries. At order 1,
      n<sub>b</sub> is the number of mesh vertices. Order 2 adds one function
      per tetrahedral edge; on hexahedra it also adds one per face and one per
      element. For example, a 10 × 2 × 2 grid of hexahedra has 11 × 3 × 3 = 99
      vertices and 297 DOFs at order 1. At order 2 its nodes form a
      21 × 5 × 5 lattice: 525 functions and 1575 DOFs.</p>

    <h2 id="bar-example">Worked example: two bar elements</h2>
    <p>Use the axial bar from <a href="/theory/foundations/model-and-units/#axial-bar">Model and units</a>:
      length L = 1000 mm, area A = 10 000 mm², E = 210 000 MPa and end force
      P = 10⁶ N. Split it into two 500 mm elements with nodes 1, 2 and 3.
      Each node has one DOF, its axial displacement in mm.
      Each element is a spring of stiffness:</p>
    ${equation("k = \\frac{EA}{L_e} = \\frac{210000 × 10000}{500}\\text{ N}/\\text{mm} = 4.2 × 10^6\\text{ N}/\\text{mm}.", "Element axial stiffness equals modulus times area over element length, 4.2 million newtons per millimetre")}
    ${matrixEquation(
      "K^{(e)} = k",
      [
        ["1", "-1"],
        ["-1", "1"],
      ],
      "Two-node bar element stiffness: k times one, minus one; minus one, one",
    )}
    <p>Element 1 connects nodes (1, 2); element 2 connects (2, 3). Add each
      2 × 2 block into the rows and columns of its nodes. Node 2 belongs to
      both elements, so its diagonal receives k twice:</p>
    ${matrixEquation(
      "K = k",
      [
        ["1", "-1", "0"],
        ["-1", "1+1", "-1"],
        ["0", "-1", "1"],
      ],
      "Assembled three-by-three bar stiffness: k times one, minus one, zero; minus one, one plus one, minus one; zero, minus one, one",
    )}
    <p>The load vector is <b>f</b> = (R, 0, P) N, where R is the unknown support
      reaction at node 1. As assembled, K is singular: each row sums to zero
      because a rigid translation costs no energy. Fixing node 1
      (d<sub>1</sub> = 0) leaves two equations for the two unknowns:</p>
    ${equation("k(2d_2 - d_3) = 0, \\quad k(-d_2 + d_3) = P.", "Reduced bar equations after fixing node 1: k times two d 2 minus d 3 equals zero; k times minus d 2 plus d 3 equals P")}
    <p>Solving gives d<sub>2</sub> = P/k = 5/21 mm ≈ 0.238 mm and
      d<sub>3</sub> = 2P/k = 10/21 mm ≈ 0.476 mm. This equals the analytical
      PL/(EA). The first row then gives R = −k·d<sub>2</sub> = −10⁶ N, balancing
      P. Linear elements are exact here because the true displacement of a
      uniform bar without body load is linear. Supports are treated in detail in
      <a href="/theory/numerical-methods/loads-and-constraints/">Loads and constraints</a>.</p>

    <h2 id="scatter">Assembly as gather and scatter</h2>
    <p>Formally, a Boolean matrix A<sub>e</sub> of size 3n<sub>e</sub> × n<sub>d</sub>
      gathers the element’s DOFs from the global vector:
      d<sup>(e)</sup> = A<sub>e</sub><b>d</b>. Equating the internal work
      of the elements with the global work gives:</p>
    ${equation("K = \\sum_e A_e^T K^{(e)} A_e, \\quad f = \\sum_e A_e^T f^{(e)}.", "Global stiffness is the sum over elements of A e transpose times element stiffness times A e; the global load is the sum of A e transpose times element load")}
    <p>A<sub>e</sub> is never built. Implementations keep a list of the
      element’s global DOF indices and add entry (i, j) of K<sup>(e)</sup> to
      entry (index[i], index[j]) of K. Elements may be processed in any order.
      In the bar, element 1 has indices (1, 2) and element 2 has (2, 3).</p>

    <h2 id="shared-face">Two tetrahedra sharing a face</h2>
    <p>Take five vertices, 0 to 4, and two order-1 tetrahedra: T<sub>1</sub> =
      (0, 1, 2, 3) and T<sub>2</sub> = (1, 2, 3, 4). They share the face
      (1, 2, 3). With n<sub>b</sub> = 5, there are 15 global DOFs. Using the
      component-blocked order explained below, component c ∈ {0, 1, 2}
      (x, y, z) of vertex v has global index v + 5c:</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Global DOF indices of two tetrahedra sharing a face; scroll horizontally if needed">
      <table>
        <caption>Global DOF indices per element</caption>
        <thead><tr><th scope="col">Element</th><th scope="col">x DOFs</th><th scope="col">y DOFs</th><th scope="col">z DOFs</th></tr></thead>
        <tbody>
          <tr><th scope="row">T<sub>1</sub> (0, 1, 2, 3)</th><td>0, 1, 2, 3</td><td>5, 6, 7, 8</td><td>10, 11, 12, 13</td></tr>
          <tr><th scope="row">T<sub>2</sub> (1, 2, 3, 4)</th><td>1, 2, 3, 4</td><td>6, 7, 8, 9</td><td>11, 12, 13, 14</td></tr>
        </tbody>
      </table>
    </div>
    <p>Each 12 × 12 element matrix lands in a 15 × 15 global matrix. Nine DOFs
      belong to both elements, so the 9 × 9 block of the shared face receives
      two contributions. Vertices 0 and 4 share no element, so their 3 × 3
      coupling block stays zero. Of the 25 vertex pairs, 23 are coupled:
      the global matrix has 23 × 9 = 207 structural nonzeros out of 225.
      In a large mesh each vertex couples only to its neighbours, so almost
      all entries are zero and K is stored as a sparse matrix.</p>

    <h2 id="dof-ordering">DOF ordering</h2>
    <p>Two orders are common for the same coefficients:</p>
    <ul>
      <li><strong>Interleaved</strong> (by node): (d<sub>0x</sub>, d<sub>0y</sub>,
        d<sub>0z</sub>, d<sub>1x</sub>, …), index 3v + c. The
        <a href="/theory/notation/#discrete-displacement">notation reference</a>
        and the B blocks on the elements page use this order.</li>
      <li><strong>Component-blocked</strong>: all x coefficients, then all y,
        then all z, index v + n<sub>b</sub>c.</li>
    </ul>
    <p>KoFEM’s solid solve uses MFEM’s default, component-blocked global order.
      MFEM’s elasticity integrator also orders each element matrix by
      component: local index k + n<sub>e</sub>c. The two orders differ only by a
      permutation matrix P: ${tex("K_{\\mathrm{blocked}} = PK_{\\mathrm{interleaved}}P^T")}.
      For the worked tetrahedron, exact arithmetic confirms that MFEM’s form
      equals the permuted <b>B</b>ᵀC<b>B</b> matrix. The displacement field and
      every physical result are unchanged; only array positions differ.</p>
    <p>At order 1 the scalar index of a vertex DOF is the input vertex index,
      so the x, y, z displacement of vertex v sits at v, v + n<sub>b</sub> and
      v + 2n<sub>b</sub>. At order 2, edge functions follow all vertex
      functions. When MFEM corrects a tetrahedron’s orientation it reorders
      that element’s local corners; global vertex numbers do not change.</p>

    <h2 id="global-properties">Properties of the global matrix</h2>
    <ul>
      <li><strong>Size:</strong> n<sub>d</sub> × n<sub>d</sub>, N/mm. The load
        vector has n<sub>d</sub> entries in N.</li>
      <li><strong>Symmetric</strong>, because every element matrix is.</li>
      <li><strong>Sparse</strong>: nonzero only where two DOFs share an element.</li>
      <li><strong>Positive semi-definite</strong> before supports: the strain
        energy ½<b>d</b>ᵀK<b>d</b> is never negative.</li>
      <li><strong>Singular</strong> before supports: every unconnected body has
        six rigid-body modes. Supports must remove all of them before the
        system can be solved.</li>
    </ul>
    <p>Bodies with different materials still assemble into one K. Each element
      uses its own body’s λ and μ, and contributions add at shared nodes.
      The <a href="/theory/numerical-methods/linear-solve/">Linear solve</a>
      page explains how the constrained system is solved.</p>

    <h2 id="implementation">KoFEM and MFEM responsibilities</h2>
    <p>Reviewed on 2 November 2026 at
      <a href="https://github.com/mkofler96/KoFEM/tree/${revision}"><code>${revision.slice(0, 7)}</code></a>,
      against MFEM 4.7. The solid solve is
      ${source("engine/cpp/solve_mfem.cpp", 182, "solve_linear_elastic")}.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Map from textbook steps to the KoFEM and MFEM implementation; scroll horizontally if needed">
      <table class="responsibility-table">
        <caption>Textbook step to production code</caption>
        <thead><tr><th scope="col">Step</th><th scope="col">Owner</th><th scope="col">What happens</th></tr></thead>
        <tbody>
          <tr><th scope="row">Mesh and connectivity</th><td>KoFEM, MFEM</td><td>KoFEM adds vertices and tetrahedra/hexahedra with a material attribute per element
            (${source("engine/cpp/fem_mesh_io.cpp", 113, "fem_mesh_io.cpp")}); MFEM builds edges and faces and fixes element orientation.</td></tr>
          <tr><th scope="row">Shape functions and DOF numbering</th><td>MFEM</td><td>An order-k H1 space with three components, component-blocked
            (${source("engine/cpp/solve_mfem.cpp", 259, "solve_mfem.cpp")}).</td></tr>
          <tr><th scope="row">Material per element</th><td>KoFEM</td><td>λ and μ from each body’s E and ν, selected by element attribute
            (${source("engine/cpp/solve_mfem.cpp", 288, "solve_mfem.cpp")}).</td></tr>
          <tr><th scope="row">Element stiffness and quadrature</th><td>MFEM</td><td>Elasticity integrator with its default rule
            (${mfemSource("fem/bilininteg.cpp", 3033, "bilininteg.cpp")}).</td></tr>
          <tr><th scope="row">Scatter-add into K</th><td>MFEM</td><td>Bilinear-form assembly into a sparse matrix
            (${source("engine/cpp/solve_mfem.cpp", 291, "solve_mfem.cpp")}).</td></tr>
          <tr><th scope="row">Surface loads</th><td>KoFEM, MFEM</td><td>KoFEM builds the traction for each force, traction or pressure group and marks its faces; MFEM integrates N·t
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
      complete path in the browser engine; reproduce it with
      <code>node examples/validation/run.mjs --case axial-bar</code>.</p>

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
