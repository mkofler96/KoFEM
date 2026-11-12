// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tex } from "../operators/math.mjs";
import { figure } from "../figures/index.mjs";

export default {
  slug: "verification/strategy",
  description:
    "Distinguish FEM verification from physical validation, choose benchmarks that test the claimed quantity, and keep a reproducible record of every check.",
  sections: [
    [
      "verification-validation",
      "Verification and validation answer different questions",
    ],
    ["coverage", "Choose evidence for the claim"],
    ["record", "Keep a reproducible record"],
    ["references", "Further reading"],
  ],
  body: `
    <p class="lede">What does each benchmark establish, and what remains unverified?</p>
    <p>A passing benchmark supports a stated claim under stated conditions.
      Begin with the <a href="/theory/verification/axial-bar/">verified bar</a>,
      then choose additional evidence for the question your model asks.</p>

    <h2 id="verification-validation">Verification and validation answer different questions</h2>
    <p><strong>Verification</strong> asks whether the equations are implemented
      and solved correctly. An analytical solution can test loads, stiffness,
      boundary conditions and recovery. Mesh studies probe discretization
      sensitivity; the algebraic residual concerns only one discrete system.</p>
    ${figure("verification-validation", "Verification checks that the equations of the mathematical model are solved correctly. Validation checks that the model represents the physical system well enough for its purpose.")}
    <p><strong>Validation</strong> asks whether those equations and assumptions
      describe the real system well enough for the intended use. It requires
      comparison with physical observations, including uncertainty in geometry,
      materials, supports, loads and measurement. Agreement with another code
      or a textbook formula alone supplies no experimental validation.</p>
    <p>KoFEM’s <a href="/examples/">examples</a> compare results with
      analytical and published numerical solutions. In this distinction they
      are verification evidence, not physical validation.</p>

    <h2 id="coverage">Choose evidence for the claim</h2>
    <ul>
      <li><a href="/examples/axial-bar/">Axial bar</a>: extension and load transfer.
        The <a href="/theory/verification/axial-bar/#comparison">additional study</a>
        checks middle-region von Mises against ${tex("P/A")}. This simple
        uniaxial state does not exercise general multiaxial recovery.</li>
      <li><a href="/examples/surface-pressure/">End pressure</a>: compression and
        pressure direction. Von Mises alone cannot verify the sign; inspect
        the signed displacement as well.</li>
      <li><a href="/examples/cantilever-beam/">Cantilever</a>: bending displacement
        and existing order/refinement data. Euler–Bernoulli neglects shear;
        a fine 3D solution need not approach that reference exactly.</li>
      <li><a href="/examples/plate-with-hole/">Plate with a hole</a>: a finite
        stress concentration. Match sampling location and finite geometry to
        the assumptions of the infinite-plate reference.</li>
      <li><a href="/examples/cooks-membrane/">Cook’s membrane</a>: bending and
        shear on skewed elements, without a closed form. Check that the
        reference belongs to the point you measure: the published value is the
        deflection at the middle of the loaded edge, not at the top corner.</li>
      <li><a href="/theory/shells/formulation/#plate-example">Square shell plate</a>:
        centre deflection and a centre-near surface stress against thin-plate
        theory. The <a href="/theory/shells/solid-coupling/#verification">planar
        transition study</a> separately compares a retained solid root with a
        same-mesh all-solid model. Neither establishes arbitrary junction-stress accuracy.</li>
      <li><a href="/theory/optimization/constraints-and-convergence/#benchmarks">MBB beam and cantilever optimizations</a>:
        published truss layout and agreement across one factor-2 refinement
        with a fixed filter radius. Neither establishes physical adequacy of
        an optimized part.</li>
    </ul>
    <p>These links reuse the existing studies; they do not claim new runs of
      those refinement sequences. See each example’s engine record. Claims
      beyond these cases about shells, coupling, optimization, singular stresses or physical
      strength need suitable evidence of their own.</p>

    <h2 id="record">Keep a reproducible record</h2>
    <p>Record geometry, coherent units, material law and constants, every
      support and load distribution, element family/order and local resolution,
      solver settings, reference assumptions, measured quantity and location,
      recovery/averaging, tolerances and their reasons. Preserve full-precision
      values and the KoFEM version that produced them.
      The <a href="/theory/axial-bar.json">bar’s machine-readable record</a>
      shows this for an executed comparison.</p>
    <p>Report discrepancies and excluded claims with the numbers. A small
      residual is not a mesh error estimate. Similar results on two coarse
      meshes can miss the same physics. Use the
      <a href="/theory/results/interpretation-and-convergence/#comparison">comparison checklist</a>
      to keep locations, units and recovery measures consistent.</p>

    <h2 id="references">Further reading</h2>
    <ul class="refs"><li>ASME V&amp;V 10-2019, <cite>Standard for Verification and Validation in Computational Solid Mechanics</cite>.</li>
      <li>Oberkampf and Roy, <cite>Verification and Validation in Scientific Computing</cite> (2010).</li>
      <li>Szabó and Babuška, <cite>Finite Element Analysis</cite> (1991), discretization error and convergence.</li></ul>`,
};
