// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, matrixEquation, tex } from "../operators/math.mjs";
import { source } from "./sources.mjs";
import { figure } from "../figures/index.mjs";

export default {
  slug: "solid-mechanics/linear-elasticity",
  description:
    "The small-strain, isotropic linear-elastic solid: displacement, strain, stress and traction, the relations between E, ν and the Lamé constants, a uniaxial check with units, and where the model stops applying.",
  sections: [
    ["assumptions", "Assumptions and scope"],
    ["displacement-and-strain", "From displacement to small strain"],
    ["small-rotations", "Why small rotations matter"],
    ["stress-and-traction", "Stress and traction"],
    ["isotropic-law", "The isotropic linear-elastic law"],
    ["material-constants", "Material constants and their limits"],
    ["uniaxial-check", "Worked check: a bar in uniaxial tension"],
    ["strain-energy", "Strain energy"],
    ["limitations", "Where the model stops applying"],
    ["implementation", "KoFEM implementation"],
    ["references", "Sources and further reading"],
  ],
  body: `
    <p class="lede">Which assumptions lead from displacement to isotropic linear-elastic stress?</p>
    <p>A linear-elastic model describes a solid that deforms a little under
      load and returns to its original shape when the load is removed. Three
      fields describe it: how far each point moves, how much the material is
      stretched or sheared, and the internal force per area. This page links
      them. <a href="/theory/solid-mechanics/equilibrium-and-weak-form/">Equilibrium and weak form</a>
      then adds force balance and boundary conditions. Units are N, mm and
      MPa (N/mm²), as in the <a href="/theory/foundations/consistent-units/">consistent-unit reference</a>.</p>

    <h2 id="assumptions">Assumptions and scope</h2>
    <p>The model on this page, and KoFEM’s solid solver, assume:</p>
    <ul>
      <li><strong>Static:</strong> loads are applied slowly; inertia and damping are ignored.</li>
      <li><strong>Small displacement and small strain:</strong> the deformed shape is
        close enough to the original that all equations are written on the
        undeformed body, and strains are much smaller than 1.</li>
      <li><strong>Linear elastic:</strong> stress is proportional to strain, with no
        yielding, damage, creep or rate dependence. Removing the load removes
        all deformation.</li>
      <li><strong>Isotropic and piecewise homogeneous:</strong> the stiffness is the
        same in every direction and constant within each body.</li>
      <li><strong>Stress-free reference:</strong> no initial stress, preload or thermal strain.</li>
      <li><strong>Fully three-dimensional:</strong> no plane-stress, plane-strain or
        axisymmetric reduction.</li>
    </ul>
    <p>Positions use a fixed Cartesian basis
      ${tex("x_1 = x")}, ${tex("x_2 = y")}, ${tex("x_3 = z")}; repeated indices are summed, as in the
      <a href="/theory/notation/#reading-notation">notation reference</a>.
      Shells use a reduced form of the same material law, described in
      <a href="/theory/shells/formulation/">Shell formulation</a>.</p>

    <h2 id="displacement-and-strain">From displacement to small strain</h2>
    <p>The <a href="/theory/notation/#displacement">displacement</a> ${tex("\\mathbf{u}(\\mathbf{x})")}
      (mm) moves the point originally at <a href="/theory/notation/#position">position</a>
      ${tex("\\mathbf{x}")} to ${tex("\\mathbf{x} + \\mathbf{u}")}. Displacement alone says nothing about
      deformation: a body can translate without stretching. Deformation is
      measured by how displacement changes from point to point, its
      <a href="/theory/notation/#gradient">gradient</a> ${tex("∇\\mathbf{u}")}, with components ${tex("∂u_i/∂x_j")}.</p>
    <p>The <a href="/theory/notation/#strain">small-strain tensor</a> is the
      <a href="/theory/notation/#symmetric-gradient">symmetric part</a> of that gradient:</p>
    ${equation("\\mathbf{ε} = \\frac{1}{2}(∇\\mathbf{u} + (∇\\mathbf{u})^T), \\quad ε_{ij} = \\frac{1}{2}\\left(\\frac{∂u_i}{∂x_j} + \\frac{∂u_j}{∂x_i}\\right).", "Small strain is the symmetric part of the displacement gradient; component i j is half the sum of the derivative of u i with respect to x j and of u j with respect to x i")}
    <p>Strain is dimensionless (mm/mm). The diagonal entries ${tex("ε_{xx}, ε_{yy}, ε_{zz}")}
      are stretches along the axes, positive when a fibre lengthens. Their sum,
      the <a href="/theory/notation/#trace">trace</a> ${tex("\\mathrm{tr}\\,\\mathbf{ε} = ∇\\cdot\\mathbf{u}")}, is the
      relative change in volume. The off-diagonal entries are shear: ${tex("2ε_{xy}")}
      is the decrease in the right angle between fibres along ${tex("x")} and ${tex("y")}.
      That factor of 2 is the <a href="/theory/notation/#engineering-shear">engineering shear strain</a>
      ${tex("γ_{xy}")}.</p>
    <p>The antisymmetric part of ${tex("∇\\mathbf{u}")} is a small rigid rotation.
      Dropping it means rigid translations and small rigid rotations produce
      no strain. <a href="/theory/operators/gradient-divergence/#symmetric-gradient">Gradient and divergence</a>
      works through this split for a concrete field.</p>

    <h2 id="small-rotations">Why small rotations matter</h2>
    <p>The symmetric gradient is a linearisation. It is exact for rigid
      translations but only approximate for a rigid rotation. Rotate a body
      by angle ${tex("θ")} about ${tex("z")}, without deforming it. Then
      ${tex("u_x = (\\cos θ - 1)x - (\\sin θ)y")} and
      ${tex("u_y = (\\sin θ)x + (\\cos θ - 1)y")}, so</p>
    ${equation("ε_{xx} = ε_{yy} = \\cos θ - 1 \\approx -\\frac{θ^2}{2}, \\quad ε_{xy} = 0.", "For a rigid rotation by theta, the small-strain normal components equal cosine theta minus one, approximately minus theta squared over two, and the shear component is zero")}
    <p>A rigid rotation should give zero strain. The error grows with ${tex("θ^2")}:
      at ${tex("θ = 0.01")} rad (0.57°) it is ${tex("-5 × 10^{-5}")}; at
      ${tex("θ = 0.1")} rad (5.7°) it is about ${tex("-5.0 × 10^{-3}")}, ten
      times the working strain of the steel bar checked below. A slender part that
      visibly rotates under load, such as a long cantilever or a thin flexible
      strip, therefore violates the small-strain assumption even when the
      material itself stretches very little.</p>

    <h2 id="stress-and-traction">Stress and traction</h2>
    <p>Cut the body by an imaginary surface with unit normal
      <a href="/theory/notation/#normal">${tex("\\mathbf{n}")}</a>. The force per area that one side
      exerts on the other is the <a href="/theory/notation/#traction">traction</a>
      ${tex("\\mathbf{t}")} (N/mm² = MPa). Cauchy’s stress theorem says a single tensor, the
      <a href="/theory/notation/#stress">stress</a> ${tex("\\mathbf{σ}")}, gives the traction for every
      cut direction:</p>
    ${equation("\\mathbf{t} = \\mathbf{σ}\\mathbf{n}, \\quad t_i = σ_{ij}n_j.", "Traction is stress times the unit normal; component i is the sum over j of sigma i j times n j")}
    <p>Component ${tex("σ_{ij}")} is the force in direction ${tex("i")} per unit area of a
      face whose outward normal points along ${tex("j")}. Tension is positive:
      ${tex("σ_{xx} > 0")} pulls a face with ${tex("\\mathbf{n} = (1, 0, 0)")} outward, and the opposite face,
      ${tex("\\mathbf{n} = (-1, 0, 0)")}, is pulled the other way. Balance of moments on a
      small cube makes the stress symmetric, ${tex("σ_{ij} = σ_{ji}")}, so it has six
      independent components. The scalar <a href="/theory/notation/#von-mises">von Mises stress</a>
      summarises them for yield checks; it is not a tensor component and has no sign.</p>
    ${figure("stress-cube", "Stress components on the faces of a small cube. On each face, one normal stress (red) acts along the face normal and two shear stresses (blue) act in the face.")}

    <h2 id="isotropic-law">The isotropic linear-elastic law</h2>
    <p>A linear-elastic material maps strain to stress linearly. For an
      isotropic material, two constants suffice. With the
      <a href="/theory/notation/#lame-parameters">Lamé parameters</a> ${tex("λ")} and ${tex("μ")} (MPa)
      and the <a href="/theory/notation/#identity">identity tensor</a> ${tex("\\mathbf{I}")}:</p>
    ${equation("\\mathbf{σ} = λ(\\mathrm{tr}\\,\\mathbf{ε})\\mathbf{I} + 2μ\\mathbf{ε}, \\quad σ_{ij} = λε_{kk}δ_{ij} + 2με_{ij}.", "Isotropic linear-elastic law: stress is lambda times the strain trace times the identity, plus two mu times the strain")}
    <p>The first term responds only to volume change and acts equally in all
      directions; the second responds to every strain component.
      ${tex("δ_{ij}")} is the <a href="/theory/notation/#kronecker-delta">Kronecker delta</a>.
      Engineers usually specify <a href="/theory/notation/#young-modulus">Young’s modulus</a>
      ${tex("E")} and <a href="/theory/notation/#poisson-ratio">Poisson’s ratio</a> ${tex("ν")} instead,
      which are measured directly in a tension test. Inverting the law in those terms gives:</p>
    ${equation("\\mathbf{ε} = \\frac{1 + ν}{E}\\mathbf{σ} - \\frac{ν}{E}(\\mathrm{tr}\\,\\mathbf{σ})\\mathbf{I}.", "Inverse law: strain is one plus nu over E times stress, minus nu over E times the stress trace times the identity")}
    <p>In uniaxial stress ${tex("σ_{xx}")} this reads ${tex("ε_{xx} = σ_{xx}/E")} and
      ${tex("ε_{yy} = ε_{zz} = -νσ_{xx}/E")}: ${tex("E")} is the axial stiffness, ${tex("ν")} the ratio of
      lateral contraction to axial extension. In Voigt form, with the
      engineering-shear order ${tex("xx, yy, zz, yz, xz, xy")} used in
      <a href="/theory/numerical-methods/elements-and-quadrature/#strain-displacement">Elements and quadrature</a>:</p>
    ${matrixEquation(
      "\\mathbf{D} =",
      [
        ["λ + 2μ", "λ", "λ", "0", "0", "0"],
        ["λ", "λ + 2μ", "λ", "0", "0", "0"],
        ["λ", "λ", "λ + 2μ", "0", "0", "0"],
        ["0", "0", "0", "μ", "0", "0"],
        ["0", "0", "0", "0", "μ", "0"],
        ["0", "0", "0", "0", "0", "μ"],
      ],
      "Isotropic elasticity matrix D in Voigt notation: lambda plus two mu on the first three diagonal entries, lambda in the off-diagonal normal entries, mu on the three shear diagonal entries, zeros elsewhere",
    )}
    <p>The shear entries are ${tex("μ")}, not ${tex("2μ")}, because the Voigt vector stores
      engineering shear ${tex("γ_{ij} = 2ε_{ij}")}: ${tex("σ_{xy} = μγ_{xy}")}.
      ${tex("\\mathbf{D}")} has units MPa and is symmetric.</p>

    <h2 id="material-constants">Material constants and their limits</h2>
    <p>Any two of the common constants determine the rest:</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Isotropic elastic constants expressed through Young's modulus and Poisson's ratio; scroll horizontally if needed">
      <table>
        <caption>Isotropic constants from ${tex("E")} and ${tex("ν")}</caption>
        <thead><tr><th scope="col">Constant</th><th scope="col">Formula</th><th scope="col">Steel, ${tex("E = 210000")} MPa, ${tex("ν = 0.3")}</th></tr></thead>
        <tbody>
          <tr><th scope="row">Shear modulus ${tex("μ")} (also ${tex("G")})</th><td>${tex("E/[2(1 + ν)]")}</td><td>80769.2 MPa</td></tr>
          <tr><th scope="row">Lamé’s first parameter ${tex("λ")}</th><td>${tex("Eν/[(1 + ν)(1 - 2ν)]")}</td><td>121153.8 MPa</td></tr>
          <tr><th scope="row">Bulk modulus ${tex("K")}</th><td>${tex("E/[3(1 - 2ν)]")}</td><td>175000 MPa</td></tr>
          <tr><th scope="row">Ratio ${tex("λ/μ")}</th><td>${tex("2ν/(1 - 2ν)")}</td><td>1.5</td></tr>
        </tbody>
      </table>
    </div>
    <p>A stable material stores positive energy for every nonzero strain.
      That requires ${tex("μ > 0")} and ${tex("K > 0")}, which for ${tex("E")} and ${tex("ν")} means</p>
    ${equation("E > 0, \\quad -1 < ν < \\frac{1}{2}.", "Admissible isotropic constants: E positive and Poisson's ratio strictly between minus one and one half")}
    <p>As ${tex("ν")} approaches ½ the material becomes incompressible:
      ${tex("K")} and ${tex("λ")} grow without bound while ${tex("μ")} stays finite. At ${tex("ν = 0.49")},
      ${tex("λ/μ = 49")}; at ${tex("ν = 0.3")} it is 1.5. Rubber and other nearly
      incompressible materials therefore need special element formulations;
      the standard displacement elements discussed on the next pages become
      too stiff (volumetric locking). Most metals have ${tex("ν")} near 0.3; ${tex("ν = 0")} and
      negative values are physically possible.</p>

    <h2 id="uniaxial-check">Worked check: a bar in uniaxial tension</h2>
    <p>A steel bar 1000 mm long, with a 100 mm × 100 mm section
      (${tex("A = 10^4")} mm²), carries an axial force ${tex("P = 10^6")} N spread
      uniformly over each end. Its sides are free. Away from local end effects, the stress is
      uniaxial and uniform:</p>
    ${equation("σ_{xx} = \\frac{P}{A} = \\frac{10^6\\text{ N}}{10^4\\text{ mm}^2} = 100\\text{ MPa}.", "Axial stress is force over area: ten to the six newtons over ten to the four square millimetres equals 100 megapascals")}
    <p>The inverse law gives the strains. Units cancel to a pure number because
      MPa/MPa = 1:</p>
    ${equation("ε_{xx} = \\frac{100}{210000} = \\frac{1}{2100} \\approx 4.762 × 10^{-4}, \\quad ε_{yy} = ε_{zz} = -0.3\\,ε_{xx} = -\\frac{1}{7000}.", "Axial strain is 100 over 210000, one over 2100; lateral strains are minus 0.3 times that, minus one over 7000")}
    <p>Now check the forward law with the Lamé constants from the table,
      written exactly as ${tex("λ = 1575000/13")} MPa and ${tex("μ = 1050000/13")} MPa.
      The trace is ${tex("\\mathrm{tr}\\,\\mathbf{ε} = (1 - 2ν)ε_{xx} = 1/5250")}. Then</p>
    ${equation("σ_{xx} = λ\\,\\mathrm{tr}\\,\\mathbf{ε} + 2με_{xx} = \\frac{300}{13} + \\frac{1000}{13} = 100\\text{ MPa},", "Forward check of axial stress: lambda times trace is 300 over 13, two mu times axial strain is 1000 over 13, total 100 megapascals")}
    ${equation("σ_{yy} = λ\\,\\mathrm{tr}\\,\\mathbf{ε} + 2με_{yy} = \\frac{300}{13} - \\frac{300}{13} = 0.", "Forward check of lateral stress: 300 over 13 minus 300 over 13 equals zero, so the sides are stress free")}
    <p>The law reproduces the applied stress and leaves the free sides
      stress-free, as uniaxial tension requires. The resulting displacements are:</p>
    <ul>
      <li>extension ${tex("δ = ε_{xx}L = 1000/2100 \\approx 0.4762")} mm, which is the familiar
        ${tex("δ = PL/(EA)")};</li>
      <li>lateral contraction of each 100 mm side: ${tex("100 × (-1/7000) \\approx -0.0143")} mm; and</li>
      <li>von Mises stress: 100 MPa, equal to ${tex("σ_{xx}")} in uniaxial stress.</li>
    </ul>
    <p>A shear check is equally short: an engineering shear strain ${tex("γ_{xy} = 10^{-3}")}
      gives ${tex("σ_{xy} = μγ_{xy} \\approx 80.8")} MPa, with no normal stress. The
      <a href="/theory/verification/axial-bar/">axial-bar verification</a> compares the same
      bar with KoFEM’s full solve. Its fixed end also stops the lateral contraction
      locally, which the uniform solution above ignores.</p>

    <h2 id="strain-energy">Strain energy</h2>
    <p>Elastic deformation stores energy. Per unit volume, the strain energy
      density is</p>
    ${equation("W = \\frac{1}{2}\\mathbf{σ}:\\mathbf{ε} = \\frac{λ}{2}(\\mathrm{tr}\\,\\mathbf{ε})^2 + μ\\,\\mathbf{ε}:\\mathbf{ε},", "Strain energy density is one half of stress double-contracted with strain, equal to lambda over two times trace squared plus mu times strain double-contracted with itself")}
    <p>using the <a href="/theory/notation/#double-contraction">double contraction</a>
      ${tex("\\mathbf{σ}:\\mathbf{ε} = σ_{ij}ε_{ij}")}. Its units are MPa = N·mm/mm³, energy per volume.
      For the bar, ${tex("W = \\frac{1}{2} × 100 × \\frac{1}{2100} = \\frac{1}{42}")} N·mm/mm³.
      Over the volume ${tex("10^7")} mm³, the stored energy is about 238095 N·mm,
      equal to ${tex("\\frac{1}{2}Pδ")}, the work done by the slowly applied load. The admissible ranges
      above make ${tex("W")} positive for every nonzero strain. That positivity is what
      later makes the stiffness matrix of a supported model positive definite.</p>

    <h2 id="limitations">Where the model stops applying</h2>
    <p>The model is appropriate for stiff parts in service: small, reversible
      deformation of metals, rigid plastics and similar materials below their
      elastic limit. It answers “how far does it move and how high is the
      stress?”, not “when does it fail?”. Its assumptions stop holding when:</p>
    <ul>
      <li><strong>the stress exceeds the elastic limit.</strong> A linear model
        keeps scaling stress with load; it never yields. A computed von Mises
        stress above the yield strength means the real part would deform
        plastically and the computed distribution is no longer valid there.</li>
      <li><strong>rotations or displacements are large.</strong> Flexible strips,
        long cantilevers and snap-fits need a geometrically nonlinear
        analysis. Linear analysis also cannot predict buckling.</li>
      <li><strong>the material is not isotropic.</strong> Fibre composites, wood,
        rolled sheet with strong texture and many 3D-printed parts have
        direction-dependent stiffness.</li>
      <li><strong>the material is nearly incompressible</strong>, such as rubber or
        many elastomers, with ${tex("ν")} close to ½.</li>
      <li><strong>other strains or stresses exist</strong>: temperature change,
        bolt preload, residual stress, creep, or time- and rate-dependent
        behaviour.</li>
      <li><strong>loads are dynamic</strong>, such as impact or vibration near resonance.</li>
    </ul>

    <h2 id="implementation">KoFEM implementation</h2>
    <ul>
      <li>Each material stores ${tex("E")} (MPa), ${tex("ν")} and a density. The material form
        rejects ${tex("E ≤ 0")} and ${tex("ν")} outside ${tex("(-1, 0.5)")}
        (${source("web/src/components/panel/MaterialsPanel.tsx", 40, "MaterialsPanel.tsx")}).
        Density is stored but does not enter the static solve.</li>
      <li>The solid solver requires ${tex("E")} and ${tex("ν")} for every material and selects
        one material per element from the element’s body
        (${source("engine/cpp/solve_mfem.cpp", 149, "solve_mfem.cpp")}). The engine
        itself does not check their range; that check exists only in the app form.</li>
      <li>It converts each material to ${tex("λ")} and ${tex("μ")} with the formulas above
        (${source("engine/cpp/solve_mfem.cpp", 180, "solve_mfem.cpp")}); the mixed
        solid–shell solve does the same for its solid elements
        (${source("engine/cpp/solve_coupled.cpp", 66, "solve_coupled.cpp")}).</li>
      <li>Stress for the von Mises result uses the same law,
        ${tex("σ_{ij} = λε_{kk}δ_{ij} + 2με_{ij}")}
        (${source("engine/cpp/solve_mfem.cpp", 93, "solve_mfem.cpp")}).
        <a href="/theory/results/displacement-and-stress/">Displacement and stress</a>
        explains where it is sampled.</li>
    </ul>
    <p>KoFEM has no thermal, plastic, anisotropic, hyperelastic or
      geometrically nonlinear material model, and no
      separate treatment for nearly incompressible materials.</p>

    <h2 id="references">Sources and further reading</h2>
    <ol class="refs">
      <li>Gurtin, <cite>An Introduction to Continuum Mechanics</cite> (1981),
        small strain, Cauchy’s theorem and isotropic linear elasticity.</li>
      <li>Sadd, <cite>Elasticity: Theory, Applications, and Numerics</cite> (3rd ed., 2014),
        strain–displacement relations, elastic constants and their admissible ranges.</li>
      <li>Timoshenko and Goodier, <cite>Theory of Elasticity</cite> (3rd ed., 1970),
        uniaxial tension, shear and strain energy.</li>
      <li>Hughes, <cite>The Finite Element Method: Linear Static and Dynamic
        Finite Element Analysis</cite> (2000), the Voigt elasticity matrix and
        nearly incompressible materials.</li>
      <li><a href="https://jsdokken.com/dolfinx-tutorial/chapter2/linearelasticity.html">DOLFINx tutorial: The equations of linear elasticity</a>.</li>
    </ol>
    <p>The worked check uses exact rational arithmetic. Related pages:
      <a href="/theory/operators/gradient-divergence/">Gradient and divergence</a>,
      <a href="/theory/operators/tensor-products/">Tensor products and contractions</a>
      and <a href="/theory/solid-mechanics/equilibrium-and-weak-form/">Equilibrium and weak form</a>.</p>`,
};
