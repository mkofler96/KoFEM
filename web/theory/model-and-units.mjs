// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Representative article from docs/theory/article-template.md.
import { tex, texBlock } from "../../examples/validation/lib/tex.mjs";

const revision = "9274be29cfdd82ece266e63ac487358b2f551b57";
const source = (path) =>
  `https://github.com/mkofler96/KoFEM/blob/${revision}/${path}`;
const symbol = (id, expression, label) =>
  `<a href="#${id}" aria-label="${label}">${tex(expression)}</a>`;

export default {
  slug: "foundations/model-and-units",
  description:
    "The physical assumptions and coherent N, mm and MPa units of a KoFEM static solid analysis, illustrated by the axial bar in tension.",
  sections: [
    ["scope", "Assumptions and scope"],
    ["units", "A coherent unit system"],
    ["axial-bar", "The axial bar"],
    ["implementation", "KoFEM implementation"],
    ["limitations", "Limitations"],
    ["references", "Example and references"],
  ],
  body: `
    <p class="lede">What physical model and unit system does a KoFEM static analysis represent?</p>
    <p><strong>Prerequisites:</strong> basic statics: force balance, a support reaction and an axial load.</p>
    <p class="meta">Reviewed solver revision:
      <a href="https://github.com/mkofler96/KoFEM/tree/${revision}"><code>${revision}</code></a>
      · <time datetime="2026-11-02">2 November 2026</time></p>

    <h2 id="scope">Assumptions and scope <a class="section-link" href="#scope" aria-label="Link to Assumptions and scope">#</a></h2>
    <p>A static solid study balances applied forces with elastic resistance.
      It assumes small strains, small displacements and an isotropic, linear-elastic
      material. The material is described by Young’s modulus and Poisson’s ratio.
      There is no time-dependent or inertial term in this balance.</p>
    <p>This page covers the 3D solid path on tetrahedral or hexahedral FEM
      discretisations, with order 1 or 2 displacement approximation. The bar below
      uses order 1 hexahedra. Shells, solid–shell coupling and optimization have
      separate formulations and will have their own guide pages.</p>

    <h2 id="units">A coherent unit system <a class="section-link" href="#units" aria-label="Link to A coherent unit system">#</a></h2>
    <p>Use millimetres for lengths and displacements, newtons for forces and
      megapascals for stiffness and stress. Because ${tex("1\\text{ MPa} = 1\\text{ N}/\\text{mm}^2")},
      those values can enter the same equations directly. The solver performs no
      dimensional conversion; imported coordinates and every input must already agree.</p>
    <div class="table-wrap">
      <table><caption>Units used in the app</caption>
        <thead><tr><th scope="col">Quantity</th><th scope="col">Unit</th></tr></thead>
        <tbody>
          <tr><th scope="row">Length, displacement, thickness</th><td>mm</td></tr>
          <tr><th scope="row">Force</th><td>N</td></tr>
          <tr><th scope="row">Moment</th><td>N·mm</td></tr>
          <tr><th scope="row">Young’s modulus, pressure, stress</th><td>MPa = N/mm²</td></tr>
          <tr><th scope="row">Strain, Poisson’s ratio</th><td>Dimensionless</td></tr>
        </tbody>
      </table>
    </div>
    <p>For example, enter a steel modulus as 210000 MPa. Entering 210 while
      leaving the lengths in mm describes a material one thousand times softer.</p>

    <h2 id="axial-bar">The axial bar <a class="section-link" href="#axial-bar" aria-label="Link to The axial bar">#</a></h2>
    <p>A straight, prismatic bar under uniform axial tension gives a simple
      dimensional check. Its analytical extension is force times length divided
      by Young’s modulus times cross-sectional area:</p>
    <div class="equation" tabindex="0" role="region" aria-label="Axial extension equation; scroll horizontally if needed">
      ${texBlock("δ = \\frac{P L}{E A}.")}
    </div>
    <dl class="symbols">
      <dt id="extension">${tex("δ")}</dt><dd>Extension of the loaded end, in mm.</dd>
      <dt id="force">${tex("P")}</dt><dd>Total tensile force along the bar axis, in N.</dd>
      <dt id="length">${tex("L")}</dt><dd>Undeformed bar length, in mm.</dd>
      <dt id="young-modulus">${tex("E")}</dt><dd>Young’s modulus, in MPa.</dd>
      <dt id="area">${tex("A")}</dt><dd>Cross-sectional area, in mm².</dd>
    </dl>
    <p>The <a href="/examples/axial-bar/">running example</a> uses
      ${symbol("force", "P = 10^6\\text{ N}", "P equals one million newtons; force definition")},
      ${symbol("length", "L = 1000\\text{ mm}", "L equals 1000 millimetres; length definition")},
      ${symbol("young-modulus", "E = 210000\\text{ MPa}", "E equals 210000 megapascals; Young’s modulus definition")} and
      ${symbol("area", "A = 100 × 100\\text{ mm}^2", "A equals 100 by 100 square millimetres; area definition")}.
      Poisson’s ratio is 0.3 (dimensionless). Substituting the values gives the
      one-dimensional analytical reference of approximately 0.47619 mm:</p>
    <div class="equation" tabindex="0" role="region" aria-label="Axial bar dimensional check; scroll horizontally if needed">
      ${texBlock("δ = \\frac{P L}{E A} = \\frac{10^6\\text{ N} × 1000\\text{ mm}}{210000\\text{ N}/\\text{mm}^2 × 100\\text{ mm} × 100\\text{ mm}} = \\frac{10^9}{2.1 × 10^9}\\text{ mm} \\approx 0.47619\\text{ mm}.")}
    </div>
    <figure class="result">
      <img src="/examples/axial-bar.png" width="1200" height="401" loading="lazy"
        alt="Axial bar with displacement increasing from the fixed end to the end loaded in tension." />
      <figcaption>The running example’s solved FEM discretisation. The
        <a href="/examples/axial-bar/#results">example page</a> owns the measured
        result and its comparison with the analytical reference.</figcaption>
    </figure>

    <h2 id="implementation">KoFEM implementation <a class="section-link" href="#implementation" aria-label="Link to KoFEM implementation">#</a></h2>
    <ol>
      <li><a href="${source("web/src/store/materialSlice.ts")}">Material input</a>
        records the modulus in MPa and Poisson’s ratio without a unit conversion.</li>
      <li>The <a href="${source("examples/validation/cases/axial-bar.mjs")}">bar fixture</a>
        defines dimensions in mm, an order 1 hexahedral FEM discretisation,
        a fixed end and a total face force in N. The
        <a href="${source("examples/validation/lib/app-model.mjs")}">app-model builder</a>
        turns that force into a work-equivalent surface traction.</li>
      <li>The production <a href="${source("engine/cpp/solve_mfem.cpp")}">MFEM solid solver</a>
        assembles the displacement problem, applies constraints and solves the
        linear system. It returns vertex displacements and element-centre von Mises stress.</li>
      <li>The app’s <a href="${source("web/src/lib/resultField.ts")}">result field mapping</a>
        displays displacement components Ux, Uy and Uz in mm and stress in MPa.</li>
    </ol>

    <h2 id="limitations">Limitations and practical consequences <a class="section-link" href="#limitations" aria-label="Link to Limitations">#</a></h2>
    <p>The analytical bar permits free lateral contraction. The 3D fixture fixes
      all three displacement components on one end, suppressing contraction near
      that support. A small difference from the one-dimensional reference is
      therefore expected; mesh refinement alone cannot remove that modelling difference.</p>
    <p>This example does not establish accuracy for bending, stress concentrations,
      quadratic elements, shells or coupling. Check the assumptions and compare
      results with an appropriate reference for each problem.</p>
    <p>Density is stored for future gravity and inertial behaviour; it does not
      contribute to the current static equilibrium. Large deformation, plasticity
      and dynamic response are outside this page’s linear-static model.</p>

    <h2 id="references">Example and references <a class="section-link" href="#references" aria-label="Link to Example and references">#</a></h2>
    <p><a class="button" href="/app/?example=axial-bar">Open in KoFEM</a>
      <a href="/examples/axial-bar/">Read the axial-bar benchmark</a></p>
    <p>From a repository checkout with its matching WASM engine installed:</p>
    <pre tabindex="0" aria-label="Reproduce the axial bar"><code>node examples/validation/run.mjs --case axial-bar</code></pre>
    <ol class="refs">
      <li>Gere and Goodno, <cite>Mechanics of Materials</cite>, axially loaded members:
        the prismatic-bar relation ${tex("δ = P L/(E A)")}.</li>
      <li><a href="${source("examples/validation/textbook/axial-bar.mjs")}">Axial-bar derivation and modelling discussion</a>.</li>
      <li><a href="${source("engine/cpp/solve_mfem.cpp")}">Production solid solver at the reviewed revision</a>.</li>
    </ol>`,
};
