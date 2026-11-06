// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tex } from "../operators/math.mjs";
import { source } from "./evidence.mjs";

export default {
  slug: "verification/strategy",
  description:
    "Distinguish FEM verification from physical validation, choose benchmarks that test the claimed quantity, and maintain theory pages, executable evidence and source revisions together.",
  sections: [
    [
      "verification-validation",
      "Verification and validation answer different questions",
    ],
    ["coverage", "Choose evidence for the claim"],
    ["record", "Keep a reproducible record"],
    ["maintenance", "Update the explanation with the behavior"],
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
    <p><strong>Validation</strong> asks whether those equations and assumptions
      describe the real system well enough for the intended use. It requires
      comparison with physical observations, including uncertainty in geometry,
      materials, supports, loads and measurement. Agreement with another code
      or a textbook formula alone supplies no experimental validation.</p>
    <p>The repository calls its executable benchmark infrastructure the
      “validation suite.” Its analytical and published numerical comparisons
      primarily provide verification and regression evidence in this distinction.</p>

    <h2 id="coverage">Choose evidence for the claim</h2>
    <ul>
      <li><a href="/examples/axial-bar/">Axial bar</a>: extension and load transfer.
        The <a href="/theory/verification/axial-bar/#comparison">additional study</a>
        checks middle-region von Mises against ${tex("P/A")}. This simple
        uniaxial state does not exercise general multiaxial recovery.</li>
      <li><a href="/examples/surface-pressure/">End pressure</a>: compression and
        pressure direction. Von Mises alone cannot verify the sign; inspect
        the signed displacement as well.</li>
      <li><a href="/examples/cantilever/">Cantilever</a>: bending displacement
        and existing order/refinement data. Euler–Bernoulli neglects shear;
        a fine 3D solution need not approach that reference exactly.</li>
      <li><a href="/examples/plate-with-hole/">Plate with a hole</a>: a finite
        stress concentration. Match sampling location and finite geometry to
        the assumptions of the infinite-plate reference.</li>
      <li><a href="/examples/cooks-membrane/">Cook’s membrane</a>: a caution
        about agreement on one mesh. Its existing study crosses the reference
        under refinement, so that isolated pass is a regression check rather
        than resolved convergence evidence.</li>
    </ul>
    <p>These links reuse the existing studies; they do not claim new runs of
      those refinement sequences. See each example’s engine record. Claims
      about shells, coupling, optimization, singular stresses or physical
      strength need suitable evidence of their own.</p>

    <h2 id="record">Keep a reproducible record</h2>
    <p>Record geometry, coherent units, material law and constants, every
      support and load distribution, element family/order and local resolution,
      solver settings, reference assumptions, measured quantity and location,
      recovery/averaging, tolerances and their reasons. Preserve full-precision
      values, commands, engine identity and exact source revision.
      The <a href="/theory/axial-bar.json">bar’s machine-readable record</a>
      shows this for an executed comparison.</p>
    <p>Report discrepancies and excluded claims with the numbers. A small
      residual is not a mesh error estimate. Similar results on two coarse
      meshes can miss the same physics. Use the
      <a href="/theory/results/interpretation-and-convergence/#comparison">comparison checklist</a>
      to keep locations, units and recovery measures consistent.</p>

    <h2 id="maintenance">Update the explanation with the behavior</h2>
    <p>Contributors keep theory and evidence with the code. A change to a
      formulation, material law, boundary condition, default, result field or
      numerical behavior must review the affected articles, examples and
      executable checks in the same PR. Update assumptions, equations, symbol
      links, limitations and reviewed source references wherever the claim changes.</p>
    <p>When a result moves, investigate before replacing its reference or
      widening a tolerance. Re-run the affected benchmarks with the matching
      engine; regenerate the numerical record and pages from their sources.
      Preserve stable URLs and section IDs, and check links, reading order,
      notation and mathematical rendering. Conceptual pages without changed
      product claims do not need an artificial solver revision bump.</p>
    <p>The ${source("docs/theory/README.md", 1, "contributor workflow")}
      lists change-to-page mappings, commands and the evidence required in
      review. Linear owns planning and architecture decisions; the website
      repository owns the explanations and reproducible checks.</p>

    <h2 id="references">Further reading</h2>
    <ul class="refs"><li>ASME V&amp;V 10-2019, <cite>Standard for Verification and Validation in Computational Solid Mechanics</cite>.</li>
      <li>Oberkampf and Roy, <cite>Verification and Validation in Scientific Computing</cite> (2010).</li>
      <li>Szabó and Babuška, <cite>Finite Element Analysis</cite> (1991), discretization error and convergence.</li></ul>`,
};
