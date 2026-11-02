// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, matrixEquation, tex } from "../operators/math.mjs";
import { revision, source, mfemSource } from "./sources.mjs";

export default {
  slug: "numerical-methods/loads-and-constraints",
  description:
    "How supports, prescribed displacements, face forces and pressures enter the global system, with a prescribed-displacement example, a force-to-traction check, rigid-body modes and what to inspect when a model is singular or too stiff.",
  sections: [
    ["two-kinds", "Two kinds of boundary condition"],
    ["supports", "Supports: fixed, per component and prescribed"],
    ["elimination", "How constraints change the system"],
    ["prescribed-example", "Worked example: a prescribed displacement"],
    ["loads", "Loads: force, traction, pressure and body force"],
    ["force-to-traction", "Worked example: from total force to traction"],
    ["rigid-body-modes", "Rigid-body modes"],
    ["insufficient", "Too few constraints"],
    ["overconstraint", "Too many constraints"],
    ["conflicts", "Conflicting constraints and unmatched selections"],
    ["diagnosis", "What to check when a result looks wrong"],
    ["implementation", "KoFEM implementation and evidence"],
    ["references", "Sources and further reading"],
  ],
  body: `
    <p class="lede">How do supported load and displacement conditions enter that system?</p>
    <p><a href="/theory/numerical-methods/assembly/">Assembly</a> produces a
      stiffness matrix ${tex("\\mathbf{K}")} and a load vector ${tex("\\mathbf{f}")}. Before any support is
      applied, ${tex("\\mathbf{K}")} is singular: the body can move as a rigid object without
      strain. Supports remove that freedom, and loads drive the deformation.
      This page explains both, and how either can change the answer. Units are
      N, mm and MPa, as in the
      <a href="/theory/foundations/consistent-units/">consistent-unit reference</a>.
      Shells and solid–shell couplings carry rotations as well and are treated in
      <a href="/theory/shells/formulation/">Shell formulation</a> and
      <a href="/theory/shells/solid-coupling/">Solid–shell coupling</a>.</p>

    <h2 id="two-kinds">Two kinds of boundary condition</h2>
    <p>The <a href="/theory/operators/integration-by-parts/#weak-form">weak form</a>
      of static equilibrium reads:</p>
    ${equation("\\int_Ω \\mathbf{ε}(\\mathbf{w}):\\mathbf{σ}\\,dV = \\int_Ω \\mathbf{w}\\cdot\\mathbf{b}\\,dV + \\int_{Γ_N} \\mathbf{w}\\cdot\\mathbf{t}\\,dS.", "Internal virtual work equals body-force work plus the work of the prescribed traction on the loaded boundary")}
    <p>The two parts of the <a href="/theory/notation/#boundary">boundary</a>
      enter in different ways:</p>
    <ul>
      <li><strong>Essential (displacement) conditions</strong> on ${tex("Γ_D")}
        set the displacement itself: ${tex("\\mathbf{u} = \\mathbf{u}_D")}, where ${tex("\\mathbf{u}_D")} is the
        prescribed value in mm. They are imposed on the unknowns, and the
        <a href="/theory/notation/#test-function">test displacement</a> ${tex("\\mathbf{w}")} is zero there.
        A fixed support is the special case ${tex("\\mathbf{u}_D = \\mathbf{0}")}.</li>
      <li><strong>Natural (load) conditions</strong> on ${tex("Γ_N")} prescribe a
        <a href="/theory/notation/#traction">traction</a> ${tex("\\mathbf{t}")} in MPa. They appear only as
        work on the right-hand side. A free surface with no load is also a
        natural condition, ${tex("\\mathbf{t} = \\mathbf{0}")}; it needs no input.</li>
    </ul>
    <p>The <a href="/theory/notation/#body-force">body force</a> ${tex("\\mathbf{b}")} (N/mm³) acts in the
      volume. A condition can be essential in one component and natural in the
      others: a roller fixes the normal displacement and leaves the tangential
      traction at zero.</p>

    <h2 id="supports">Supports: fixed, per component and prescribed</h2>
    <p>On a solid, each node has three translational DOFs, ${tex("u_x")}, ${tex("u_y")} and ${tex("u_z")},
      shown in the app as Ux, Uy and Uz. A support constrains some of them:</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Support types and the DOFs they constrain; scroll horizontally if needed">
      <table>
        <caption>Support types on a solid node</caption>
        <thead><tr><th scope="col">Support</th><th scope="col">Constrained</th><th scope="col">Typical use</th></tr></thead>
        <tbody>
          <tr><th scope="row">Fixed</th><td>Ux = Uy = Uz = 0</td><td>A welded or clamped face</td></tr>
          <tr><th scope="row">Per component</th><td>Only the chosen components = 0</td><td>A symmetry plane or sliding support (roller); a minimal 3-2-1 support</td></tr>
          <tr><th scope="row">Prescribed</th><td>Chosen components = a non-zero value in mm</td><td>A known imposed motion, such as a press stroke or a fit-up offset</td></tr>
        </tbody>
      </table>
    </div>
    <p>In the app, a boundary-condition group combines selected faces or points,
      the components to constrain and one value in mm. A value of 0 fixes those
      components; any other value prescribes it for each checked component.
      Solid nodes have no rotational DOFs, so Rx, Ry and Rz appear only when the
      model contains shells or a coupling reference point. A rotation cannot be
      fixed by constraining one solid node; constrain several nodes, or use a
      coupling.</p>
    <p>A prescribed displacement is a load path of its own. A model driven only by
      prescribed values, with no applied load, is valid and solves. Solve is
      enabled once a model has at least one support and either a load or a
      non-zero prescribed value.</p>

    <h2 id="elimination">How constraints change the system</h2>
    <p>Split the DOFs into free ones (F) and constrained ones (C). The assembled
      system ${tex("\\mathbf{K}\\mathbf{d} = \\mathbf{f} + \\mathbf{r}")} contains unknown
      reactions ${tex("\\mathbf{r}")}, nonzero only at constrained DOFs.
      Written in blocks, with ${tex("\\mathbf{d}_{\\mathrm{C}}")} known:</p>
    ${equation("\\mathbf{K}_{\\mathrm{FF}}\\mathbf{d}_{\\mathrm{F}} = \\mathbf{f}_{\\mathrm{F}} - \\mathbf{K}_{\\mathrm{FC}}\\mathbf{d}_{\\mathrm{C}}, \\quad \\mathbf{r}_{\\mathrm{C}} = \\mathbf{K}_{\\mathrm{CF}}\\mathbf{d}_{\\mathrm{F}} + \\mathbf{K}_{\\mathrm{CC}}\\mathbf{d}_{\\mathrm{C}} - \\mathbf{f}_{\\mathrm{C}}.", "The free block times the free displacements equals the free loads minus the free-to-constrained block times the prescribed values; the reactions follow from the constrained rows")}
    <p>The first equation is the one solved. A prescribed value moves to the
      right-hand side as an equivalent load, ${tex("-\\mathbf{K}_{\\mathrm{FC}}\\mathbf{d}_{\\mathrm{C}}")}. For a fixed support,
      ${tex("\\mathbf{d}_{\\mathrm{C}} = \\mathbf{0}")} and that term vanishes. The second equation recovers
      the support reactions afterwards.</p>
    <p>MFEM, the finite element library KoFEM uses, keeps the full matrix size
      instead of deleting rows. It zeroes the off-diagonal entries in each
      constrained row and column and keeps the diagonal. Each constrained row
      then reads ${tex("K_{ii}d_i = K_{ii}g_i")}, where ${tex("g_i")} is the prescribed value of DOF ${tex("i")},
      so ${tex("d_i = g_i")}. The free rows are exactly the first equation above. Two
      consequences follow:</p>
    <ul>
      <li>A load on a constrained DOF has no effect on the displacement. It goes
        straight into the support. A force on a fully fixed face, for example,
        does nothing.</li>
      <li>Reactions are not part of the solve. KoFEM does not report them at the
        reviewed revision; check support forces with a free-body diagram.</li>
    </ul>

    <h2 id="prescribed-example">Worked example: a prescribed displacement</h2>
    <p>Reuse the two-element bar from
      <a href="/theory/numerical-methods/assembly/#bar-example">Assembly</a>: ${tex("L = 1000\\text{ mm}")},
      ${tex("A = 10000\\text{ mm}^2")}, ${tex("E = 210000\\text{ MPa}")}, element stiffness
      ${tex("k = 4.2 × 10^6\\text{ N}/\\text{mm}")}. Fix node 1 (${tex("d_1 = 0")}), pull node 3 to
      ${tex("d_3 = 0.1\\text{ mm}")} and apply no force. Node 2 is the only free DOF.</p>
    ${matrixEquation(
      "\\mathbf{K} = k",
      [
        ["1", "-1", "0"],
        ["-1", "2", "-1"],
        ["0", "-1", "1"],
      ],
      "Assembled bar stiffness: k times one, minus one, zero; minus one, two, minus one; zero, minus one, one",
    )}
    <p>Row 2 gives ${tex("2kd_2 = 0 - (-k)(0) - (-k)(0.1\\text{ mm})")}, so the prescribed value acts
      as a load of ${tex("0.1k = 4.2 × 10^5\\text{ N}")} on node 2. After MFEM’s elimination:</p>
    ${matrixEquation(
      "\\mathbf{K}_{\\mathrm{elim}} = k",
      [
        ["1", "0", "0"],
        ["0", "2", "0"],
        ["0", "0", "1"],
      ],
      "Eliminated system matrix: k times one, zero, zero; zero, two, zero; zero, zero, one",
    )}
    <p>The right-hand side becomes ${tex("(k × 0, 0.1k, k × 0.1)")}: rows 1 and 3 restate the
      prescribed values, row 2 carries their equivalent load. Solving gives
      ${tex("d_2 = 0.1k/(2k) = 0.05\\text{ mm}")}, so ${tex("\\mathbf{d} = (0, 0.05, 0.1)\\text{ mm}")}.</p>
    <p>The reactions are ${tex("r_1 = k(d_1 - d_2) = -2.1 × 10^5\\text{ N}")} and
      ${tex("r_3 = k(d_3 - d_2) = 2.1 × 10^5\\text{ N}")}. They balance. As a check, a bar
      stretched by ${tex("δ")} needs ${tex("EAδ/L = 210000 × 10000 × 0.1/1000\\text{ N} = 2.1 × 10^5\\text{ N}")}.
      The axial stress is ${tex("Eδ/L = 21\\text{ MPa}")}. In KoFEM, the 3D bar with a
      sliding root face and Ux = 0.1 mm prescribed on its far face gives element
      von Mises stresses within 0.2% of 21 MPa; the small spread comes from the
      solver tolerance.</p>

    <h2 id="loads">Loads: force, traction, pressure and body force</h2>
    <p>A load enters only ${tex("\\mathbf{f}")}, as work-equivalent nodal forces in N. What
      the input means decides how it is distributed:</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Load types, their input and how they reach the load vector; scroll horizontally if needed">
      <table>
        <caption>Load types on a solid at the reviewed revision</caption>
        <thead><tr><th scope="col">Load</th><th scope="col">Input</th><th scope="col">Into ${tex("\\mathbf{f}")}</th></tr></thead>
        <tbody>
          <tr><th scope="row">Force on faces</th><td>Total vector ${tex("\\mathbf{F}")}, N</td><td>Uniform traction ${tex("\\mathbf{t} = \\mathbf{F}/A")} over the group’s whole area ${tex("A")}, integrated as ${tex("\\int N_a\\mathbf{t}\\,dS")}</td></tr>
          <tr><th scope="row">Pressure on faces</th><td>Scalar ${tex("p_{\\mathrm{load}}")}, MPa</td><td>Traction ${tex("\\mathbf{t} = -p_{\\mathrm{load}}\\mathbf{n}")}: positive pushes into the surface; follows curved faces</td></tr>
          <tr><th scope="row">Force on points</th><td>Total vector, N</td><td>Split equally over the picked nodes and added directly</td></tr>
          <tr><th scope="row">Moment on faces</th><td>Vector ${tex("\\mathbf{M}")}, N·mm</td><td>Tangential nodal forces about each selected face’s centroid, zero net force</td></tr>
          <tr><th scope="row">Body force</th><td>—</td><td>Not applied: the static solid solve has no gravity or other volume load</td></tr>
        </tbody>
      </table>
    </div>
    <p>A force is a total, not a force per area. Selecting a second face for the
      same force group spreads the same total over a larger area. A pressure is
      intensive: enlarging the selection increases the resultant. Loads
      superpose: two groups on the same face both act, and their effects add.
      Material density is stored but unused by the static solve.</p>
    <p>A moment group is different: the full moment is applied on <em>each</em>
      selected face. Two separate face selections in one moment group apply
      twice the moment. Select one face, or divide the value.</p>

    <h2 id="force-to-traction">Worked example: from total force to traction</h2>
    <p>Pull the 100 mm × 100 mm end face of the bar with ${tex("F = 10^6\\text{ N}")} in ${tex("x")}. The face
      area is ${tex("A = 10^4\\text{ mm}^2")}, so:</p>
    ${equation("t_x = \\frac{F}{A} = \\frac{10^6\\text{ N}}{10^4\\text{ mm}^2} = 100\\text{ N}/\\text{mm}^2 = 100\\text{ MPa}.", "Traction equals force over area: one million newtons over ten thousand square millimetres is 100 newtons per square millimetre, which is 100 megapascals")}
    <p>The engine logs the same conversion for this case:
      <code>force → traction [100 0 0] … (A=10000)</code>.
      Now mesh the face with 2 × 2 bilinear quadrilaterals of 50 mm × 50 mm.
      Each corner function of a quadrilateral integrates to a quarter of its
      area, ${tex("\\int N_a\\,dS = 2500/4\\text{ mm}^2 = 625\\text{ mm}^2")}, so every element gives
      ${tex("100 × 625\\text{ N} = 62500\\text{ N}")} to each of its four nodes. A node collects one
      share per adjacent element:</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Work-equivalent nodal forces on a two by two face; scroll horizontally if needed">
      <table>
        <caption>Nodal forces on a 2 × 2 face, ${tex("F = 10^6\\text{ N}")}</caption>
        <thead><tr><th scope="col">Node</th><th scope="col">Count</th><th scope="col">Elements</th><th scope="col">Force each</th><th scope="col">Subtotal</th></tr></thead>
        <tbody>
          <tr><th scope="row">Corner</th><td>4</td><td>1</td><td>62 500 N</td><td>250 000 N</td></tr>
          <tr><th scope="row">Edge midpoint</th><td>4</td><td>2</td><td>125 000 N</td><td>500 000 N</td></tr>
          <tr><th scope="row">Centre</th><td>1</td><td>4</td><td>250 000 N</td><td>250 000 N</td></tr>
          <tr><th scope="row">Total</th><td>9</td><td></td><td></td><td>1 000 000 N</td></tr>
        </tbody>
      </table>
    </div>
    <p>The resultant is ${tex("F")} again, and by symmetry it acts at the face centre.
      Splitting ${tex("F")} equally, ${tex("10^6/9\\text{ N} \\approx 111111\\text{ N}")} per node, gives the same
      total but the wrong distribution. On an uneven mesh it also moves the resultant. Split
      the same face into two strips, 20 mm and 80 mm wide, with nodes at
      ${tex("y = 0, 20, 100\\text{ mm}")}. Work-equivalent shares put the resultant at
      ${tex("y = 50\\text{ mm}")}, the face centroid. An equal split puts it at
      ${tex("y = (0 + 20 + 100)/3\\text{ mm} = 40\\text{ mm}")}: a spurious moment of
      ${tex("10^6\\text{ N} × 10\\text{ mm} = 10^7\\text{ N·mm}")}.</p>
    <p>A pressure of ${tex("p_{\\mathrm{load}} = 1\\text{ MPa}")} on the same face, whose outward
      normal is ${tex("+x")}, gives ${tex("\\mathbf{t} = (-1, 0, 0)\\text{ MPa}")} and a resultant of
      ${tex("-10^4\\text{ N}")} in ${tex("x")}: it pushes the face in. On a linear triangle, each
      corner receives one third of the face force; the quadratic shares are on
      <a href="/theory/numerical-methods/elements-and-quadrature/#element-loads">Elements and quadrature</a>.</p>

    <h2 id="rigid-body-modes">Rigid-body modes</h2>
    <p>A rigid motion moves a body without straining it. For small
      displacements, every rigid motion is a translation plus a small rotation:</p>
    ${equation("\\mathbf{u}(\\mathbf{x}) = \\mathbf{a} + \\mathbf{θ} × \\mathbf{x}.", "Rigid displacement equals a translation vector a plus the cross product of a small rotation vector theta with the position x")}
    <p>The translation ${tex("\\mathbf{a}")} (mm) and rotation ${tex("\\mathbf{θ}")} (rad) have three components
      each: six rigid-body modes in 3D. The strain of every such field is zero,
      so ${tex("\\mathbf{K}\\mathbf{d}_{\\mathrm{rigid}} = \\mathbf{0}")}. In the bar, ${tex("\\mathbf{d} = (1, 1, 1)")}
      is a rigid translation, and each row of ${tex("\\mathbf{K}")} sums to zero. A rigid mode
      costs no energy, so nothing in ${tex("\\mathbf{K}")} resists it. Only constraints can.</p>
    <p>Every body that is not connected to another must be held against all six
      modes. A <strong>3-2-1 support</strong> does exactly this with six
      components at three points: A fixes Ux, Uy and Uz; B, along ${tex("x")} from A,
      fixes Uy and Uz; C, offset from that line in ${tex("y")}, fixes Uz.</p>
    <figure class="model-sketch">
      <svg role="img" aria-labelledby="support-title" aria-describedby="support-description" viewBox="0 0 600 220">
        <title id="support-title">3-2-1 support on a block</title>
        <desc id="support-description">A block along x pulled by equal and opposite forces at its two ends. Point A at the near bottom-left corner fixes three components, point B at the near bottom-right corner fixes two, and point C at the hidden far bottom-left corner, offset from A in y, fixes one.</desc>
        <defs><marker id="support-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="currentColor" /></marker></defs>
        <path d="M150 80H450V150H150Z M150 80 190 45H490L450 80Z M450 80 490 45V115L450 150Z" fill="var(--panel2)" stroke="currentColor" stroke-linejoin="round" />
        <path d="M150 150 190 115H490 M190 115V45" fill="none" stroke="currentColor" stroke-dasharray="5 4" opacity="0.6" />
        <path d="M150 98H60 M470 98H560" stroke="currentColor" stroke-width="2" marker-end="url(#support-arrow)" />
        <circle cx="150" cy="150" r="6" fill="currentColor" />
        <circle cx="450" cy="150" r="6" fill="currentColor" />
        <circle cx="190" cy="115" r="6" fill="currentColor" />
        <text x="105" y="180" fill="currentColor">A: Ux Uy Uz</text>
        <text x="415" y="180" fill="currentColor">B: Uy Uz</text>
        <text x="202" y="138" fill="currentColor">C: Uz</text>
        <text x="62" y="88" fill="currentColor">−P</text>
        <text x="545" y="88" fill="currentColor">P</text>
        <text x="300" y="194" fill="currentColor">x →</text>
      </svg>
      <figcaption>A 3-2-1 support removes the six rigid-body modes and no more.
        Under balanced loads, it produces no reactions.</figcaption>
    </figure>
    <p>For a balanced load, such as equal and opposite forces on two faces, a
      3-2-1 support carries no reaction and does not disturb the stress. In
      KoFEM, the 1000 mm bar pulled by ${tex("±10^6\\text{ N}")} on its end faces and held this way
      stretches by 0.476190 mm, matching ${tex("PL/(EA) = 0.476190\\text{ mm}")}, with 100.0 MPa in every
      element.</p>

    <h2 id="insufficient">Too few constraints</h2>
    <p>If any rigid mode remains, ${tex("\\mathbf{K}_{\\mathrm{FF}}")} is singular and the
      equations have no unique solution. Two outcomes are possible, and both
      occur in KoFEM. Take the bar with only Ux fixed on its root face: Uy, Uz and
      the rotation about ${tex("x")} are still free.</p>
    <ul>
      <li><strong>The load excites a free mode.</strong> A transverse force of
        1000 N in ${tex("y")} has nothing to react against. The iterative solver
        cannot converge, and the solve stops with “CG solver did not converge”
        after 5000 iterations.</li>
      <li><strong>The load is orthogonal to every free mode.</strong> The axial force
        does no work in the free modes, so the solver converges. Elongation and
        stress are correct, but the displacement contains an arbitrary rigid
        part. Here the largest Uy was 0.0097 mm, against 0.0143 mm with a
        proper 3-2-1 support; that difference is a rigid shift, not deformation.</li>
    </ul>
    <p>The second case is the more dangerous one, because it looks like a
      success. KoFEM requires at least one support before it solves, but does
      not check that all six modes are removed. Common causes are:</p>
    <ul>
      <li>a single roller or symmetry plane with nothing holding the in-plane
        directions;</li>
      <li>point supports on one straight line, which leave the rotation about
        that line free; and</li>
      <li>an assembly whose bodies touch but share no nodes and are not joined
        by a tie: each loose body has its own six modes.</li>
    </ul>

    <h2 id="overconstraint">Too many constraints</h2>
    <p>More constraints than the six needed are normal: a fixed face constrains
      hundreds of DOFs. The danger is constraining motions the real support
      allows. Each extra constraint can only make the model stiffer.</p>
    <p><strong>Fixed instead of sliding.</strong> A fully fixed face stops the
      Poisson contraction that a real end plate might allow. Pull a 100 mm long
      bar of the same section with ${tex("10^6\\text{ N}")}. With a sliding root face (Ux
      only, plus a 3-2-1 point set), KoFEM reproduces ${tex("PL/(EA) = 0.04762\\text{ mm}")} and a
      uniform 100 MPa. With the face fully fixed, the mean extension is about
      3% smaller (0.0457, 0.0460 and 0.0461 mm on 4³, 8³ and 16³ hexahedral
      meshes). The peak von Mises stress at the edge of the fixed face rises
      from 102.7 to 127.3 MPa over the same refinements. That peak is a
      singularity: it grows with refinement and has no converged value. For the
      1000 mm bar the stiffening is only 0.5%: the effect is local to the
      support.</p>
    <p><strong>Point supports that carry load.</strong> A constraint at one node
      concentrates its reaction there. Hold the 1000 mm bar by the 3-2-1 points
      alone and pull only one end: corner A now reacts the whole
      ${tex("10^6\\text{ N}")}. The solve succeeds, but the element at A reaches 1741 MPa
      von Mises, and the off-centre reaction bends the bar: mid-span stresses
      range from 32 to 294 MPa instead of a uniform 100 MPa. Use point supports
      to remove rigid modes, not to carry load.</p>
    <p><strong>Prescribing more components than intended.</strong> A
      prescribed value applies to every checked component. To pull a face in
      ${tex("x")} without also holding it in ${tex("y")} and ${tex("z")}, check only Ux.</p>

    <h2 id="conflicts">Conflicting constraints and unmatched selections</h2>
    <p>A DOF can be named by several groups, for example the nodes on the edge
      shared by two selected faces. At the reviewed revision, the solid solve
      handles overlaps and stale selections as follows:</p>
    <ul>
      <li><strong>Same DOF, same value in two groups:</strong> accepted and
        merged into one constraint.</li>
      <li><strong>Same DOF, two different values</strong> (fixed by one group
        and prescribed by another, or prescribed twice): the solve stops with an
        error naming the vertex and component.</li>
      <li><strong>Two loads on the same face:</strong> both are integrated and
        add up.</li>
      <li><strong>Some selected faces are not on the boundary:</strong> the log
        warns with their count, and they add no load. A force total is spread
        over the matched area; a pressure loses that area.</li>
      <li><strong>No selected face is on the boundary:</strong> the solve stops
        with an error.</li>
      <li><strong>Order-2 elements:</strong> an edge’s midside DOF is
        constrained when both of its end nodes are, to their average value.
        Edges leaving a support stay free.</li>
    </ul>
    <p>A conflict has to be resolved by the user: remove the shared nodes from
      one group, or give both groups the same value. On order-2 hexahedra,
      which the app’s mesher does not produce, the centre node of a supported
      face is not constrained.</p>

    <h2 id="diagnosis">What to check when a result looks wrong</h2>
    <p><strong>Singular: no convergence, or huge or arbitrary displacements.</strong></p>
    <ul>
      <li>For each separate body, list which of the three translations and three
        rotations its supports stop. Every one must be stopped.</li>
      <li>Check per-component supports: a roller stops only one direction.</li>
      <li>Check that point supports are not on one line.</li>
      <li>Check that touching bodies are connected by shared nodes or a tie.</li>
      <li>Compare the displacement pattern with a rigid motion. A body that
        translates or turns without straining has a free mode.</li>
    </ul>
    <p><strong>Unexpectedly stiff: too little displacement.</strong></p>
    <ul>
      <li>Ask whether each fixed face is really fixed in all three directions,
        or should slide. Try a sliding support and compare.</li>
      <li>Check that no load is applied to a constrained face or node, where it
        has no effect.</li>
      <li>Check force versus pressure: a force is a total in N, a pressure is
        per area in MPa. 1 MPa on 100 mm² is 100 N.</li>
      <li>Check prescribed groups for extra components.</li>
      <li>Check units: a modulus entered in Pa with lengths in mm is a million
        times too stiff. See <a href="/theory/foundations/consistent-units/">Consistent unit systems</a>.</li>
      <li>Thin walls of linear tetrahedra lock in bending; see
        <a href="/theory/numerical-methods/elements-and-quadrature/#thin-walls">Elements and quadrature</a>.</li>
    </ul>
    <p>Peak stresses at the edge of a support or under a point load are usually
      singular. Judge the result away from them. How the linear solver reports
      failure is covered in <a href="/theory/numerical-methods/linear-solve/">Linear solve</a>.</p>

    <h2 id="implementation">KoFEM implementation and evidence</h2>
    <p>Reviewed on 2 November 2026 at
      <a href="https://github.com/mkofler96/KoFEM/tree/${revision}"><code>${revision.slice(0, 7)}</code></a>,
      against MFEM 4.7. The solid solve is
      ${source("engine/cpp/solve_mfem.cpp", 182, "solve_linear_elastic")}.</p>
    <ul>
      <li><strong>Groups to payload.</strong> Each node of a support group gets
        the group’s value per checked component
        (${source("web/src/store/boundaryRebuild.ts", 47, "boundaryRebuild.ts")}). The solid path sorts
        zero values into fully fixed vertices or single components and non-zero
        values into prescribed DOFs, ignoring rotations
        (${source("web/src/lib/solveMeshPacking.ts", 139, "solveMeshPacking.ts")}).
        Solve requires a support and a load or a non-zero prescribed value
        (${source("web/src/hooks/useSolver.ts", 58, "useSolver.ts")}).</li>
      <li><strong>Constraint collection.</strong> Fixed, per-component and
        prescribed DOFs are collected, extended to order-2 edge DOFs, and
        checked for conflicts
        (${source("engine/cpp/fem_bc_io.cpp", 76, "set_dirichlet")},
        ${source("engine/cpp/fem_bc_io.cpp", 177, "edge extension")},
        ${source("engine/cpp/bc_validation.h", 41, "conflict check")}).</li>
      <li><strong>Elimination.</strong> Prescribed values are written into the
        solution vector before
        ${source("engine/cpp/solve_mfem.cpp", 297, "FormLinearSystem")}; MFEM keeps the diagonal
        (${mfemSource("fem/bilinearform.cpp", 78, "default policy")}) and moves the known values to the
        right-hand side
        (${mfemSource("fem/bilinearform.cpp", 1103, "EliminateVDofsInRHS")}).</li>
      <li><strong>Surface loads.</strong> One surface load per force or pressure
        group (${source("web/src/store/boundaryRebuild.ts", 238, "rebuildSurfaceLoads")});
        the engine matches faces to boundary elements, warns or stops on
        unmatched faces, divides a force by the matched area and integrates
        the traction
        (${source("engine/cpp/fem_bc_io.cpp", 340, "apply_surface_loads")},
        ${source("engine/cpp/fem_bc_io.cpp", 266, "traction coefficient")}).</li>
      <li><strong>Point loads and moments.</strong> Point picks share the group total; moments become nodal
        forces per face
        (${source("web/src/store/boundaryRebuild.ts", 161, "rebuildLoads")},
        ${source("web/src/store/momentLoad.ts", 20, "momentLoad.ts")}); nodal forces are added to
        ${tex("\\mathbf{f}")} after assembly
        (${source("engine/cpp/fem_bc_io.cpp", 425, "apply_point_loads")}).</li>
    </ul>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Validation evidence for loads and constraints; scroll horizontally if needed">
      <table>
        <caption>Evidence that runs the real engine</caption>
        <thead><tr><th scope="col">Claim</th><th scope="col">Evidence</th></tr></thead>
        <tbody>
          <tr><th scope="row">Fixed face and face force</th><td><a href="/examples/axial-bar/">Axial bar</a> against ${tex("PL/(EA)")}</td></tr>
          <tr><th scope="row">Pressure sign and per-area scaling</th><td><a href="/examples/surface-pressure/">Bar under end pressure</a></td></tr>
          <tr><th scope="row">Per-component supports</th><td><code>examples/validation/dof-constraint.test.mjs</code></td></tr>
          <tr><th scope="row">Non-zero prescribed displacement</th><td><code>examples/validation/prescribed-displacement.test.mjs</code></td></tr>
          <tr><th scope="row">Overlapping loads; supports without a load</th><td><code>examples/validation/multiple-loads.test.mjs</code></td></tr>
          <tr><th scope="row">Conflicts and invalid indices</th><td><code>web/tests/test_bc_validation.mjs</code>, <code>scripts/test-bc-validation.sh</code></td></tr>
        </tbody>
      </table>
    </div>
    <p>The tests run in CI with <code>cd web &amp;&amp; bun run test:validation</code>.
      The 3-2-1, sliding-support, under-constrained and point-support results on
      this page were computed with the same engine build for this review; they
      are not part of the test suite. Historical issues: prescribed values
      were once silently pinned to zero (KOF-210), overlapping loads dropped
      (KOF-216), unmatched faces dropped without a count (KOF-220) and
      conflicting constraints resolved silently (KOF-218). All are fixed at the
      reviewed revision.</p>

    <h2 id="references">Sources and further reading</h2>
    <ol class="refs">
      <li><a href="https://mfem.org/fem/">MFEM: Finite element methods</a>,
        essential boundary conditions and linear forms.</li>
      <li>Hughes, <cite>The Finite Element Method: Linear Static and Dynamic
        Finite Element Analysis</cite> (2000), essential and natural boundary
        conditions, and prescribed displacements in the load vector.</li>
      <li>Cook, Malkus, Plesha and Witt, <cite>Concepts and Applications of
        Finite Element Analysis</cite> (2002), consistent nodal loads, rigid-body
        modes and support modelling.</li>
    </ol>
    <p>The worked bar and face-load numbers were checked by hand with exact
      arithmetic. Related pages:
      <a href="/theory/notation/#boundary">boundary notation</a>,
      <a href="/theory/solid-mechanics/equilibrium-and-weak-form/">Equilibrium and weak form</a>
      and the <a href="/examples/axial-bar/">axial bar example</a>.</p>`,
};
