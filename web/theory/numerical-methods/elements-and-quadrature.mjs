// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tex } from "../../../examples/validation/lib/tex.mjs";
import { equation, matrixEquation } from "../operators/math.mjs";
import { revision, source, mfemSource } from "./sources.mjs";

export default {
  slug: "numerical-methods/elements-and-quadrature",
  description:
    "How shape functions approximate solid displacement, which tetrahedral and hexahedral orders KoFEM solves, and how quadrature evaluates element stiffness and load integrals.",
  sections: [
    ["shape-functions", "Approximate displacement with shape functions"],
    ["supported-elements", "Solid elements KoFEM solves"],
    ["strain-displacement", "From coefficients to strain"],
    ["element-stiffness", "Element stiffness"],
    ["worked-element", "Worked example: one linear tetrahedron"],
    ["quadrature", "Choose the quadrature rule"],
    ["element-loads", "Element load vectors"],
    ["size-and-order", "Mesh size versus element order"],
    ["thin-walls", "Thin walls and linear tetrahedra"],
    ["implementation", "KoFEM implementation"],
    ["references", "Sources and further reading"],
  ],
  body: `
    <p class="lede">How are the displacement field and element integrals approximated?</p>
    <p>The <a href="/theory/solid-mechanics/equilibrium-and-weak-form/">weak form</a>
      asks for a displacement field in a space of infinitely many functions.
      A finite element method picks a finite set of shape functions on each
      element and evaluates every integral with a few weighted points.
      This page covers static, small-strain, linear-elastic 3D solids; shells
      use a different element. Units are N, mm and MPa throughout.</p>

    <h2 id="shape-functions">Approximate displacement with shape functions</h2>
    <p>Within one element, each displacement component is a weighted sum of
      dimensionless <a href="/theory/notation/#shape-functions">shape functions</a>
      N<sub>a</sub>. The weights are the
      <a href="/theory/notation/#discrete-displacement">displacement coefficients</a>
      d<sub>ai</sub> in mm:</p>
    ${equation("u_i^h(x) = \\sum_{a=1}^{n_e} N_a(x)\\,d_{ai}, \\quad i = x, y, z.", "Approximate displacement component i is the sum over the element's n e basis functions of shape function a times coefficient a i")}
    <p>Here n<sub>e</sub> is the number of scalar basis functions on the
      element. KoFEM’s solid elements are <em>nodal</em> (Lagrange):
      N<sub>a</sub> equals 1 at its own node and 0 at every other node.
      The coefficient d<sub>ai</sub> is then the displacement of node a in
      direction i. Two further properties matter:</p>
    <ul>
      <li><strong>Partition of unity.</strong> ΣN<sub>a</sub> = 1 everywhere.
        If every node moves by the same vector, the whole element translates
        rigidly and has zero strain.</li>
      <li><strong>Continuity.</strong> Neighbouring elements share the nodes on
        their common face. The displacement is continuous across that face,
        but its slope, and hence strain, generally jumps.</li>
    </ul>
    <p>On a tetrahedron the natural coordinates are the four barycentric
      coordinates L<sub>1</sub> … L<sub>4</sub>, each 1 at one corner and 0 on
      the opposite face; they sum to 1. With the
      <a href="/theory/operators/reference-mapping/#element-map">reference coordinates</a>
      ξ, η, ζ, they are 1 − ξ − η − ζ, ξ, η and ζ.</p>
    <ul>
      <li><strong>Order 1 (linear):</strong> N<sub>a</sub> = L<sub>a</sub> at
        the four corners.</li>
      <li><strong>Order 2 (quadratic):</strong>
        ${tex("N_a = L_a(2L_a - 1)")} at each corner and
        ${tex("N_{ab} = 4L_aL_b")} at the midpoint of the edge joining corners
        a and b. That gives 4 + 6 = 10 functions.</li>
    </ul>
    <p>A complete polynomial of degree k is represented exactly. Order 1
      therefore reproduces any linear displacement field, including uniform
      strain; order 2 also reproduces quadratic fields, such as the
      displacement of a beam under constant bending moment.</p>

    <h2 id="supported-elements">Solid elements KoFEM solves</h2>
    <p>The solid solver accepts tetrahedra and hexahedra at order 1 or 2.
      The app’s volume mesher creates tetrahedra; hexahedral input is used by
      solver-level validation cases. Each scalar basis function carries three
      translational coefficients, so an element with n<sub>e</sub> functions
      has 3n<sub>e</sub> DOFs.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Supported solid elements, their degrees of freedom and default stiffness quadrature; scroll horizontally if needed">
      <table>
        <caption>Solid elements at the reviewed revision</caption>
        <thead><tr><th scope="col">Element</th><th scope="col">Nodes</th><th scope="col">Element DOFs</th><th scope="col">Element stiffness</th><th scope="col">Stiffness rule</th></tr></thead>
        <tbody>
          <tr><th scope="row">Tetrahedron, order 1</th><td>4</td><td>12</td><td>12 × 12</td><td>1 point</td></tr>
          <tr><th scope="row">Tetrahedron, order 2</th><td>10</td><td>30</td><td>30 × 30</td><td>4 points</td></tr>
          <tr><th scope="row">Hexahedron, order 1</th><td>8</td><td>24</td><td>24 × 24</td><td>3 × 3 × 3</td></tr>
          <tr><th scope="row">Hexahedron, order 2</th><td>27</td><td>81</td><td>81 × 81</td><td>4 × 4 × 4</td></tr>
        </tbody>
      </table>
    </div>
    <p>An order-2 tetrahedron has nodes at its 4 corners and 6 edge midpoints.
      An order-2 hexahedron has 8 corner, 12 edge, 6 face and 1 centre node.
      Hexahedral rules are tensor products of Gauss points per direction.</p>
    <p>One element order applies to the whole solid solve. Order 2 raises the
      polynomial order of the displacement, not of the geometry: every element
      is still mapped from its straight-edged corner vertices. A curved CAD
      surface is therefore represented by flat element faces at either order.
      The mixed solid–shell solve always uses order-1 tetrahedra, and shells
      use their own flat-facet element.</p>

    <h2 id="strain-displacement">From coefficients to strain</h2>
    <p>Small strain needs first derivatives of displacement. Differentiating the
      interpolation moves the derivative onto the shape functions. The
      <a href="/theory/notation/#strain-displacement">strain–displacement matrix</a>
      collects those derivatives. For one basis function a it is a 6 × 3
      block, using the guide’s
      <a href="/theory/notation/#engineering-shear">engineering-shear order</a>
      xx, yy, zz, yz, xz, xy:</p>
    ${matrixEquation(
      "B_a =",
      [
        ["∂_xN_a", "0", "0"],
        ["0", "∂_yN_a", "0"],
        ["0", "0", "∂_zN_a"],
        ["0", "∂_zN_a", "∂_yN_a"],
        ["∂_zN_a", "0", "∂_xN_a"],
        ["∂_yN_a", "∂_xN_a", "0"],
      ],
      "Strain–displacement block for basis function a: six engineering strain rows by three displacement columns, entries are physical shape-function derivatives in inverse millimetres",
    )}
    ${equation("ε_{\\mathrm{eng}} = \\sum_a B_a d_a = Bd.", "Engineering strain is the sum of strain–displacement blocks times nodal displacement vectors")}
    <p>Here ∂<sub>x</sub>N<sub>a</sub> means ∂N<sub>a</sub>/∂x, with units 1/mm.
      d<sub>a</sub> is the 3-vector of coefficients for basis a, and
      <b>B</b> places the n<sub>e</sub> blocks side by side, so it is
      6 × 3n<sub>e</sub>. The physical derivatives come from the reference
      derivatives through the
      <a href="/theory/operators/reference-mapping/#gradient-transform">inverse-transpose Jacobian</a>.</p>
    <p>On a straight-edged linear tetrahedron, every ∇N<sub>a</sub> is
      constant, so the strain is constant inside the element. This is why it
      is often called the constant-strain tetrahedron.</p>

    <h2 id="element-stiffness">Element stiffness</h2>
    <p>Substituting the interpolation into internal virtual work gives the
      element <a href="/theory/notation/#stiffness">stiffness matrix</a>.
      With the isotropic elasticity matrix C (6 × 6, MPa) written in
      <a href="/theory/notation/#lame-parameters">Lamé parameters</a> λ and μ:</p>
    ${equation("K^{(e)} = \\int_{Ω_e} B^T C B\\,dV ≈ \\sum_{q} B^T(ξ_q)\\,C\\,B(ξ_q)\\,|\\mathrm{det}J(ξ_q)|\\,w_q.", "Element stiffness is the volume integral of B transpose C B, evaluated as a sum over quadrature points of the integrand times the Jacobian determinant times the weight")}
    ${matrixEquation(
      "C =",
      [
        ["λ+2μ", "λ", "λ", "0", "0", "0"],
        ["λ", "λ+2μ", "λ", "0", "0", "0"],
        ["λ", "λ", "λ+2μ", "0", "0", "0"],
        ["0", "0", "0", "μ", "0", "0"],
        ["0", "0", "0", "0", "μ", "0"],
        ["0", "0", "0", "0", "0", "μ"],
      ],
      "Isotropic elasticity matrix in engineering-shear order, with lambda plus two mu on the normal diagonal, lambda off-diagonal and mu on the shear diagonal",
    )}
    <p>ξ<sub>q</sub> and w<sub>q</sub> are the reference quadrature points and
      dimensionless weights; |det J| converts reference volume to mm³. Units:
      (1/mm) × MPa × (1/mm) × mm³ = N/mm, a stiffness. K<sup>(e)</sup> is
      symmetric. Every rigid-body motion produces zero strain, so it has six
      zero-energy modes: three translations and three small rotations.</p>

    <h2 id="worked-element">Worked example: one linear tetrahedron</h2>
    <p>Place the corners at (0, 0, 0), (ℓ, 0, 0), (0, ℓ, 0) and (0, 0, ℓ) with
      edge length ℓ = 10 mm. Choose E = 250 MPa and ν = 0.25, a soft polymer, because
      these give the round values λ = μ = 100 MPa.</p>
    <ol>
      <li><strong>Mapping.</strong> J = ℓ<b>I</b>, so det J = 1000 mm³ and the
        volume is det J / 6 = 500/3 mm³ ≈ 166.7 mm³.</li>
      <li><strong>Gradients</strong> (1/mm): ∇N<sub>1</sub> = (−0.1, −0.1, −0.1),
        ∇N<sub>2</sub> = (0.1, 0, 0), ∇N<sub>3</sub> = (0, 0.1, 0),
        ∇N<sub>4</sub> = (0, 0, 0.1). They sum to zero, as partition of unity
        requires.</li>
      <li><strong>Sizes.</strong> Each B<sub>a</sub> is 6 × 3, <b>B</b> is
        6 × 12, C is 6 × 6 and K<sup>(e)</sup> is 12 × 12.</li>
      <li><strong>Quadrature.</strong> The integrand is constant, so one point
        with weight 1/6 is exact: K<sup>(e)</sup> = V<b>B</b>ᵀC<b>B</b>.</li>
    </ol>
    <p>The 3 × 3 block coupling node a to node b is
      ${tex("K_{ab} = B_a^T C B_b V")}. Three blocks, in N/mm, are:</p>
    ${matrixEquation(
      "K_{22} =",
      [
        ["500", "0", "0"],
        ["0", "500/3", "0"],
        ["0", "0", "500/3"],
      ],
      "Worked tetrahedron: node 2 diagonal block in newtons per millimetre",
    )}
    ${matrixEquation(
      "K_{23} =",
      [
        ["0", "500/3", "0"],
        ["500/3", "0", "0"],
        ["0", "0", "0"],
      ],
      "Worked tetrahedron: block coupling node 2 to node 3 in newtons per millimetre",
    )}
    ${matrixEquation(
      "K_{11} =",
      [
        ["2500/3", "1000/3", "1000/3"],
        ["1000/3", "2500/3", "1000/3"],
        ["1000/3", "1000/3", "2500/3"],
      ],
      "Worked tetrahedron: node 1 diagonal block in newtons per millimetre",
    )}
    <p>K<sub>22</sub> = (ℓ/6)·diag(λ + 2μ, μ, μ): pulling node 2 along x
      stretches the element, while moving it along y or z only shears it.
      Checks you can repeat:</p>
    <ul>
      <li>K<sup>(e)</sup> is symmetric; for example K<sub>32</sub> = K<sub>23</sub>ᵀ.</li>
      <li>A rigid x-translation, d = (1, 0, 0) mm at every node, gives zero
        nodal force. Each row of K<sup>(e)</sup> therefore sums to zero by
        component.</li>
      <li>A small rotation about z, d<sub>a</sub> = (−y<sub>a</sub>, x<sub>a</sub>, 0)
        multiplied by a small angle, also gives zero force.</li>
      <li>The matrix has rank 6: 12 DOFs minus six rigid-body modes.</li>
    </ul>

    <h2 id="quadrature">Choose the quadrature rule</h2>
    <p>Quadrature replaces a reference integral by a weighted sum of point
      values. A rule of degree p integrates every polynomial up to degree p
      exactly. The cheapest safe choice integrates the stiffness integrand
      exactly when it is a polynomial.</p>
    <p>On a straight-edged order-2 tetrahedron, each B entry is linear in ξ,
      so <b>B</b>ᵀC<b>B</b> is quadratic. Test a quadratic over the
      reference tetrahedron (volume 1/6):</p>
    ${equation("\\int_{Ω^r} ξ^2\\,dV = \\frac{1}{60}, \\quad \\text{1 point: } \\frac{1}{6}\\left(\\frac{1}{4}\\right)^2 = \\frac{1}{96}, \\quad \\text{4 points: } \\frac{1}{60}.", "The exact reference integral of xi squared is one sixtieth; the one-point centroid rule gives one ninety-sixth; the symmetric four-point rule gives one sixtieth")}
    <p>The four-point rule uses weights 1/24 at barycentric points
      (α, β, β, β) and permutations, with α = (5 + 3√5)/20 ≈ 0.5854 and
      β = (5 − √5)/20 ≈ 0.1382. Too few points underestimate such terms and
      can leave non-rigid deformation modes with zero computed energy.</p>
    <p>KoFEM leaves the stiffness rule to MFEM’s default: degree 2(k − 1)
      on straight-edged tetrahedra of order k, which is exact. For hexahedra
      the rule is a tensor product of Gauss points. It is exact for
      parallelepipeds; on a distorted hexahedron J varies and the integrand
      is no longer a polynomial, so any finite rule is approximate.
      The point counts are listed in the table above.</p>

    <h2 id="element-loads">Element load vectors</h2>
    <p>A surface <a href="/theory/notation/#traction">traction</a> t (MPa)
      enters through boundary work. On a loaded element face Γ<sub>e</sub>, the
      element <a href="/theory/notation/#load-vector">load vector</a> is:</p>
    ${equation("f_a^{(e)} = \\int_{Γ_e} N_a\\,t\\,dS.", "The load on basis function a is the face integral of its shape function times the traction")}
    <p>Each entry is a force in N: MPa × mm². For a uniform traction on a
      triangular face of area A<sub>f</sub>, the shares of the face force tA<sub>f</sub> are:</p>
    <ul>
      <li><strong>Order 1:</strong> 1/3 at each corner.</li>
      <li><strong>Order 2:</strong> 0 at each corner and 1/3 at each edge
        midpoint.</li>
    </ul>
    <p>The order-2 result is surprising but correct: the corner functions
      L(2L − 1) are negative over part of the face and integrate to zero.
      Splitting a face force equally over all six nodes would not be
      work-equivalent. KoFEM converts a face force group into a uniform
      traction, the total force divided by the loaded area, and integrates it
      this way. MFEM’s face rule has degree 2k: 3 points on an order-1
      triangle and 6 points on an order-2 triangle. The static solid solve
      applies no body force: density is stored but unused. How loads and
      supports enter the global system is covered in
      <a href="/theory/numerical-methods/loads-and-constraints/">Loads and constraints</a>.</p>

    <h2 id="size-and-order">Mesh size versus element order</h2>
    <p>Two controls reduce discretisation error: smaller elements
      (h-refinement) and higher order (p-refinement). For a smooth solution,
      standard error estimates give, as the element size h decreases at order k:</p>
    ${equation("\\text{strain and stress error} = O(h^k), \\quad \\text{displacement error} = O(h^{k+1}).", "For smooth solutions, strain and stress error are of order h to the power k, displacement error of order h to the power k plus one")}
    <p>These are general expectations, not KoFEM measurements. They need
      well-shaped elements and a smooth solution. Re-entrant corners, point
      loads and point supports create singularities: the local stress never
      converges, and rates elsewhere drop. Halving h at order 1 should
      roughly halve the stress error; at order 2 it should roughly quarter it.</p>
    <p>Order 2 costs more per element: a 30 × 30 instead of a 12 × 12
      tetrahedral stiffness, and more unknowns because every edge adds a
      node. In a typical tetrahedral mesh there are several edges per vertex,
      so the same mesh has several times as many DOFs at order 2. The
      <a href="/examples/cantilever/">cantilever beam example</a> shows a
      measured h- and order-study on hexahedra. Run it with
      <code>node examples/validation/run.mjs --case cantilever</code>, or
      <code>--case cantilever-p2</code>.</p>
    <p>At the reviewed revision, KoFEM returns solid displacement at element
      corners only, and one von Mises stress at each element centre. The
      order-2 edge coefficients are solved but are not part of the returned
      field; see
      <a href="/theory/results/displacement-and-stress/">Displacement and stress</a>.</p>

    <h2 id="thin-walls">Thin walls and linear tetrahedra</h2>
    <p>A wall in bending has strain that varies linearly through its thickness,
      from tension on one side to compression on the other. A linear
      tetrahedron has one constant strain. With one or two elements through
      the thickness, the mesh can only bend by also producing spurious shear
      and volume change. That parasitic energy makes the model too stiff.
      This effect is called locking.</p>
    <p>Locking also misleads convergence checks. Halving the element size
      changes the result only slowly, so two order-1 solutions can agree
      closely while both remain far from the converged answer. Agreement
      between successive order-1 meshes is not, by itself, evidence of
      accuracy.</p>
    <p><strong>Measured in KoFEM.</strong> An internal study of a 3 mm
      sheet-metal bracket (develop at <code>1e9ae5d</code>, 1 November 2026)
      found that order 2 on the same tetrahedral mesh about doubled the
      maximum displacement. Halving the order-1 element size changed it by
      only 2.6%. The study is tracked as issue KOF-274. At the reviewed
      revision, KoFEM does not warn about this case.</p>
    <p>For a thin-walled or bending-dominated solid:</p>
    <ul>
      <li>compare order 1 with order 2 on the same mesh before trusting the
        result;</li>
      <li>refine through the thickness, not just along the surface; and</li>
      <li>consider a shell idealisation of the wall.</li>
    </ul>

    <h2 id="implementation">KoFEM implementation</h2>
    <p>Reviewed on 2 November 2026 at
      <a href="https://github.com/mkofler96/KoFEM/tree/${revision}"><code>${revision.slice(0, 7)}</code></a>,
      against MFEM 4.7. KoFEM chooses the element order and passes it
      unchanged to MFEM. MFEM supplies shape functions, quadrature and element
      integrals.</p>
    <ul>
      <li>The app offers <em>Linear (1st order)</em> and
        <em>Quadratic (2nd order)</em>; the worker sends that order to the
        solid solve
        (${source("web/src/workers/solver.worker.ts", 608, "solver.worker.ts")}).</li>
      <li>The engine builds the order-k H1 vector space with three components
        (${source("engine/cpp/solve_mfem.cpp", 258, "solve_mfem.cpp")}).
        Element geometry comes from vertex positions only
        (${source("engine/cpp/fem_mesh_io.cpp", 113, "fem_mesh_io.cpp")}).</li>
      <li>Per-element λ and μ are computed from each body’s E and ν; MFEM’s
        elasticity integrator assembles the element stiffness
        (${source("engine/cpp/solve_mfem.cpp", 288, "solve_mfem.cpp")};
        ${mfemSource("fem/bilininteg.cpp", 3054, "MFEM default rule")}).</li>
      <li>Surface loads use MFEM’s boundary load integrator
        (${source("engine/cpp/fem_bc_io.cpp", 416, "fem_bc_io.cpp")};
        ${mfemSource("fem/lininteg.cpp", 387, "MFEM face rule")}).</li>
      <li>The mixed solid–shell path uses the same integrator at order 1
        (${source("engine/cpp/solve_coupled.cpp", 59, "solve_coupled.cpp")}).</li>
    </ul>
    <p>How these element contributions combine into one system is explained in
      <a href="/theory/numerical-methods/assembly/">Assembly</a>.</p>

    <h2 id="references">Sources and further reading</h2>
    <ol class="refs">
      <li><a href="https://mfem.org/fem/">MFEM: Finite element methods</a> and
        <a href="https://mfem.org/integration/">MFEM: Integration</a>,
        H1 spaces, element transformations and quadrature.</li>
      <li>Hughes, <cite>The Finite Element Method: Linear Static and Dynamic
        Finite Element Analysis</cite> (2000), shape functions, the B matrix and
        quadrature.</li>
      <li>Bathe, <cite>Finite Element Procedures</cite> (1996), isoparametric
        elements, numerical integration and locking.</li>
      <li>Keast, “Moderate-degree tetrahedral quadrature formulas”,
        <cite>Computer Methods in Applied Mechanics and Engineering</cite> 55
        (1986), symmetric tetrahedral rules.</li>
    </ol>
    <p>All numbers in the worked examples were checked with exact rational
      arithmetic. Related pages:
      <a href="/theory/solid-mechanics/linear-elasticity/">Linear elasticity</a>,
      <a href="/theory/operators/integration-by-parts/">Integration and the weak form</a>
      and the <a href="/examples/axial-bar/">axial bar example</a>.</p>`,
};
