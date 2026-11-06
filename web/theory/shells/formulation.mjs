// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, matrixEquation, tex } from "../operators/math.mjs";
import { evidence, number, percentError, source, table } from "./evidence.mjs";

export default {
  slug: "shells/formulation",
  description:
    "Understand KoFEM’s flat triangular Kirchhoff shell: mid-surface kinematics, CST membrane and DKT bending, thickness, surface stress, verified plate response and current modelling limits.",
  sections: [
    ["shell-or-solid", "Choose the physical idealisation"],
    ["kinematics", "Mid-surface motion and local axes"],
    ["stiffness", "Membrane and bending stiffness"],
    ["stress", "Stress resultants and surface stress"],
    ["supported-models", "Current inputs and limitations"],
    ["plate-example", "Check a uniformly loaded square plate"],
    ["references", "Reviewed implementation and references"],
  ],
  body: `
    <p class="lede">How does a flat triangular shell represent membrane and bending response?</p>
    <p>A shell replaces a thin wall’s volume with a mid-surface and a thickness.
      Its assumptions describe how material moves through that thickness.
      KoFEM combines a constant-strain triangle (CST) for in-plane stretching
      with a discrete Kirchhoff triangle (DKT) for bending.</p>

    <h2 id="shell-or-solid">Choose the physical idealisation</h2>
    <p>Use a shell when thickness is small relative to the lengths over which
      deformation changes, and through-thickness normal and transverse-shear
      deformation do not control the answer. A thin wall meshed as a solid
      still solves three-dimensional elasticity with translational unknowns;
      it needs enough volume elements to resolve bending through its thickness.
      Refining that mesh does not turn it into a shell.</p>
    <p>In KoFEM, choose <strong>Solid</strong> or <strong>Shell</strong> explicitly
      for each body in the geometry panel. Solid is the default. Shell asks the
      meshing pipeline to identify opposite planar wall faces, collapse them to
      mid-surfaces and assign their measured normal separation as thickness.
      It can retain solid material at roots and bulk regions, producing a mixed
      shell–solid model. Inspect the resulting FEM discretisation before solving.</p>
    <p class="note">Keep a region solid when thickness effects, local bearing,
      a joint or three-dimensional stress is the question. A shell’s surface
      von Mises value cannot resolve those effects. See
      <a href="/theory/shells/solid-coupling/#transition">retained solid transition regions</a>.</p>

    <h2 id="kinematics">Mid-surface motion and local axes</h2>
    <p>The formulation is static, small-strain and linear elastic, with an
      isotropic, homogeneous material through each section. It uses a
      Kirchhoff–Love assumption: a line initially normal to the mid-surface
      stays straight, normal and unstretched. There is no transverse-shear
      energy, geometric nonlinearity, plasticity, buckling analysis or laminate law.</p>
    <p>Each three-node facet has six unknowns per node: three translations and
      three small rotations, giving an 18-component element vector. Both vectors
      are stored in global axes. Locally, ${tex("e_1")} runs from node 0 to node 1,
      ${tex("e_3")} is the normalized cross product of the two edges from node 0,
      and ${tex("e_2=e_3×e_1")}. Node winding therefore fixes the normal.
      The code rotates translations and rotations into this right-handed basis
      for element calculations, then transforms stiffness back to global axes.</p>
    <p>Let ${tex("x,y")} be local surface coordinates and ${tex("z")} the signed
      distance along ${tex("e_3")}, with ${tex("-t/2≤z≤t/2")}.
      Mid-surface translations are ${tex("u_0,v_0,w_0")}; local rotations about
      ${tex("e_1,e_2,e_3")} are ${tex("θ_x,θ_y,θ_z")}.
      The physical section motion is:</p>
    ${equation("u(x,y,z)=u_0(x,y)+zθ_y(x,y),\\quad v(x,y,z)=v_0(x,y)-zθ_x(x,y),\\quad w(x,y,z)=w_0(x,y).", "Section translations equal mid-surface translations plus the rotation crossed with the thickness offset")}
    <p>Zero transverse shear gives ${tex("θ_x=∂w_0/∂y")} and
      ${tex("θ_y=-∂w_0/∂x")} in the smooth theory. DKT imposes the Kirchhoff
      constraint discretely, using quadratic rotation interpolation expressed
      in the three corner nodes’ displacement and rotation coefficients.
      It needs a connected triangle mesh with shared nodal coefficients,
      rather than a classical smooth plate approximation with continuous first
      derivatives. Rotations are independent algebraic unknowns, so they are
      not obtained by simply differentiating a linear triangle’s displacement.</p>
    <p>The rotation ${tex("θ_z")} about the facet normal is the <em>drilling</em>
      rotation. The physical CST/DKT blocks do not supply its stiffness.
      KoFEM adds a small diagonal stabilization, ${tex("10^{-4}")} times the
      mean bending diagonal per facet. This removes a numerical singularity;
      it is not a physical torsional constitutive law.</p>

    <h2 id="stiffness">Membrane and bending stiffness</h2>
    <p>Use the shared <a href="/theory/notation/#engineering-shear">engineering-shear convention</a>.
      The membrane strain vector ${tex("ε_m")} contains two normal strains and
      the in-plane engineering shear. The curvature vector ${tex("κ")} has units
      of inverse length and includes the doubled twisting curvature:</p>
    ${equation("ε_m=(∂u_0/∂x,∂v_0/∂y,∂u_0/∂y+∂v_0/∂x)^T,\\quad κ=(∂θ_y/∂x,-∂θ_x/∂y,∂θ_y/∂y-∂θ_x/∂x)^T.", "Membrane strain comes from in-plane displacement derivatives; bending curvature comes from derivatives of the two tangential rotations")}
    <p>The CST membrane strain is constant on a facet. DKT curvature varies
      across it. With <a href="/theory/notation/#young-modulus">Young’s modulus</a>
      ${tex("E")} and <a href="/theory/notation/#poisson-ratio">Poisson ratio</a>
      ${tex("ν")}, the plane-stress matrix is:</p>
    ${matrixEquation(
      "\\mathbf{C}_p=\\frac{E}{1-ν^2}",
      [
        ["1", "ν", "0"],
        ["ν", "1", "0"],
        ["0", "0", "(1-ν)/2"],
      ],
      "Isotropic plane-stress material matrix for two normal strains and engineering shear",
    )}
    <p>Write ${tex("ε_m=\\mathbf{B}_m\\mathbf{d}_m")} and
      ${tex("κ=\\mathbf{B}_b\\mathbf{d}_b")}, where the local coefficient
      vectors contain respectively the six in-plane and nine bending unknowns.
      On facet area ${tex("A_e")}, the two stiffness contributions are:</p>
    ${equation("\\mathbf{K}_m=\\int_{A_e}\\mathbf{B}_m^T(t\\mathbf{C}_p)\\mathbf{B}_m\\,dA,\\quad \\mathbf{K}_b=\\int_{A_e}\\mathbf{B}_b^T\\left(\\frac{t^3}{12}\\mathbf{C}_p\\right)\\mathbf{B}_b\\,dA.", "Membrane stiffness integrates thickness times the plane-stress law; bending stiffness integrates thickness cubed over twelve times that law")}
    <p>The membrane integral is constant times area. Bending uses three
      mid-edge points of equal weight ${tex("A_e/3")}. The flat, centred,
      homogeneous section has no membrane–bending material coupling term.
      Facets in different orientations still interact through shared global
      unknowns. Curved geometry is approximated by flat facets and needs
      geometric refinement as well as a displacement check.</p>
    <p><strong>Thickness matters strongly:</strong> membrane stiffness scales
      with ${tex("t")}, bending stiffness with ${tex("t^3")}.
      Doubling thickness multiplies these by 2 and 8. Thickness is a section
      property, not the triangle edge size. Check both when refining.</p>

    <h2 id="stress">Stress resultants and surface stress</h2>
    <p>Shell force resultants ${tex("n")} integrate in-plane stress through
      thickness; moment resultants ${tex("m")} integrate stress times its
      thickness coordinate. Each is a three-component local vector, ordered
      ${tex("xx,yy,xy")}. For the centred section:</p>
    ${equation("σ_p(z)=\\mathbf{C}_p(ε_m+zκ),\\quad n=\\int_{-t/2}^{t/2}σ_p(z)\\,dz=t\\mathbf{C}_p ε_m,\\quad m=\\int_{-t/2}^{t/2}zσ_p(z)\\,dz=\\frac{t^3}{12}\\mathbf{C}_p κ.", "Stress varies linearly through thickness; its thickness integral gives force per length, and its first moment gives bending moment per length")}
    <p>With N and mm, stress is MPa, ${tex("n")} is N/mm and ${tex("m")}
      is N·mm/mm (numerically N). These resultants are useful theory quantities;
      KoFEM’s static result does not return them as separate fields. See the
      <a href="/theory/notation/#shell-quantities">shared shell notation</a>.</p>
    <p>The implementation evaluates membrane strain and bending curvature at
      each facet centroid, forms plane-stress von Mises at ${tex("z=±t/2")},
      and returns the larger surface value. It returns three translations per
      node for the displacement field, rather than the six-component internal
      vector. A surface maximum loses the tension/compression sign and which
      side governed. It omits transverse normal and transverse shear stress;
      it is not a three-dimensional junction-stress estimate. Viewport smoothing
      adds the separate <a href="/theory/results/displacement-and-stress/#averaging">display recovery</a>.</p>

    <h2 id="supported-models">Current inputs and limitations</h2>
    ${table(
      "Shell support at the reviewed revision",
      ["Input", "Current behavior"],
      [
        [
          "CAD body selection",
          "One active body per model may be idealised as Shell. A second is rejected, even if it uses the same material. This guard concerns CAD idealisation, not a limit of one triangle or one wall.",
        ],
        [
          "Materials and sections",
          "Explicit all-CTRIA3 models may have several section properties and per-facet thicknesses, but must reference one material ID. Multiple shell material IDs are rejected. Mixed models also require one shell material; their explicit solid domain supports per-tet materials.",
        ],
        [
          "Geometry extraction",
          "Opposite planar faces are paired one to one, with planarity/area guards and a wall-separation cap of 15 in the app’s mm coordinates. Convex corners can share mid-surface nodes. Split faces and T-junctions, including I-section flanges, are not generally reconstructed; a converged web-only result does not establish a complete section.",
        ],
        [
          "Surface loads",
          "Uniform total face force, per-area traction and pressure become facet nodal forces, using one third of the facet contribution at each node. A total edge force is shared by edge length, half to each endpoint. Positive shell pressure acts against the winding normal. Pressure and per-area traction on edges are rejected.",
        ],
        [
          "Moments and restraints",
          "Pure-shell payloads accept nodal forces/moments and fixed or prescribed components 0–5. App moment groups normally become force couples. Mixed/idealised models use different rotation rules; see the coupling article. An all-shell model with a declared surface-to-point coupling is rejected.",
        ],
      ],
    )}
    <p>Shell selection expresses modelling intent; it does not prove successful
      idealisation. Check wall coverage, connectivity, normal direction,
      thickness and the retained solid. No detected wall produces an explicit
      error; detecting one wall does not certify that every wall was found.
      Revisit the idealisation when section geometry, load application or
      the quantity of interest changes.</p>

    <h2 id="plate-example">Check a uniformly loaded square plate</h2>
    <p>The existing native production-core test uses a square of side
      ${tex("a=1")}, thickness ${tex("t=0.01")}, ${tex("E=10^7")},
      ${tex("ν=0.3")} and uniform transverse load ${tex("q=1")}.
      One coherent interpretation is m, N, Pa: ${tex("a=1\\text{ m}")},
      ${tex("t=0.01\\text{ m}")}, ${tex("E=10^7\\text{ Pa}")} and
      ${tex("q=1\\text{ Pa}")}. These are normalized verification inputs,
      not the app’s mm/MPa defaults or a steel example. The test applies
      ${tex("q")} toward the positive local normal; this is the opposite sign
      to positive app shell pressure.</p>
    <p>Timoshenko and Woinowsky-Krieger give the small-deflection plate results
      below, with flexural rigidity ${tex("D=Et^3/[12(1-ν^2)]")}.
      ${tex("w_c")} is centre deflection; ${tex("M_c")}
      is either centre bending moment resultant for the simply supported square:</p>
    ${equation("w_c^{\\mathrm{SS}}=0.00406\\frac{qa^4}{D},\\quad w_c^{\\mathrm{clamped}}=0.00126\\frac{qa^4}{D},\\quad M_c^{\\mathrm{SS}}=0.0479qa^2.", "Square-plate references: simply supported and clamped centre deflections, and the simply supported centre moment at Poisson ratio 0.3")}
    <p>The mesh has 32 × 32 cells, two DKT/CST triangles per cell, and
      ${tex("6×33^2=6534")} coefficients before constraints. Clamped edges
      fix all six components. Simply supported edges fix normal translation
      and leave tangential bending rotations free; the test fixes in-plane
      translations and drilling everywhere to isolate bending. Facet area loads
      are split equally over their three nodes. Native CG uses relative target
      ${tex("10^{-10}")}.</p>
    ${table(
      "Executed square-plate comparison",
      ["Quantity", "Measured", "Reference", "Relative error", "Test band"],
      evidence.plate.map((row) => [
        row.name === "clamped-plate"
          ? "Clamped centre deflection (m)"
          : row.name === "simply-supported-plate"
            ? "Simply supported centre deflection (m)"
            : "Simply supported centre-near surface von Mises (Pa)",
        number(row.measured),
        number(row.reference),
        `${percentError(row.measured, row.reference)}%`,
        `${row.tolerancePercent}%`,
      ]),
    )}
    <p>At the simply supported centre the bending state is equal biaxial, so
      the surface von Mises reference is ${tex("6M_c/t^2")}. Recovery samples
      the closest facet centroid, not the exact centre. The inherited bands
      allow discretisation, rounded reference coefficients and that sampling
      offset; the 8% stress band is a regression threshold, not a general stress
      accuracy promise. This single mesh verifies these responses, not a
      convergence rate. The linear calculation also omits membrane stretching
      caused by large deflection; scale load down when a physical study needs
      deflection much smaller than thickness.</p>
    <pre><code>CXX=g++ bash scripts/test-shell.sh
node web/theory/shells/capture-evidence.mjs</code></pre>
    <p>The <a href="/theory/shells.json">executed numerical record</a> stores the
      commands, compiler, timestamp, printed precision and source revision.
      These runs exercise the production C++ core natively; they do not exercise
      CAD extraction or the browser/WASM wrappers. The
      <a href="/theory/shells/solid-coupling/#verification">transition comparison</a>
      addresses a separate load-transfer question.</p>

    <h2 id="references">Reviewed implementation and references</h2>
    <p>Reviewed on 6 November 2026 at
      <a href="https://github.com/mkofler96/KoFEM/tree/${evidence.sourceRevision}"><code>${evidence.sourceRevision.slice(0, 12)}</code></a>.</p>
    <ol class="refs">
      <li>Batoz, Bathe and Ho (1980), <cite>A study of three-node triangular plate bending elements</cite>, International Journal for Numerical Methods in Engineering 15, 1771–1812. This is the DKT reference, not a validation of KoFEM’s complete shell workflow.</li>
      <li>Timoshenko and Woinowsky-Krieger, <cite>Theory of Plates and Shells</cite>, 2nd ed. (1959), uniformly loaded square plates.</li>
      <li>${source("engine/cpp/shell_element.cpp", 30, "CST membrane")},
        ${source("engine/cpp/shell_element.cpp", 65, "DKT interpolation and stiffness")},
        ${source("engine/cpp/shell_element.cpp", 208, "local basis and drilling stabilization")},
        ${source("engine/cpp/shell_element.cpp", 270, "surface stress recovery")} and
        ${source("engine/cpp/solve_shell.cpp", 1, "WASM inputs and outputs")}.</li>
      <li>${source("web/src/lib/solve/autoShell.ts", 72, "one-Shell-body guard")},
        ${source("web/src/lib/solve/shell.ts", 25, "shell material and thickness resolution")},
        ${source("web/src/lib/shellize/walls.ts", 111, "wall pairing")},
        ${source("web/src/lib/shellize/midSurface.ts", 72, "mid-surface construction")},
        ${source("web/src/lib/solveLoads.ts", 20, "load distribution")} and
        ${source("engine/tests/shell_validation.cpp", 635, "executed plate cases")}.</li>
      <li>Current scope context:
        <a href="https://linear.app/kofem/issue/KOF-258">explicit Shell selection</a>,
        <a href="https://linear.app/kofem/issue/KOF-195">multiple shell materials</a> and
        <a href="https://linear.app/kofem/issue/KOF-205">split-wall and T-junction extraction</a>.
        The supported behavior above follows code at the reviewed revision.</li>
    </ol>`,
};
