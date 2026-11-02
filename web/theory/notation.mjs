// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tex, texBlock } from "../../examples/validation/lib/tex.mjs";

const revision = "141be83ea768df22cd7471409fb0f389d6de502f";
const source = (path, label) =>
  `<a href="https://github.com/mkofler96/KoFEM/blob/${revision}/${path}">${label}</a>`;
// Bold identifiers retain native, selectable MathML rather than image glyphs.
const bold = (expression) =>
  tex(expression).replaceAll(
    /<mi>([^<]+)<\/mi>/g,
    '<mi mathvariant="bold" class="math-bold">$1</mi>',
  );
const equation = (expression, label) =>
  `<div class="equation" tabindex="0" role="region" aria-label="${label}; scroll horizontally if needed">${texBlock(expression)}</div>`;
const table = (caption, rows) =>
  `<div class="table-wrap" tabindex="0" role="region" aria-label="${caption}; scroll horizontally if needed">
    <table class="notation-table"><caption>${caption}</caption>
      <thead><tr><th scope="col">Symbol</th><th scope="col">Meaning and type</th><th scope="col">Units</th></tr></thead>
      <tbody>${rows.map(([id, symbol, meaning, units]) => `<tr id="${id}"><th scope="row">${symbol}</th><td>${meaning}</td><td>${units}</td></tr>`).join("")}</tbody>
    </table></div>`;

