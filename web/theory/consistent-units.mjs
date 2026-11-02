// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { tex, texBlock } from "../../examples/validation/lib/tex.mjs";

export default {
  slug: "foundations/consistent-units",
  description:
    "Compare consistent SI, N–mm–s, N–mm–ms, kN–mm–ms, CGS and US customary unit systems for finite element analysis, with material-value conversions.",
  sections: [
    ["consistency", "What consistency means"],
    ["systems", "Common unit systems"],
    ["material-values", "The same material in different units"],
    ["practical-checks", "Practical checks"],
    ["dimensional-analysis-example", "Example: blast-wave scaling"],
    ["references", "References"],
  ],
  body: `
    <p class="lede">Which combinations of units can be used together in a finite element model?</p>

    <h2 id="consistency">What consistency means</h2>
    <p>A consistent system makes the governing equations work directly on the
      numerical values, without hidden conversion factors. Choose mass, length
      and time units; force, stress, energy and density then follow. With square
      brackets denoting the unit of a quantity:</p>
    <div class="equation" tabindex="0" role="region" aria-label="Force units equal mass times length divided by time squared">
      ${texBlock("[F] = \\frac{[M][L]}{[T]^2}.")}
    </div>
    <p>Here ${tex("F")} is force, ${tex("M")} is mass,
      ${tex("L")} is length and ${tex("T")} is time. Stress and Young’s modulus
      have force-per-area units; energy has force-times-length units; mass density
      has mass-per-volume units:</p>
    <div class="equation" tabindex="0" role="region" aria-label="Units of stress, Young’s modulus, energy and mass density">
      ${texBlock("[σ] = [E] = \\frac{[F]}{[L]^2}, \\quad [W] = [F][L], \\quad [ρ] = \\frac{[M]}{[L]^3}.")}
    </div>
    <p>The symbols ${tex("σ")}, ${tex("E")}, ${tex("W")} and ${tex("ρ")}
      denote stress, Young’s modulus, energy and mass density respectively.
      One can instead choose force, length and time and derive the mass unit.
      This is why N–mm–s uses tonnes, while N–mm–ms uses grams.</p>
    <p>For the general method, see <a href="#ref-barenblatt">Barenblatt’s textbook</a>
      and <a href="#ref-buckingham">Buckingham’s dimensional-analysis paper</a>.
      Matching dimensions is a necessary check on an equation; it cannot by
      itself establish the physical model or determine a dimensionless factor.</p>

    <h2 id="systems">Common unit systems</h2>
    <p>Each row is a complete, consistent choice. The alternatives below are a
      general FEM reference; they do not imply that a particular program offers
      a unit-system selector or automatically converts inputs.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Common consistent unit systems; scroll horizontally if needed">
      <table>
        <caption>Base units and selected derived units</caption>
        <thead><tr><th scope="col">System</th><th scope="col">Mass</th><th scope="col">Length</th><th scope="col">Time</th><th scope="col">Force</th><th scope="col">Stress / modulus</th><th scope="col">Energy</th></tr></thead>
        <tbody>
          <tr><th scope="row">SI</th><td>kg</td><td>m</td><td>s</td><td>N</td><td>Pa</td><td>J</td></tr>
          <tr><th scope="row">N–mm–s</th><td>tonne</td><td>mm</td><td>s</td><td>N</td><td>MPa</td><td>N·mm (mJ)</td></tr>
          <tr><th scope="row">N–mm–ms</th><td>g</td><td>mm</td><td>ms</td><td>N</td><td>MPa</td><td>N·mm (mJ)</td></tr>
          <tr><th scope="row">kN–mm–ms</th><td>kg</td><td>mm</td><td>ms</td><td>kN</td><td>GPa</td><td>kN·mm (J)</td></tr>
          <tr><th scope="row">CGS</th><td>g</td><td>cm</td><td>s</td><td>dyn</td><td>dyn/cm²</td><td>erg</td></tr>
          <tr><th scope="row">US inch–second</th><td>lbf·s²/in</td><td>in</td><td>s</td><td>lbf</td><td>psi</td><td>lbf·in</td></tr>
          <tr><th scope="row">US foot–second</th><td>slug</td><td>ft</td><td>s</td><td>lbf</td><td>psf</td><td>lbf·ft</td></tr>
        </tbody>
      </table>
    </div>
    <p>A tonne here is a metric tonne, not a US short ton. In the inch system,
      lbf·s²/in is a mass unit; it is not a pound mass (lbm). Replacing it by lbm
      would require an additional conversion factor in force–mass relations.</p>
    <p>Even in a static calculation that has no mass or time term, geometry,
      loads and stiffness must agree. For N and mm,
      ${tex("1\\text{ MPa} = 1\\text{ N}/\\text{mm}^2")}; for kN and mm,
      ${tex("1\\text{ GPa} = 1\\text{ kN}/\\text{mm}^2")}.</p>
    <p><strong>The default stress unit changes with the unit system.</strong>
      In SI with metres, kilograms and seconds, stress and Young’s modulus
      are expressed in Pa (N/m²) by default. In an N–mm system, the corresponding
      unit is MPa (N/mm²). Switching to SI therefore changes the numerical values
      of both material stiffness and reported stress: a modulus of 210000 MPa
      becomes ${tex("2.10 × 10^{11}\\text{ Pa}")}, and a stress of 100 MPa
      becomes ${tex("10^8\\text{ Pa}")}. This is a unit conversion, not a change
      in the physical material or stress.</p>

    <h2 id="material-values">The same material in different units</h2>
    <p>Take illustrative steel with Young’s modulus 210 GPa and mass density
      7850 kg/m³. These are example material values, not a specification for
      every steel grade. The physical material is identical in every row:</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Illustrative steel unit conversions; scroll horizontally if needed">
      <table>
        <caption>Converted material values (US values rounded)</caption>
        <thead><tr><th scope="col">System</th><th scope="col">Young’s modulus</th><th scope="col">Mass density</th></tr></thead>
        <tbody>
          <tr><th scope="row">SI</th><td>${tex("2.10 × 10^{11}")} Pa</td><td>7850 kg/m³</td></tr>
          <tr><th scope="row">N–mm–s</th><td>210000 MPa</td><td>${tex("7.85 × 10^{-9}")} tonne/mm³</td></tr>
          <tr><th scope="row">N–mm–ms</th><td>210000 MPa</td><td>${tex("7.85 × 10^{-3}")} g/mm³</td></tr>
          <tr><th scope="row">kN–mm–ms</th><td>210 GPa</td><td>${tex("7.85 × 10^{-6}")} kg/mm³</td></tr>
          <tr><th scope="row">CGS</th><td>${tex("2.10 × 10^{12}")} dyn/cm²</td><td>7.85 g/cm³</td></tr>
          <tr><th scope="row">US inch–second</th><td>${tex("3.046 × 10^7")} psi</td><td>${tex("7.345 × 10^{-4}")} (lbf·s²/in)/in³</td></tr>
          <tr><th scope="row">US foot–second</th><td>${tex("4.386 × 10^9")} psf</td><td>15.23 slug/ft³</td></tr>
        </tbody>
      </table>
    </div>
    <p>The two N–mm systems share the same force, stress and energy units.
      Their mass-density numbers differ by a factor of one million because
      their mass units differ by that factor. A density value cannot be copied
      between these systems unchanged.</p>

    <h2 id="practical-checks">Practical checks</h2>
    <ul>
      <li>Record the unit system before importing geometry or entering material values.</li>
      <li>Convert every dimensional quantity, including thickness, pressure,
        moments and prescribed displacements. Converting length alone changes the problem.</li>
      <li>Keep dimensionless quantities, such as Poisson’s ratio and strain, unchanged.</li>
      <li>Check a simple calculation in two systems and convert the outputs back
        to the same unit. They should represent the same physical answer.</li>
    </ul>
    <p>For example, the bar in <a href="/theory/foundations/model-and-units/#axial-bar">Model and units</a>
      has length 1 m, area 0.0001 m², force 1000 N and modulus
      ${tex("210 × 10^9\\text{ Pa}")} in SI. Its extension is approximately
      ${tex("4.7619 × 10^{-5}\\text{ m} = 0.047619\\text{ mm}")} in either system.</p>

    <h2 id="dimensional-analysis-example">Example: blast-wave scaling</h2>
    <p>The famous historical example is G. I. Taylor’s analysis of the 1945
      Trinity atomic test, published in <a href="#ref-taylor">two 1950 papers</a>.
      The dimensional argument below captures the scaling of an expanding shock
      front. Taylor’s full analysis also used flow equations and observations;
      units alone were not the entire calculation.</p>
    <p>Consider an idealised, strong, spherical blast in a uniform medium.
      Suppose the shock-front radius ${tex("R")} depends on released energy
      ${tex("Q")}, ambient mass density ${tex("ρ")} and elapsed time ${tex("t")}.
      Here ${tex("Q")} denotes energy, keeping it distinct from Young’s modulus
      ${tex("E")} above. Their dimensions are:</p>
    <div class="equation" tabindex="0" role="region" aria-label="Dimensions of energy, density and time">
      ${texBlock("[Q] = [M][L]^2[T]^{-2}, \\quad [ρ] = [M][L]^{-3}, \\quad [t] = [T].")}
    </div>
    <p>Write a candidate power law ${tex("R = C Q^a ρ^b t^c")}, with a
      dimensionless coefficient ${tex("C")}. Matching mass, length and time
      powers on both sides gives:</p>
    <div class="equation" tabindex="0" role="region" aria-label="Equations matching the mass, length and time exponents">
      ${texBlock("a+b=0, \\quad 2a-3b=1, \\quad -2a+c=0.")}
    </div>
    <p>Thus ${tex("a=1/5")}, ${tex("b=-1/5")} and ${tex("c=2/5")}, giving
      the familiar Sedov–Taylor scaling:</p>
    <div class="equation" tabindex="0" role="region" aria-label="Shock-front radius scales as energy times time squared divided by density, to the one-fifth power">
      ${texBlock("R = C \\left(\\frac{Q t^2}{ρ}\\right)^{1/5}.")}
    </div>
    <p>Dimensional analysis fixes these exponents under the stated assumptions.
      It does not determine ${tex("C")}, which requires a physical solution or
      measurement. The model assumes a concentrated energy release and negligible
      ambient pressure and energy losses. Its radius is the position of a shock
      front at a given time, not a damage radius.</p>

    <h2 id="references">References</h2>
    <ol class="refs">
      <li><a href="https://lsdyna.ansys.com/consistent-units/">Ansys LS-DYNA: Consistent units</a>,
        dimensional relations and examples of consistent systems. The material
        illustration on this page uses its own stated values of 210 GPa and 7850 kg/m³.</li>
      <li id="ref-barenblatt">G. I. Barenblatt,
        <a href="https://www.cambridge.org/core/books/abs/scaling-selfsimilarity-and-intermediate-asymptotics/dimensions-dimensional-analysis-and-similarity/84201844CDB891111B62B8828B6F9744"><cite>Scaling, Self-similarity, and Intermediate Asymptotics</cite></a>,
        Cambridge University Press (1996), chapter 1: dimensions, dimensional analysis and similarity.</li>
      <li id="ref-buckingham">E. Buckingham,
        <a href="https://doi.org/10.1103/PhysRev.4.345">“On Physically Similar Systems; Illustrations of the Use of Dimensional Equations”</a>,
        <cite>Physical Review</cite> 4, 345–376 (1914).</li>
      <li id="ref-taylor">G. I. Taylor, “The formation of a blast wave by a very intense explosion”,
        <a href="https://doi.org/10.1098/rspa.1950.0049">I. Theoretical discussion</a>,
        <cite>Proceedings of the Royal Society A</cite> 201, 159–174 (1950), and
        <a href="https://doi.org/10.1098/rspa.1950.0050">II. The atomic explosion of 1945</a>, 175–186 (1950).</li>
      <li><a href="/theory/foundations/model-and-units/">Model and units</a>,
        modelling assumptions and a worked analytical bar calculation.</li>
    </ol>`,
};
