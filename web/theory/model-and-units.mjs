// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A general FEM introduction; product-specific implementation is not needed here.
import { tex, texBlock } from "../../examples/validation/lib/tex.mjs";

const symbol = (id, expression, label) =>
  `<a href="#${id}" aria-label="${label}">${tex(expression)}</a>`;

export default {
  slug: "foundations/model-and-units",
  description:
    "An introduction to finite element modelling: geometry, material laws, loads, supports, assumptions and consistent units, with a simple bar calculation.",
  sections: [
    ["scope", "What a model describes"],
    ["units", "Choose consistent units"],
    ["axial-bar", "A simple physical model"],
    ["limitations", "Assumptions and limitations"],
    ["references", "Worked calculation and references"],
  ],
  body: `
    <p class="lede">What makes a useful finite element model?</p>

    <h2 id="scope">What a model describes</h2>
    <p>A model is a deliberately simplified description of a physical problem.
      It identifies the body and its geometry, the material behaviour, the loads,
      and the supports or prescribed motion. Its assumptions determine which
      questions the calculation can answer.</p>
    <p>The governing equations describe fields such as displacement throughout
      the body. The finite element method approximates those fields on a
      discretisation made of elements connected at nodes. The physical model
      comes first; choosing smaller elements improves the approximation to that
      model, but does not repair an unsuitable material law or support condition.</p>
    <p>Static, small-strain, linear elasticity is a common starting point:
      applied forces balance elastic resistance, deformation is small, and stress
      varies linearly with strain. Other models are needed for effects such as
      plasticity, large deformation or time-dependent motion.</p>

    <h2 id="units">Choose consistent units</h2>
    <p>Every dimensional input must belong to one consistent system. For example,
      lengths in mm and forces in N require stiffness and stress in
      ${tex("\\text{N}/\\text{mm}^2 = \\text{MPa}")}.
      A steel modulus of 210 GPa is therefore entered numerically as 210000
      when the stress unit is MPa.</p>
    <p>In SI with metres, kilograms and seconds, the default stress unit is Pa;
      the same modulus is ${tex("2.10 × 10^{11}\\text{ Pa}")}. Changing the unit
      system changes the stress unit as well as the numerical input values.</p>
    <p>The choice is yours, but all quantities must agree. The
      <a href="/theory/foundations/consistent-units/">consistent unit systems reference</a>
      compares common SI, millimetre-based, CGS and US customary systems,
      including mass, time, energy and density.</p>

    <h2 id="axial-bar">A simple physical model</h2>
    <p>Consider a straight, prismatic bar held at one end and pulled along its
      axis. Assume uniform axial stress, small strain and a linear-elastic
      material. Force balance gives stress as force divided by area; Hooke’s law
      then gives strain as stress divided by Young’s modulus. Multiplying the
      strain by the original length gives the extension:</p>
    <div class="equation" tabindex="0" role="region" aria-label="Axial extension equation; scroll horizontally if needed">
      ${texBlock("δ = \\frac{P L}{E A}.")}
    </div>
    <dl class="symbols">
      <dt id="extension">${tex("δ")}</dt><dd>Extension of the loaded end.</dd>
      <dt id="force">${tex("P")}</dt><dd>Total tensile force along the bar axis.</dd>
      <dt id="length">${tex("L")}</dt><dd>Undeformed bar length.</dd>
      <dt id="young-modulus">${tex("E")}</dt><dd>Young’s modulus.</dd>
      <dt id="area">${tex("A")}</dt><dd>Cross-sectional area.</dd>
    </dl>
    <figure class="model-sketch">
      <svg role="img" aria-labelledby="bar-title" aria-describedby="bar-description" viewBox="0 0 600 180">
        <title id="bar-title">Idealised bar under axial tension</title>
        <desc id="bar-description">A straight bar of length L and cross-sectional area A is fixed at its left end and pulled to the right by a force P.</desc>
        <defs><marker id="bar-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="currentColor" /></marker></defs>
        <path d="M70 35V115 M50 50L70 35 M50 70L70 55 M50 90L70 75 M50 110L70 95" fill="none" stroke="currentColor" stroke-width="2" />
        <rect x="70" y="50" width="380" height="50" fill="var(--panel2)" stroke="currentColor" />
        <path d="M450 75H550" stroke="currentColor" stroke-width="2" marker-end="url(#bar-arrow)" />
        <path d="M75 135H445" stroke="currentColor" marker-start="url(#bar-arrow)" marker-end="url(#bar-arrow)" />
        <text x="495" y="58" fill="currentColor">P</text>
        <text x="250" y="160" fill="currentColor">L</text>
        <text x="270" y="81" fill="currentColor">E, A</text>
      </svg>
      <figcaption>A one-dimensional idealisation of a bar in tension. The
        drawing describes the physical model; it does not show an FEM discretisation.</figcaption>
    </figure>
    <p>For a generic example, take
      ${symbol("force", "P = 1000\\text{ N}", "P equals 1000 newtons; force definition")},
      ${symbol("length", "L = 1000\\text{ mm}", "L equals 1000 millimetres; length definition")},
      ${symbol("young-modulus", "E = 210000\\text{ MPa}", "E equals 210000 megapascals; Young’s modulus definition")} and
      ${symbol("area", "A = 100\\text{ mm}^2", "A equals 100 square millimetres; area definition")}.
      Substitution gives approximately 0.047619 mm:</p>
    <div class="equation" tabindex="0" role="region" aria-label="Axial bar dimensional check; scroll horizontally if needed">
      ${texBlock("δ = \\frac{P L}{E A} = \\frac{1000\\text{ N} × 1000\\text{ mm}}{210000\\text{ N}/\\text{mm}^2 × 100\\text{ mm}^2} = \\frac{10^6}{21 × 10^6}\\text{ mm} \\approx 0.047619\\text{ mm}.")}
    </div>

    <h2 id="limitations">Assumptions and limitations</h2>
    <p>This one-dimensional bar model permits free lateral contraction and
      represents only axial deformation. A three-dimensional clamp that prevents
      lateral contraction creates a different local stress state. Bending,
      changes in cross-section and load introduction can require a richer model.</p>
    <p>Before refining a discretisation, check whether the geometry, material law,
      loading and supports capture the behaviour of interest. Then compare with
      an analytical reference, experiment or a suitable convergence study.
      A small numerical residual alone does not establish physical accuracy.</p>

    <h2 id="references">Worked calculation and references</h2>
    <p>This standalone Python calculation uses N, mm and MPa. It evaluates the
      analytical model, independently of any FEM solver:</p>
    <pre tabindex="0" aria-label="Calculate the analytical bar extension"><code>force_n = 1000
length_mm = 1000
young_mpa = 210000
area_mm2 = 100
extension_mm = force_n * length_mm / (young_mpa * area_mm2)
print(f"{extension_mm:.6f} mm")  # 0.047619 mm</code></pre>
    <ol class="refs">
      <li>Gere and Goodno, <cite>Mechanics of Materials</cite>, axially loaded members.</li>
      <li>Bathe, <cite>Finite Element Procedures</cite>, mathematical models and finite element discretisation.</li>
      <li><a href="/theory/foundations/consistent-units/">Consistent unit systems</a>: common choices and conversion examples.</li>
    </ol>`,
};