export default {
  slug: "notation",
  description:
    "A shared FEM reference for symbols, fields, discrete unknowns, mathematical operators, tensor and shear conventions, and KoFEM’s verified units.",
  sections: [
    ["reading-notation", "How to read the notation"],
    ["geometry-and-fields", "Geometry and physical fields"],
    ["materials-and-loads", "Materials and loads"],
    ["discrete-quantities", "Finite element quantities"],
    ["operators", "Operator reference"],
    ["components-and-signs", "Components, shear and signs"],
    ["kofem-units", "KoFEM units and a dimensional check"],
    ["code-names", "Reading the implementation"],
    ["references", "Sources and further reading"],
  ],
  body: `
    <p class="lede">What do the shared symbols, indices, coordinate conventions and units mean?</p>
    <p>Use this page as a lookup reference while reading the guide. Each article
      defines its local notation at first use and links back to these definitions.
      A local definition takes precedence when a symbol has another meaning.</p>

    <h2 id="reading-notation">How to read the notation</h2>
    <p>Italic letters such as ${tex("E")} denote <strong>scalars</strong>.
      Bold lowercase letters such as ${bold("u")} denote <strong>vectors</strong>;
      bold uppercase Latin letters such as ${bold("K")} denote
      <strong>matrices</strong>. Bold Greek letters such as ${bold("σ")}
      denote second-order <strong>tensors</strong>. A tensor describes a physical
      quantity independently of coordinates; a matrix stores its components in
      a chosen basis. Components such as ${tex("u_i")} and ${tex("σ_{ij}")}
      are scalars.</p>
    <p>A <strong>field</strong> assigns a value to every position: displacement
      ${bold("u")} depends on ${bold("x")}. A discrete coefficient vector
      ${bold("d")} is instead a finite list of unknown numbers. Its length is
      the number of degrees of freedom, not the number of spatial dimensions.</p>
    <p>Use a fixed Cartesian basis with ${tex("x_1=x")}, ${tex("x_2=y")}
      and ${tex("x_3=z")}. Spatial indices ${tex("i,j,k")} range from 1 to 3.
      Repeated spatial indices in one term are summed (Einstein convention):
      ${tex("a_i b_i = a_1 b_1 + a_2 b_2 + a_3 b_3")}.
      A free index labels the component of the result. Node or basis indices
      ${tex("a,b")} and element indices ${tex("e")} use explicit sums.</p>
    <p>A subscript can also be a label: ${tex("σ_{\\mathrm{vm}}")}
      means von Mises stress, not a sum over indices v and m. A superscript
      ${tex("h")} marks an FEM approximation, ${tex("(e)")} an element-local
      quantity, and ${tex("T")} a transpose; other numerical superscripts are
      powers. The <span id="kronecker-delta">Kronecker delta ${tex("δ_{ij}")}</span> is 1 for equal indices and
      0 otherwise. The <span id="identity">identity tensor ${bold("I")}</span> has these components.
      These are dimensionless. A plain ${tex("δ")} may instead mean the bar’s
      extension when an article defines it that way.</p>
    <p>Units below use N and mm to make dimensions concrete. The
      <a href="/theory/foundations/consistent-units/">consistent unit systems reference</a>
      covers other choices. “1” means dimensionless; vector and matrix sizes
      describe their shape, not their physical units.</p>

    <h2 id="geometry-and-fields">Geometry and physical fields</h2>
    ${table("Geometry and field symbols", [
      [
        "position",
        bold("x"),
        'Position; a 3-vector locating a point in the undeformed body. Its components are coordinates, not solve unknowns. See <a href="#discrete-displacement">discrete displacement</a>.',
        "mm",
      ],
      [
        "domain",
        tex("Ω"),
        'The body’s three-dimensional domain (a set of positions). Its volume measure is dV; see <a href="#integral">integration</a>.',
        "dV: mm³",
      ],
      [
        "boundary",
        tex("Γ, Γ_D, Γ_N"),
        'Boundary Γ = ∂Ω; Γ<sub>D</sub> carries prescribed displacement, Γ<sub>N</sub> prescribed traction. These are surface sets; their common edges do not add surface area. See <a href="#normal">normal</a>.',
        "dS: mm²",
      ],
      [
        "normal",
        bold("n"),
        'Unit outward normal on a solid boundary; a 3-vector field, defined where the surface has a normal. Its direction fixes the sign of <a href="#traction">traction</a>.',
        "1",
      ],
      [
        "displacement",
        bold("u"),
        'Displacement field; a 3-vector from the original to the displaced position. Its <a href="#symmetric-gradient">symmetric gradient</a> gives small strain.',
        "mm",
      ],
      [
        "test-function",
        bold("w"),
        'Test displacement (virtual displacement); a 3-vector field, zero on Γ<sub>D</sub> for prescribed-displacement problems. It weights equilibrium in the weak form; see <a href="#integral">virtual work</a>.',
        "mm",
      ],
      [
        "strain",
        bold("ε"),
        'Small-strain tensor; a symmetric 3 × 3 tensor, ε = sym ∇u. It measures relative deformation; see <a href="#engineering-shear">tensor versus engineering shear</a>.',
        "1 (mm/mm)",
      ],
      [
        "stress",
        bold("σ"),
        'Cauchy stress; a symmetric 3 × 3 tensor for the classical solid model. It maps a surface normal to <a href="#traction">force per area</a>.',
        "MPa = N/mm²",
      ],
      [
        "von-mises",
        tex("σ_{\\mathrm{vm}}"),
        'Von Mises equivalent stress; a non-negative scalar derived from the deviatoric stress. It is neither a displacement unknown nor a signed tensor component; see <a href="#components-and-signs">stress conventions</a>.',
        "MPa",
      ],
    ])}

    <h2 id="materials-and-loads">Materials and loads</h2>
    ${table("Material and load symbols", [
      [
        "young-modulus",
        tex("E"),
        'Young’s modulus; scalar stiffness for isotropic linear elasticity. See the <a href="/theory/foundations/model-and-units/#axial-bar">axial bar</a>.',
        "MPa",
      ],
      [
        "poisson-ratio",
        tex("ν"),
        'Poisson’s ratio; scalar ratio of lateral contraction to axial extension in uniaxial stress. The 3D isotropic elastic model requires −1 &lt; ν &lt; 0.5 and E &gt; 0. See <a href="#lame-parameters">Lamé parameters</a>.',
        "1",
      ],
      [
        "lame-parameters",
        tex("λ, μ"),
        'Lamé parameters; scalars defining σ = λ tr(ε) I + 2με. The shear modulus μ = E / [2(1 + ν)] and λ = Eν / [(1 + ν)(1 − 2ν)]. See <a href="#trace">trace</a> and <a href="#engineering-shear">shear</a>.',
        "MPa",
      ],
      [
        "density",
        tex("ρ"),
        'Mass density; scalar mass per volume. With seconds as the time unit, N–mm uses tonnes. This is distinct from dimensionless relative density in topology optimization. See <a href="#kofem-units">current app behaviour</a>.',
        "tonne/mm³",
      ],
      [
        "point-force",
        bold("P"),
        'Concentrated force; a 3-vector. A scalar P denotes its axial magnitude in the bar example. A force group spread over a face also specifies a total force, not force per area. See <a href="#load-vector">assembled loads</a>.',
        "N",
      ],
      [
        "traction",
        bold("t"),
        'Traction; a 3-vector field of force per surface area, tᵢ = σᵢⱼ nⱼ. Integrating it over the selected surface gives a resultant force. See <a href="#integral">integration</a>.',
        "N/mm²",
      ],
      [
        "body-force",
        bold("b"),
        'Body force per volume; a 3-vector field. For gravity, b = ρg, where g is acceleration. This general notation does not imply a gravity input in the current static app. See <a href="#kofem-units">units</a>.',
        "N/mm³",
      ],
      [
        "pressure",
        tex("p_{\\mathrm{load}}"),
        'Pressure magnitude; scalar, positive in compression, giving <b>t</b> = −p<sub>load</sub> <b>n</b> on a solid. The subscript distinguishes it from polynomial order p in some textbooks; this guide says order 1 or 2. See <a href="#components-and-signs">orientation</a>.',
        "MPa",
      ],
    ])}

    <h2 id="discrete-quantities">Finite element quantities</h2>
    <p>For a three-dimensional solid displacement approximation with ${tex("n_b")} scalar
      basis functions, there are ${tex("n_d=3n_b")} translational coefficients
      before constraints. Interpolation reconstructs the displacement field
      from those coefficients. In component form:</p>
    ${equation("u_i^h(x_1,x_2,x_3) = \\sum_{a=1}^{n_b} N_a(x_1,x_2,x_3) d_{ai}.", "The approximate displacement is the sum of shape functions times displacement coefficients")}
    ${table("Translational solid finite element quantities", [
      [
        "shape-functions",
        tex("N_a"),
        'Scalar shape function for basis a; dimensionless field. The interpolation matrix <b>N</b> groups N<sub>a</sub> <b>I</b> blocks and has size 3 × n<sub>d</sub>, so <b>u</b>ʰ = <b>N d</b>. Upright N in a unit is a newton, not a shape function. See <a href="#discrete-displacement">coefficients</a>. <a href="/theory/numerical-methods/elements-and-quadrature/#shape-functions">Linear and quadratic shape functions</a>.',
        "1",
      ],
      [
        "discrete-displacement",
        bold("d"),
        'Discrete displacement coefficient vector of length n<sub>d</sub>; d<sub>ai</sub> is its coefficient for basis a, component i. In a nodal displacement basis these are nodal values; higher order adds nodes beyond the corners. See <a href="#code-names">returned vertex samples</a>.',
        "mm",
      ],
      [
        "strain-displacement",
        bold("B"),
        'Strain–displacement matrix; size 6 × n<sub>d</sub> in the <a href="#engineering-shear">engineering-shear convention</a> below. Spatial derivatives of the shape functions give ε<sub>eng</sub> = <b>B d</b>. <a href="/theory/numerical-methods/elements-and-quadrature/#strain-displacement">B blocks and a worked element</a>.',
        "1/mm",
      ],
      [
        "stiffness",
        bold("K"),
        'Global stiffness matrix; size n<sub>d</sub> × n<sub>d</sub>. It maps translational coefficients to force in <b>K d = f</b>, with constraints treated appropriately. See the <a href="#dimensional-check">dimensional check</a>. <a href="/theory/numerical-methods/assembly/#bar-example">Assembly example</a>.',
        "N/mm",
      ],
      [
        "load-vector",
        bold("f"),
        'Assembled load vector of length n<sub>d</sub>; it includes concentrated loads and work-equivalent surface or volume contributions. A traction is integrated with shape functions, not copied into a force entry. See <a href="#integral">integration</a>. <a href="/theory/numerical-methods/elements-and-quadrature/#element-loads">Work-equivalent face loads</a>.',
        "N",
      ],
    ])}
    <p>The interpolation matrix above groups coefficients by basis:
      ${tex("(d_{1x},d_{1y},d_{1z},d_{2x},…)")}.
      Storage order is a numbering choice; changing it consistently leaves
      the physical approximation unchanged. See
      <a href="/theory/numerical-methods/assembly/#dof-ordering">DOF ordering</a>.</p>
    <p>These matrix sizes and units describe a translational solid problem.
      Shells add rotations (radians, dimensionless) and moments (N·mm), so their
      stiffness blocks have different units. A display-tessellation vertex is
      not automatically an FEM node, and a node identifier is not a DOF index.</p>

    <h2 id="operators">Operator reference</h2>
    <p>The definitions below fix the convention used by this guide. Detailed
      operator examples are linked from each entry.</p>
    <dl class="operator-definitions">
      <dt id="gradient">${tex("∇")} — Gradient</dt>
      <dd>Spatial derivative. For a scalar q, (∇q)ᵢ = ∂q/∂xᵢ is a 3-vector.
        For a vector v, (∇v)ᵢⱼ = ∂vᵢ/∂xⱼ is a 3 × 3 tensor: row i is the
        component being differentiated. Units are those of the field divided
        by mm. Displacement’s gradient is dimensionless.
        See <a href="#symmetric-gradient">symmetric gradient</a>. <a href="/theory/operators/gradient-divergence/#scalar-gradient">Scalar and vector gradient examples</a>.</dd>
      <dt id="symmetric-gradient">${tex("\\mathrm{sym} ∇")} — Symmetric gradient</dt>
      <dd>The symmetric part of the vector gradient: εᵢⱼ = (∂uᵢ/∂xⱼ + ∂uⱼ/∂xᵢ)/2.
        It is a symmetric 3 × 3 tensor with units of displacement per length,
        hence dimensionless. See <a href="#engineering-shear">shear components</a>. <a href="/theory/operators/gradient-divergence/#symmetric-gradient">Small-strain calculation</a>.</dd>
      <dt id="divergence">${tex("∇ \\cdot")} — Divergence</dt>
      <dd>For a vector v, div v = ∂vᵢ/∂xᵢ is a scalar. For stress,
        (div σ)ᵢ = ∂σᵢⱼ/∂xⱼ is a 3-vector. Each has the field’s units divided
        by mm. Thus div σ and <a href="#body-force">body force</a> both have
        units N/mm³ in equilibrium, div σ + b = 0. <a href="/theory/operators/gradient-divergence/#stress-divergence">Vector and stress divergence examples</a>.</dd>
      <dt id="transpose">${tex("A^T")} — Transpose</dt>
      <dd>Swap rows and columns: (Aᵀ)ᵢⱼ = Aⱼᵢ. An m × n matrix becomes
        n × m; physical units stay the same. The symmetric part of A is
        (A + Aᵀ)/2. See <a href="#symmetric-gradient">small strain</a>. <a href="/theory/operators/tensor-products/#transpose">Transpose example</a>.</dd>
      <dt id="dot-product">${tex("a \\cdot b")} — Dot product</dt>
      <dd>The scalar aᵢbᵢ for two 3-vectors. Units multiply: force dotted
        with displacement has work units N·mm. The norm |a| = √(a·a) has
        the same units as a. See <a href="#integral">virtual work</a>. <a href="/theory/operators/tensor-products/#dot-product">Dot-product example</a>.</dd>
      <dt id="outer-product">${tex("a⊗b")} — Outer product</dt>
      <dd>Two 3-vectors form a 3 × 3 tensor, (a⊗b)ᵢⱼ = aᵢbⱼ; units multiply.
        Unlike a dot product, it retains two directions. See the
        <a href="/theory/operators/tensor-products/#outer-product">outer-product calculation</a>
        and its role in displacement interpolation.</dd>
      <dt id="double-contraction">${tex("A:B")} — Double contraction</dt>
      <dd>The scalar AᵢⱼBᵢⱼ, summed over both spatial indices for two
        second-order tensors. Units multiply. For symmetric tensors both
        off-diagonal entries contribute: σ:ε includes 2σₓᵧεₓᵧ, and similarly
        for the other shear pairs. See <a href="#engineering-shear">engineering shear</a>. <a href="/theory/operators/tensor-products/#double-contraction">Contraction and shear calculation</a>.</dd>
      <dt id="trace">${tex("\\mathrm{tr}(A)")} — Trace</dt>
      <dd>The scalar Aᵢᵢ = A₁₁ + A₂₂ + A₃₃ of a 3 × 3 tensor; units stay
        the same. For strain, it measures the first-order relative volume
        change. See <a href="#lame-parameters">the isotropic material law</a>. <a href="/theory/operators/tensor-products/#trace">Trace example</a>.</dd>
      <dt id="reference-coordinates">${tex("ξ")} — Reference coordinates</dt>
      <dd>A dimensionless 3-vector locating a point in a reference volume element.
        The map x = F(ξ) gives the physical position in mm. See the
        <a href="/theory/operators/reference-mapping/#element-map">tetrahedron example</a>.</dd>
      <dt id="jacobian">${tex("J")} — Mapping Jacobian</dt>
      <dd>The 3 × 3 matrix Jᵢⱼ = ∂xᵢ/∂ξⱼ, in mm. Its determinant scales volume;
        its inverse transpose transforms column gradients. See the
        <a href="/theory/operators/reference-mapping/#jacobian">Jacobian calculation</a>
        and <a href="/theory/operators/reference-mapping/#gradient-transform">gradient transformation</a>.</dd>
      <dt id="integral">${tex("\\int_Ω (·) dV, \\int_Γ (·) dS")} — Integrals</dt>
      <dd>Sum a field over a volume or surface. Units multiply by mm³ or mm².
        For example, the solid nodal force contribution ∫Γ Nₐtᵢ dS has units N.
        Virtual work ∫Ω ε(w):σ dV, ∫Ω w·b dV and ∫Γ w·t dS each has units
        N·mm. See <a href="#test-function">test displacement</a> and
        <a href="#load-vector">assembled loads</a>. <a href="/theory/operators/integration-by-parts/#volume-and-surface">Integration and virtual-work examples</a>.</dd>
    </dl>

    <h2 id="components-and-signs">Components, shear and signs</h2>
    <p>Global vectors use x, y, z order in a right-handed Cartesian frame;
      positive displacement and force components point along the corresponding
      positive axis. Positive normal stress means tension. For a solid, positive
      pressure acts inward, opposite the outward normal. A shell facet instead
      takes its normal from node winding; it has no unique outward side.
      KoFEM’s positive shell pressure acts against that winding normal.</p>
    <h3 id="engineering-shear">Tensor strain and engineering shear</h3>
    <p>Tensor shear εₓᵧ is half the engineering shear γₓᵧ. This guide orders
      six-component solid arrays as xx, yy, zz, yz, xz, xy and writes:</p>
    ${equation("ε_{\\mathrm{eng}} = (ε_{xx}, ε_{yy}, ε_{zz}, 2ε_{yz}, 2ε_{xz}, 2ε_{xy})^T.", "Engineering strain vector with doubled tensor shear components")}
    ${equation("σ_{\\mathrm{vec}} = (σ_{xx}, σ_{yy}, σ_{zz}, σ_{yz}, σ_{xz}, σ_{xy})^T.", "Stress vector in normal then yz, xz, xy order; shear stresses are not doubled")}
    <p>Shear stresses are <em>not</em> doubled. With this pairing,
      ${tex("σ:ε = σ_{\\mathrm{vec}}^T ε_{\\mathrm{eng}}")}.
      Other texts and libraries use different orders;
      check both order and shear scaling before multiplying arrays.</p>
    <p>For a simple shear displacement ${tex("u_x = αy, u_y = u_z = 0")}, choose
      α = 0.002. Then εₓᵧ = 0.001 and γₓᵧ = 0.002.
      With μ = 80000 MPa, σₓᵧ = 2μεₓᵧ = μγₓᵧ = 160 MPa.
      Using tensor shear in an engineering-shear matrix would halve this stress.</p>
    <p>KoFEM’s solid recovery computes the full 3 × 3 tensor directly.
      Its topology stress operator uses the six-component order above with
      engineering shear. Shell membrane calculations use local
      (εₓₓ, εᵧᵧ, γₓᵧ) and (σₓₓ, σᵧᵧ, τₓᵧ); τₓᵧ is the same shear stress
      component as σₓᵧ. Local shell axes follow the facet, not global x, y, z.</p>
    <p>Von Mises stress uses the deviatoric tensor sᵢⱼ = σᵢⱼ − tr(σ)δᵢⱼ/3:</p>
    ${equation("σ_{\\mathrm{vm}} = \\sqrt{\\frac{3}{2} s_{ij} s_{ij}}.", "Von Mises stress is the square root of three halves times the double contraction of deviatoric stress")}
    <p>The solid output samples it at each element centre. Shell output takes
      the greater value at the two surfaces, including membrane and bending.
      Coupled output keeps separate solid and shell element values. Smoothed
      viewport colours are derived values, not additional solved unknowns.</p>

    <h2 id="kofem-units">KoFEM units and a dimensional check</h2>
    <p>At the reviewed revision, the app labels and defaults use mm for length,
      displacement and shell thickness; N for force; N·mm for moment; and
      MPa (N/mm²) for Young’s modulus, pressure and stress. Mass density is
      labelled tonne/mm³. Default steel has E = 210000 MPa, ν = 0.3 and
      ρ = 7.85 × 10⁻⁹ tonne/mm³.</p>
    <p>The static solid, shell and coupled payloads pass numerical coordinates,
      stiffnesses, section sizes and loads without automatic unit conversion.
      The engine does not attach units to those numbers. The current static
      payloads do not use stored mass density to generate gravity or inertia.
      Check imported geometry scale and enter compatible values; the fixed
      result labels do not prove that inputs were consistent.</p>
    <p>For a general comparison of SI m–kg–s, N–mm–s, N–mm–ms, kN–mm–ms,
      CGS and US customary systems, see the separate
      <a href="/theory/foundations/consistent-units/#systems">unit-system table</a>
      and <a href="/theory/foundations/consistent-units/#material-values">material conversions</a>.
      SI uses Pa for stress and modulus; N–mm uses MPa. Converting changes the
      numbers for both material input and stress output while preserving the
      physical quantities. This does not imply a unit-system selector in KoFEM.</p>
    <h3 id="dimensional-check">Follow force through stiffness to displacement</h3>
    <p>Use the <a href="/theory/foundations/model-and-units/#axial-bar">uniform axial bar</a>
      with P = 1000 N, length L = 1000 mm, area A = 100 mm² and E = 210000 MPa.
      Here A is area, not a stiffness matrix. Its axial stiffness is a scalar:</p>
    ${equation("k_{\\mathrm{bar}} = \\frac{EA}{L} = \\frac{210000\\text{ N}/\\text{mm}^2 × 100\\text{ mm}^2}{1000\\text{ mm}} = 21000\\text{ N}/\\text{mm}.", "Axial stiffness equals modulus times area divided by length and has units of force per length")}
    <p>Stress is P/A = 10 MPa. Strain is σ/E ≈ 4.7619 × 10⁻⁵, dimensionless.
      Extension is ${tex("δ = P/k_{\\mathrm{bar}}")}
      = strain × L ≈ 0.047619 mm.
      Thus stiffness (N/mm) times displacement (mm) gives force (N), as required
      by <b>K d = f</b>. The bar permits lateral contraction and assumes uniform
      axial stress; a three-dimensional clamp changes the local stress state.</p>
    <p>In SI the same inputs are L = 1 m, A = 10⁻⁴ m² and E = 2.10 × 10¹¹ Pa.
      They give ${tex("k_{\\mathrm{bar}} = 2.10 × 10^7\\text{ N}/\\text{m}")},
      σ = 10⁷ Pa and δ ≈ 4.7619 × 10⁻⁵ m.
      The extension and stress are physically identical to the N–mm calculation.</p>

    <h2 id="code-names">Reading the implementation</h2>
    <p>Textbook symbols describe mathematical roles; local variable names need
      their surrounding code. In particular:</p>
    <ul>
      <li><code>vertices</code> stores xyz-interleaved positions. MFEM’s
        <code>x</code> GridFunction stores displacement coefficients, not
        spatial coordinates. The guide calls those coefficients <b>d</b>.</li>
      <li><code>A_mat</code>, <code>X</code> and <code>B</code> in the solid
        linear solve play the roles of stiffness, unknowns and right-hand side.
        That <code>B</code> is not the guide’s strain–displacement matrix.</li>
      <li><code>young</code>/<code>young_modulus</code> and
        <code>poisson</code>/<code>poisson_ratio</code> mean E and ν.
        <code>lam</code> and <code>mu</code> are the Lamé parameters.</li>
      <li><code>eps</code> is tensor strain in solid recovery; its local
        <code>s</code> array is full stress, although s in the equation above
        denotes deviatoric stress. Shell code also uses local <code>w</code>
        for normal displacement; the guide reserves <b>w</b> for a test field.</li>
      <li><code>displacements</code> returns [uₓ, uᵧ, u<sub>z</sub>] per vertex/node;
        the UI calls these <code>Ux</code>, <code>Uy</code>, <code>Uz</code>.
        Solid order-2 coefficient vectors also contain higher-order DOFs;
        returned corner samples do not contain the full vector. Shell/coupled
        internals group [uₓ, uᵧ, u<sub>z</sub>, θₓ, θᵧ, θ<sub>z</sub>] at each node;
        the displacement result returns translations. MFEM element coefficient
        arrays use component-major order (all x, then all y, then all z),
        rather than the basis grouping used in the interpolation above.</li>
      <li><code>von_mises</code> is a scalar per element, not a six-component
        stress array. The standard solid solve does not return a Voigt stress
        vector. <code>totalForce</code> can hold N, N·mm or MPa according to
        the load group’s kind; the name alone does not establish its units.</li>
    </ul>

    <h2 id="references">Sources and further reading</h2>
    <p>Product conventions reviewed on 2 November 2026 at
      <a href="https://github.com/mkofler96/KoFEM/tree/${revision}"><code>${revision}</code></a>.
      These sources establish storage, unit and sign conventions; they do not
      establish the accuracy of every model or stress concentration.</p>
    <ol class="refs">
      <li>${source("web/src/store/materialSlice.ts", "Material defaults")},
        ${source("web/src/components/panel/MaterialsPanel.tsx", "material input labels")},
        ${source("web/src/store/boundaryGroups.ts", "load quantities")} and
        ${source("web/src/lib/resultField.ts", "result units and averaging")}.</li>
      <li>Payloads:
        ${source("web/src/lib/solveMeshPacking.ts", "solid coordinates and materials")},
        ${source("web/src/lib/solve/shell.ts", "shell")},
        ${source("web/src/lib/solve/coupled.ts", "coupled")} and
        ${source("web/src/lib/coupledMaterials.ts", "coupled materials")}.</li>
      <li>${source("engine/cpp/solve_mfem.cpp", "Solid strain, stress and results")},
        ${source("engine/cpp/fem_bc_io.cpp", "solid pressure and traction")},
        ${source("engine/cpp/shell_element.cpp", "shell strain and local axes")},
        ${source("web/src/lib/solveLoads.ts", "shell pressure orientation")},
        ${source("engine/cpp/solve_shell.cpp", "shell outputs")},
        ${source("engine/cpp/solve_coupled.cpp", "coupled outputs")},
        ${source("engine/cpp/tet_element.cpp", "coupled solid stress")} and
        ${source("engine/cpp/topology_stress.cpp", "six-component stress order")}.</li>
      <li>Bathe, <cite>Finite Element Procedures</cite> (1996), continuum mechanics
        and displacement-based finite element formulations.</li>
      <li><a href="/theory/foundations/consistent-units/#references">Consistent-unit references</a>,
        including Ansys LS-DYNA, Barenblatt, Buckingham and Taylor.
        The <a href="/theory/foundations/consistent-units/#dimensional-analysis-example">blast-wave scaling example</a>
        shows what dimensional reasoning can and cannot determine.</li>
    </ol>`,
};
