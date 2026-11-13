// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { equation, tex } from "../operators/math.mjs";
import { evidence, number, percentError, source, table } from "./evidence.mjs";
import { figure } from "../figures/index.mjs";

const comparisons = evidence.transition.filter((row) => row.collar_mm === 6);
const referenceFor = (row) =>
  evidence.transition.find(
    (candidate) =>
      candidate.load === row.load &&
      candidate.refinement === row.refinement &&
      candidate.collar_mm === -1,
  );

export default {
  slug: "shells/solid-coupling",
  description:
    "Explain bonded ties and shell–solid load transfer in KoFEM: physical section footprints, retained solid transitions, RBE2 and RBE3 assumptions, reproducible comparisons and junction-stress limits.",
  sections: [
    ["load-path", "Choose the connection’s physical meaning"],
    ["reduction", "Motion constraints also transfer loads"],
    ["transition", "Retain solid material at the joint"],
    ["other-couplings", "Distinguish the other coupling methods"],
    ["inputs", "Materials, loads and constraints"],
    ["verification", "Check the planar wall-on-block case"],
    ["limits", "What this evidence establishes"],
    ["references", "Implementation and references"],
  ],
  body: `
    <p class="lede">How are shell and solid degrees of freedom coupled?</p>
    <p>A shell carries translations and rotations at its mid-surface; a solid
      carries translations throughout a volume. Joining their nodes by position
      alone does not specify how a bending moment crosses the interface.
      The connection needs a motion rule whose work-equivalent forces carry
      the intended load path.</p>

    <h2 id="load-path">Choose the connection’s physical meaning</h2>
    <p>A <strong>bonded tie</strong> idealises a permanent connection. It does
      not model contact opening, sliding, friction or the compliance of a weld
      or adhesive layer. In the all-solid solve, KoFEM merges selected node
      pairs into representative translational nodes. In the coupled assembler,
      user-declared surface ties instead create distributing constraints across
      the selected surfaces. The same UI intent therefore uses different
      discrete approximations on those paths; compare the affected response.</p>
    <p>A <strong>shell–solid transition</strong> replaces part of one continuous
      wall with a shell. Its section should transmit extension, shear and bending
      without replacing a three-dimensional joint by an averaged remote point.
      Keep local solid material where the joint response matters and move the
      idealised section away from that region.</p>
    <p>A <strong>surface-to-point coupling</strong> models a remote load,
      attachment or rigid connection. Choose kinematic when a rigid gripped
      patch is intended, distributing when a patch should retain deformation.
      Neither choice supplies the detailed stresses of a real bolt, weld or bearing.</p>

    <h2 id="reduction">Motion constraints also transfer loads</h2>
    <p>The coupled solve uses six slots per pool node. Solid stiffness occupies
      the three translational slots; shell stiffness occupies the shell node’s
      translations and rotations. Unused rotations on solid-only nodes are
      fixed, except at a coupling reference that needs them. The app assembles
      the linear tetrahedral solid stiffness and the
      <a href="/theory/shells/formulation/#stiffness">CST/DKT shells</a> in its
      Rust solver module and solves the reduced system there; the C++ engine’s
      MFEM coupled assembler solves the same model and is kept as the reference
      the Rust solve is checked against.</p>
    <p>A constraint expresses dependent coefficients as linear combinations of
      independent coefficients. Write the full vector as
      ${tex("\\mathbf{d}=\\mathbf{T}\\mathbf{q}")}, where ${tex("\\mathbf{q}")}
      contains independent unknowns and ${tex("\\mathbf{T}")} is the constraint
      map. Substituting it into virtual work gives:</p>
    ${equation("\\mathbf{K}_r=\\mathbf{T}^T\\mathbf{K}\\mathbf{T},\\quad \\mathbf{f}_r=\\mathbf{T}^T\\mathbf{f},\\quad \\mathbf{K}_r\\mathbf{q}=\\mathbf{f}_r.", "Reduced stiffness and force use the same constraint transformation; the transpose transfers loads consistently with constrained motion")}
    <p>The <a href="/theory/notation/#transpose">transpose</a> is essential:
      the same motion map determines force and moment transfer. Work consistency
      alone does not prove a particular map reproduces every rigid motion,
      local stress field or reference-point eccentricity. Test those claims
      separately. KoFEM resolves chains to independent coefficients and rejects
      cycles and conflicting constraint ownership before the solve.</p>

    <h2 id="transition">Retain solid material at the joint</h2>
    <p>At detected planar wall roots, the CAD idealisation retains a solid wall
      section extending three wall thicknesses from the joint. It clips the
      solid tetrahedra and shell facets at the transition plane, so the shell
      begins at a physical through-thickness solid section. This preserves
      three-dimensional material around the joint and counts the replaced wall
      volume once. The placement is a current algorithmic choice, not a theorem
      that three thicknesses suffice for every geometry.</p>
    ${figure("solid-shell-transition", "Cross section, not to scale. The wall stays solid for three thicknesses above the block; above the cut it is a shell mid-surface. Rigid links make the solid section nodes S follow the shell edge node A: its translation plus its rotation crossed with the offset r.")}
    <p>The <strong>physical-footprint</strong> constraint (engine kind 3)
      makes each solid section node dependent on the two shell edge nodes.
      Let ${tex("N_1=1-s")} and ${tex("N_2=s")} be the linear edge weights
      at projected coordinate ${tex("0≤s≤1")}. Let ${tex("x_a")},
      ${tex("u_a")} and ${tex("θ_a")} be shell node positions, translations
      and rotations; ${tex("x_S")} is the solid node position. Then:</p>
    ${equation("x_A=N_1x_1+N_2x_2,\\quad r=x_S-x_A,\\quad u_S=\\sum_{a=1}^{2}N_a(u_a+θ_a×r).", "A solid section node follows interpolated shell-edge translation plus rotation crossed with its offset from the interpolated mid-surface point")}
    <p>This is the shell’s section kinematics applied across its physical
      thickness. The weights sum to one and reproduce the edge anchor, so a
      common rigid translation and rotation gives the same motion on both sides.
      The transpose distributes forces and moments to the shell edge. The solid
      section cannot warp independently at this cut; place it where the shell
      assumption is appropriate.</p>
    <p>The detector requires a section spanning both wall faces, with solid
      boundary nodes within half the wall thickness of the shell mid-surface.
      It interpolates nonmatching node positions along the shell edge.
      Nearby search-ball seam constraints are excluded where this footprint is
      active. Other seams can still use the older proximity-based method;
      this is not an arbitrary surface-to-surface transition implementation.</p>

    <h2 id="other-couplings">Distinguish the other coupling methods</h2>
    ${table(
      "Coupling kinematics in KoFEM",
      ["Method", "Dependent motion", "Consequence"],
      [
        [
          "Physical footprint (kind 3)",
          "Solid section translations follow two interpolated shell-edge nodes and their rotations.",
          "Transfers the shell section kinematics over its thickness; suppresses warping at the cut. Used for recognized section footprints.",
        ],
        [
          "Relaxed seam MPC (kind 1)",
          "All six shell reference coefficients follow a distance-weighted solid-patch centroid translation and a scaled least-squares patch rotation.",
          "Localizes the older seam tie. It is not a rigid section footprint and does not tie to an arbitrary nearest face node.",
        ],
        [
          "Distributing, RBE3 style (kind 0)",
          "Reference translation is a weighted average of patch translations; reference rotation is computed from relative patch motion by the implemented least-squares map.",
          "Allows patch deformation; the dependent reference can be loaded, but cannot be directly fixed or driven. Automatic partner sets use equal weights. Patch geometry, reach and eccentricity affect behavior.",
        ],
        [
          "Kinematic, RBE2 style (kind 2)",
          "Selected target translations follow reference translation plus reference rotation crossed with their offsets.",
          "The independent reference can be fixed, driven or loaded. It makes the selected patch rigid. Rotation-mask bits only tie rotations where those DOFs exist.",
        ],
      ],
    )}
    <p>For the relaxed seam MPC, base weights are multiplied by
      ${tex("1/(d_i^2+ε^2)")}, with ${tex("d_i")} the partner distance from
      the shell reference and ${tex("ε=0.05r_{\\mathrm{max}}")}. Translation follows
      the resulting weighted centroid; rotation follows the weighted fit times
      relaxation ${tex("ψ")}. The app currently sets ${tex("ψ=1")}; it is
      not a user control. Averaging an equidistant pair on opposite wall faces
      avoids arbitrarily attaching the mid-surface to one face. This differs
      from both the physical footprint and generic equal-weight distributing coupling.</p>
    <p>A kinematic target translation uses the same rigid-body rule
      ${tex("u_i=u_R+θ_R×(x_i-x_R)")}. Leaving target rotation bits free
      on a solid surface does not create a hinge: solid nodes have no physical
      nodal rotations, and their translational patch still follows the rigid
      reference. A point-to-point constraint with free rotations is a different
      idealisation.</p>
    <p class="note">The historical distributing-junction study found reasonable
      tip motion alongside severely low local solid stress. The current planar
      transition addresses that model with retained solid material and a section
      footprint. It does not establish a general repair to arbitrary distributing
      patches.</p>

    <h2 id="inputs">Materials, loads and constraints</h2>
    <ul>
      <li><strong>Elements and materials:</strong> the explicit mixed path accepts
        CTRIA3 shells and CTETRA solids. Other solid element types are rejected.
        Solid tetrahedra support distinct per-body materials through per-tet
        attributes. The shell domain still requires one material ID, with
        per-facet thickness. The legacy solve-time CAD idealisation requires
        one material per domain; it does not share that per-tet capability.</li>
      <li><strong>Loads:</strong> face force, traction and pressure become
        <a href="/theory/shells/formulation/#supported-models">nodal forces</a>.
        App moment groups normally become force couples. The coupled packer
        passes direct moment components at declared reference points; it does
        not pass arbitrary direct moments at ordinary nodes. Confirm the load
        selection still describes the intended surface after idealisation.</li>
      <li><strong>Supports:</strong> the coupled/idealised app path clamps shell
        rotations when all three translations are fixed to zero. A prescribed
        translation does not automatically clamp rotation. Direct driven rotations
        require a declared reference point on this path. Pure-shell payloads
        have the separate six-component support described in the shell article.</li>
      <li><strong>Dependent nodes:</strong> the core rejects fixed or prescribed
        dependent coefficients. The app drops proximity seam ties at constrained
        shell nodes, but refuses a prescribed/fixed footprint solid node and a
        tie overlapping that transition. Resolve the competing load paths or
        retain the body as Solid.</li>
      <li><strong>Connectivity:</strong> separate bodies require shared nodes
        or a declared connection; proximity alone does not bond an assembly.
        A declared tie that neither couples nor shares any nodes produces an
        error. An all-shell model cannot use a declared surface-to-point
        coupling today; that assembler needs a solid domain.</li>
    </ul>
    <p>The result contains shared-pool translations and separate solid and shell
      element von Mises arrays. Shell values come from the worse surface at
      each facet centroid; solid values sample the tetrahedron centre. They
      describe different stress states and sampling locations. Avoid treating
      a colour discontinuity across the transition as a stress continuity test.</p>

    <h2 id="verification">Check the planar wall-on-block case</h2>
    <p>The existing native study uses a 60 × 40 × 6 mm block with a centred
      60 mm long, 30 mm high, 2 mm thick wall. The block bottom is fixed in
      all translations. All material has ${tex("E=210000\\text{ MPa}")} and
      ${tex("ν=0.3")}. A total ${tex("P=100\\text{ N}")} acts along the wall
      top, either upward (tension) or along its length (in-plane bending).
      It compares an all-solid wall with shell transitions at 0, 3 and 6 mm
      above the block; 6 mm equals three wall thicknesses.</p>
    <p>For refinement index ${tex("r")} the block has ${tex("12r")} cells
      along its length, ${tex("9r")} across its nonuniform width and
      ${tex("3r")} through block depth. The wall has ${tex("r")} divisions
      through thickness and ${tex("10r")} over its height. Cells become
      linear tetrahedra; the remaining shell is triangulated. The study refines
      all directions together. The record here executes ${tex("r=1,2")},
      with CG relative target ${tex("10^{-10}")}.</p>
    <p>The table compares the 6 mm retained section against the all-solid model
      <em>at the same refinement</em>. Work-conjugate top displacement is
      ${tex("δ=\\sum_i f_i u_i/P")}. Stress is unsmoothed centre von Mises.
      The “near” measure is a volume-weighted mean over the fixed box
      ${tex("x∈[0,60],y∈[19,21],z∈[4,6]\\text{ mm}")}; the gauge uses
      ${tex("z∈[2,4]\\text{ mm}")}. Both boxes have volume 240 mm³.</p>
    ${table(
      "Executed 6 mm transition versus same-mesh all-solid reference",
      [
        "Load / refinement",
        "Top displacement (mm)",
        "All-solid (mm)",
        "Displacement error",
        "Near mean stress error",
        "Block stress field error",
      ],
      comparisons.map((row) => {
        const reference = referenceFor(row);
        if (!reference)
          throw new Error("Missing all-solid transition reference");
        return [
          `${row.load === "tension" ? "Tension" : "In-plane bending"}, r = ${row.refinement}`,
          number(row.work_tip_u),
          number(reference.work_tip_u),
          `${percentError(row.work_tip_u, reference.work_tip_u)}%`,
          `${percentError(row.near_vm, reference.near_vm)}%`,
          `${number(100 * row.block_vm_l2_error, 3)}%`,
        ];
      }),
    )}
    <p>The inherited gates for the 6 mm section are 2% displacement, 1% in each
      fixed stress box, 3% volume-weighted relative block-field error and 3%
      top-layer peak agreement with the same-mesh solid. Force imbalance is
      normalized by ${tex("P")}; moment imbalance by
      ${tex("P(60+40+6+30)\\text{ mm}")}. Both must be below
      ${tex("10^{-6}")}. The
      <a href="/theory/shells.json">full record</a> retains all four placements,
      peaks, gauge means and balance errors, rather than only the favorable rows.</p>
    <p>The numerical table comes from the native production-core study with
      a conforming planar footprint. Its separate asymmetric-patch checks concern
      kinematic coupling rigid motions and six force/moment loads. The shell
      suite also checks footprint rigid/affine motion and clamped-cantilever
      moment transfer. The app fixture separately checks clipping, volume,
      nonmatching edge interpolation and WASM solve behavior. These checks
      exercise different layers; passing one does not substitute for the others.</p>

    <h2 id="limits">What this evidence establishes</h2>
    <p>The retained planar section reproduces the tested global motion and
      fixed-region solid stresses closely relative to the same-mesh all-solid
      model. This is a comparison between two discrete models, not an analytical
      stress solution or physical validation. The all-solid reference itself
      changes under refinement. Its sharp T-junction peak is mesh-dependent;
      peak agreement between the two models does not establish a converged
      physical peak.</p>
    <p>The study covers planar section cuts and in-plane loading. It does not
      establish arbitrary three-dimensional junction stresses, curved cuts,
      general distributing coupling, out-of-plane joint response, or accurate
      extraction of every branched thin-walled section. The
      <a href="/theory/shells/formulation/#supported-models">wall-extraction limits</a>
      are separate from retaining a solid root in a successfully detected wall.</p>
    <p>Choose a quantity and fixed sampling region before comparing models.
      Check reactions, motion, stress away from the artificial cut and sensitivity
      to both mesh and transition placement. Keep the region solid when those
      checks do not support the shell idealisation. See
      <a href="/theory/verification/strategy/">verification strategy</a> and
      <a href="/theory/results/interpretation-and-convergence/">result interpretation</a>.</p>

    <h2 id="references">Implementation and references</h2>
    <ol class="refs">
      <li>${source("crates/kofem-shellize/src/transition.rs", 79, "three-thickness retained section")},
        ${source("crates/kofem-shellize/src/footprint.rs", 185, "physical footprint detection")},
        ${source("engine/cpp/coupling_constraints.cpp", 43, "footprint equations")},
        ${source("engine/cpp/shell_core.cpp", 92, "constraint reduction")} and
        ${source("engine/cpp/solve_coupled.cpp", 1, "MFEM/WASM coupled assembler")},
        the C++ reference for the Rust mixed solve the app runs: the reduction
        in <code>crates/kofem-fem/src/coupled_static.rs</code>, the coupling
        equations in <code>crates/kofem-fem/src/coupling.rs</code> and the browser
        binding in <code>crates/kofem-wasm/src/mixed.rs</code>, compared against
        it by <code>web/tests/integration/coupled-rust.test.mjs</code>. The linked sources
        are pinned to the revision of this page’s evidence, which predates the
        Rust mixed solve.</li>
      <li>${source("engine/cpp/coupling_constraints.cpp", 149, "relaxed seam MPC and distributing equations")},
        ${source("crates/kofem-shellize/src/ties.rs", 153, "coupled surface ties")},
        ${source("web/src/lib/solve/solid.ts", 101, "solid tie welding")},
        ${source("web/src/lib/solve/coupled.ts", 39, "app relaxation setting")},
        ${source("web/src/lib/coupledMaterials.ts", 75, "mixed-model materials")},
        ${source("web/src/lib/solve/bcs.ts", 114, "coupled support rules")} and
        ${source("web/src/lib/solveLoads.ts", 156, "coupled loads")}.</li>
      <li>${source("engine/tests/shell_solid_footprint_study.cpp", 1, "planar transition study and its limits")},
        ${source("engine/tests/shell_validation.cpp", 555, "footprint motion checks")} and
        ${source("web/tests/integration/shell-footprint.test.mjs", 1, "app-pipeline and WASM fixture")}.</li>
      <li>Lu, Zhang and Yang (2023), <cite>A Relaxed MPC Method for Non-rigid Shell to Solid Coupling</cite>, Journal of Physics: Conference Series 2528, 012064. KoFEM’s centroid-weighted nonconforming seam is an implementation adaptation; it is not the paper’s coincident-node construction.</li>
    </ol>`,
};
