// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { equation, tex } from "../operators/math.mjs";
import { figure } from "../figures/index.mjs";
import { SCREW_PROFILE_ENLARGEMENT } from "../figures/couplings.mjs";
import { solvedViewer } from "../viewers/index.mjs";

// The coupling solver code, reviewed at this revision: the distributing
// coupling's fit about the centroid and the coupled solve's rotation flags.
const revision = "e30299bcb482db14591d3abafecc7bbe7de18967";
const codeSource = (path, line, label) =>
  `<a href="https://github.com/mkofler96/KoFEM/blob/${revision}/${path}#L${line}">${label}</a>`;

const record = JSON.parse(
  readFileSync(
    new URL("../../public/theory/couplings.json", import.meta.url),
    "utf8",
  ),
);
const { screw, bar } = record;
const kin = screw.kinds.kinematic;
const dist = screw.kinds.distributing;

const fixed = (value, digits) => value.toFixed(digits);
const micro = (mm) => (mm * 1000).toFixed(2);
const percent = (value, reference) =>
  `${value >= reference ? "+" : "−"}${Math.abs(100 * (value / reference - 1)).toFixed(1)} %`;
const table = (caption, headings, rows) =>
  `<div class="table-wrap" tabindex="0" role="region" aria-label="${caption}; scroll horizontally if needed"><table>
    <caption>${caption}</caption><thead><tr>${headings.map((heading) => `<th scope="col">${heading}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(([label, ...cells]) => `<tr><th scope="row">${label}</th>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;

const timoshenko =
  bar.theory.eulerBernoulliDeflection + bar.theory.shearDeflection;
const lastBand = (kind) => bar.torsion[kind].bandPeaks.at(-1)[1];
const midBand = (kind) =>
  bar.torsion[kind].bandPeaks[
    Math.floor(bar.torsion[kind].bandPeaks.length / 2)
  ][1];

export default {
  slug: "numerical-methods/couplings",
  description:
    "What kinematic (RBE2) and distributing (RBE3) couplings do to the surface they grip, with solved examples: a screw head on a plate and a cantilever in bending and torsion.",
  sections: [
    ["reference-point", "A point that stands for a part"],
    ["kinematic", "Kinematic coupling (RBE2)"],
    ["distributing", "Distributing coupling (RBE3)"],
    ["screw", "Example: a screw head on a plate"],
    ["cantilever", "Example: a coupled bar end"],
    ["choosing", "Which coupling to use"],
    ["implementation", "KoFEM implementation"],
    ["limits", "Limitations"],
    ["references", "References"],
  ],
  body: `
    <h1>Kinematic and distributing couplings</h1>
    <p class="lede">What does a coupling do to the surface it grips, and which
      one should stand in for a screw, a shaft or a remote load?</p>

    <h2 id="reference-point">A point that stands for a part</h2>
    <p>A coupling joins one <strong>reference point</strong> to the nodes of a
      surface. It lets a part that is not modelled — a screw, a shaft, a
      loading jig — act on the model through that point: a force or a moment
      on the point reaches the surface, and a support on the point holds it.
      The point carries three translations and three rotations, so it can
      take a moment, which a single solid node cannot.</p>
    ${figure("coupling-bolt-idealisation", "A bolt in the model: the bolt is not meshed, and the part below the joint is a fixed base. The ring the head bears on is coupled to a point on the bolt's axis, and the bolt's force acts on that point.")}
    <p>There are two ways to tie the point to the surface, and they are not
      interchangeable. A <strong>kinematic</strong> coupling makes the
      surface move as a rigid body with the point. A
      <strong>distributing</strong> coupling lets the surface deform and
      makes the point follow its average motion. Both are exact constraints
      on the discretisation: they enter the system through the same
      transformation as every other constraint
      (<a href="/theory/shells/solid-coupling/#reduction">constraint
      reduction</a>), and the loads they carry follow from the motion they
      impose. What differs is that motion.</p>
    <p>Below, ${tex("\\mathbf{x}_R")} is the reference point and
      ${tex("\\mathbf{u}_R")}, ${tex("\\mathbf{θ}_R")} its translation and
      rotation. The coupled nodes ${tex("i = 1 … N")} sit at
      ${tex("\\mathbf{x}_i")} and move by ${tex("\\mathbf{u}_i")}.
      Rotations are small, as everywhere in the
      <a href="/theory/solid-mechanics/linear-elasticity/">linear analysis</a>.</p>

    <h2 id="kinematic">Kinematic coupling (RBE2)</h2>
    <p>Every coupled node follows the point as a rigid body:</p>
    ${equation("\\mathbf{u}_i = \\mathbf{u}_R + \\mathbf{θ}_R × (\\mathbf{x}_i − \\mathbf{x}_R), \\quad i = 1 … N.", "Kinematic coupling: each coupled node's displacement is the point's translation plus its rotation crossed with the node's offset from the point")}
    <p>The coupled nodes become dependent; the point stays a free unknown.
      So the point can be loaded, fixed, or given a prescribed displacement,
      and it can be coupled onward to another point. The surface cannot
      deform at all: it is welded to an infinitely stiff body. How the load
      spreads over the surface is not prescribed; it is whatever the
      stiffness of the model needs to keep that surface rigid, and it piles
      up where the rigid patch meets the flexible material around it.</p>

    <h2 id="distributing">Distributing coupling (RBE3)</h2>
    <p>Here the point follows the surface. Give each coupled node a weight
      ${tex("w_i")}, with ${tex("W = \\sum w_i")}, and measure offsets from the
      weighted centroid ${tex("\\mathbf{x}_c = \\sum w_i \\mathbf{x}_i / W")}:
      ${tex("\\mathbf{d}_i = \\mathbf{x}_i − \\mathbf{x}_c")}. The surface's
      rigid motion that fits its nodes best in the weighted least-squares
      sense is a translation of the centroid and a rotation:</p>
    ${equation("\\mathbf{u}_c = \\frac{1}{W} \\sum w_i \\mathbf{u}_i, \\quad \\mathbf{θ}_R = \\mathbf{H}^{−1} \\sum w_i \\, \\mathbf{d}_i × \\mathbf{u}_i, \\quad \\mathbf{H} = \\sum w_i (|\\mathbf{d}_i|^2 \\mathbf{I} − \\mathbf{d}_i \\mathbf{d}_i^T).", "Distributing coupling: the centroid translation is the weighted mean of the node displacements; the rotation is the inverse weighted inertia H times the weighted sum of offset cross displacement")}
    <p>The point then moves with that rigid motion, carried from the centroid
      to wherever the point is:</p>
    ${equation("\\mathbf{u}_R = \\mathbf{u}_c + \\mathbf{θ}_R × (\\mathbf{x}_R − \\mathbf{x}_c).", "The reference point's translation is the centroid translation plus the fitted rotation crossed with the point's offset from the centroid")}
    <p>The point is now the dependent one: it cannot be fixed or driven,
      only loaded. The surface keeps all its own stiffness — the coupling
      adds none — so it deforms as the material around it lets it. The
      transpose of this map spreads a load on the point over the nodes. A
      force ${tex("\\mathbf{F}")} and a moment ${tex("\\mathbf{M}")} on the
      point become, at node ${tex("i")},</p>
    ${equation("\\mathbf{f}_i = \\frac{w_i}{W} \\mathbf{F} + w_i \\left(\\mathbf{H}^{−1} \\mathbf{M}_c\\right) × \\mathbf{d}_i, \\quad \\mathbf{M}_c = \\mathbf{M} + (\\mathbf{x}_R − \\mathbf{x}_c) × \\mathbf{F}.", "Each node takes its weight's share of the force, plus a share of the moment about the centroid that grows linearly with its offset; that moment includes the force's lever arm from the point to the centroid")}
    <p>These nodal forces are statically equivalent to the load on the point,
      lever arm included. With equal weights the force is shared equally per
      node, which is a uniform pressure only on a uniform mesh, and a moment
      is shared in proportion to each node's distance from the centroid. The
      fit needs nodes that do not all lie on one line: a straight row of
      nodes cannot measure a spin about itself.</p>

    <h2 id="screw">Example: a screw head on a plate</h2>
    <p>A steel plate ${2 * screw.model.halfWidth} × ${2 * screw.model.halfWidth}
      × ${screw.model.thickness} mm stands on a rigid base: its lower face is
      fixed. It has a clearance hole of radius ${screw.model.holeRadius} mm,
      as for the screw in the figure above. A screw head
      bears on the ring of the top face out to radius
      ${screw.model.headRadius} mm and presses it down with
      ${(screw.model.force / 1000).toFixed(0)} kN. The screw itself is not
      modelled: the ring is coupled to a point on the screw axis at the
      height of the top face, and the force is applied to that point. The
      ring is its own face, split off the top face as you would to pick it
      in the app. Netgen meshes it at ${screw.model.ringMeshSize} mm and the
      rest of the plate at ${screw.model.meshSize} mm. The plate is solved
      with quadratic tetrahedra, once with each coupling.</p>
    ${figure("coupling-screw-sections", `The section through the screw axis, drawn from the two solves: the displacement of each grid point and of the back of the hole is the solved field there. The legs run from the point to the ring's nodes on the cut. The grid is a drawing of the section; the solves use the tetrahedral mesh. Displacements enlarged ${SCREW_PROFILE_ENLARGEMENT}×.`)}
    ${table(
      "The screw head on the plate, by coupling",
      ["", "Kinematic (RBE2)", "Distributing (RBE3)"],
      [
        [
          "Deflection of the point",
          `${micro(kin.pointDeflection)} µm`,
          `${micro(dist.pointDeflection)} µm`,
        ],
        [
          "Ring's departure from a rigid motion",
          `${kin.ringDeformation < 1e-9 ? "0" : micro(kin.ringDeformation)} µm`,
          `${micro(dist.ringDeformation)} µm`,
        ],
        [
          `Peak von Mises stress within r = ${2 * screw.model.headRadius} mm`,
          `${fixed(kin.peakNearHead, 0)} MPa`,
          `${fixed(dist.peakNearHead, 0)} MPa`,
        ],
      ],
    )}
    <p>The kinematic coupling presses the ring in as a flat, rigid punch.
      The plate is stiffer under it — the point moves
      ${percent(kin.pointDeflection, dist.pointDeflection).replace("−", "")}
      less — and the stress collects where the rigid punch ends, at the edge
      of the ring. The distributing coupling lets the ring dish, deepest at
      the hole, where the plate has no material beside it to carry the load.
      Its equal nodal shares push the nodes there as hard as the outer ones,
      so its stress peaks at the hole edge. A real head lies between the two:
      stiffer than the plate, but not rigid, and in contact rather than
      bonded.</p>
    <p>Cut each model through the screw axis and look square on to the cut,
      as in the drawing above, to see the stress inside the plate. Both use
      one colour scale. With the kinematic coupling the stress peaks at the
      ring's outer edge, where the rigid ring meets the free top face. With
      the distributing coupling it peaks at the hole edge.</p>
    <div class="viewer-pair">
      ${solvedViewer("coupling-screw-kinematic", { caption: "The ring is held rigid; the stress peaks at its outer edge, where the rigid ring meets the free surface." })}
      ${solvedViewer("coupling-screw-distributing", { caption: "The ring deforms with the plate; the stress peaks at the hole edge." })}
    </div>

    <h2 id="cantilever">Example: a coupled bar end</h2>
    <p>The textbook comparison couples the free end face of a cantilever to a
      point at its centre. A steel bar ${bar.model.side} × ${bar.model.side}
      mm in section and ${bar.model.length} mm long is clamped at its root,
      meshed at ${bar.model.meshSize} mm and solved with quadratic
      tetrahedra. Its tip point carries either a transverse force of
      ${(bar.model.force / 1000).toFixed(0)} kN or a torque of
      ${(bar.model.torque / 1000).toFixed(0)} N·m.</p>
    ${table(
      "The cantilever's tip, by coupling, against beam and torsion theory",
      ["", "Kinematic (RBE2)", "Distributing (RBE3)", "Theory"],
      [
        [
          "Tip deflection under the force",
          `${fixed(bar.bending.kinematic.tipDeflection, 4)} mm`,
          `${fixed(bar.bending.distributing.tipDeflection, 4)} mm`,
          `${fixed(bar.theory.eulerBernoulliDeflection, 4)} mm (bending), ${fixed(timoshenko, 4)} mm (with shear)`,
        ],
        [
          "Twist of the tip face",
          `${fixed(1000 * bar.torsion.kinematic.tipTwist, 3)} mrad (${percent(bar.torsion.kinematic.tipTwist, bar.theory.saintVenantTwist)})`,
          `${fixed(1000 * bar.torsion.distributing.tipTwist, 3)} mrad (${percent(bar.torsion.distributing.tipTwist, bar.theory.saintVenantTwist)})`,
          `${fixed(1000 * bar.theory.saintVenantTwist, 3)} mrad (Saint-Venant)`,
        ],
        [
          `Twist ${bar.model.side} mm from the tip`,
          `${fixed(1000 * bar.torsion.kinematic.twistOneSideFromTip, 3)} mrad`,
          `${fixed(1000 * bar.torsion.distributing.twistOneSideFromTip, 3)} mrad`,
          "",
        ],
      ],
    )}
    <p>Under the force the two couplings give the same deflection, within
      ${fixed(Math.abs(100 * (bar.bending.distributing.tipDeflection / bar.bending.kinematic.tipDeflection - 1)), 2)} %:
      the tip face of a bent bar barely deforms, so holding it rigid changes
      almost nothing. The clamped root, which also stops the section's
      lateral contraction, keeps both a little below the beam value with
      shear.</p>
    <p>Torsion separates them. A twisted square section warps out of its
      plane. The kinematic coupling forbids that at the tip, which stiffens
      the bar slightly; the distributing coupling allows it, but feeds the
      torque in as nodal forces that grow with the distance from the axis,
      so the corners take the most — where Saint-Venant's shear stress is
      actually zero. One section depth from the tip both bars twist alike,
      and along the bar their largest stresses lie on one curve:</p>
    ${figure("coupling-torsion-decay", "The largest element stress in each 5 mm slice of the twisted bar. The element values are taken at element centres, a little inside the surface where Saint-Venant's maximum sits.")}
    <p>In the last slice the distributing coupling reaches
      ${fixed(lastBand("distributing"), 0)} MPa and the kinematic one
      ${fixed(lastBand("kinematic"), 0)} MPa; along the middle of the bar
      both read ${fixed(midBand("kinematic"), 0)} MPa. This is Saint-Venant's
      principle: two statically equivalent loads differ only within about one
      section depth of where they act.</p>
    <div class="viewer-pair">
      ${solvedViewer("coupling-torsion-kinematic", { caption: "The tip face is held rigid." })}
      ${solvedViewer("coupling-torsion-distributing", { caption: "The tip face warps; the corners take the torque." })}
    </div>

    <h2 id="choosing">Which coupling to use</h2>
    <ul>
      <li><strong>Distributing</strong> when the part behind the point is
        not much stiffer than the surface, or when only the load matters and
        the surface should keep its own stiffness: a remote force or moment, a
        bracket's load introduction, a light clamp.</li>
      <li><strong>Kinematic</strong> when the part really is much stiffer —
        a hardened shaft in a bore, a thick end plate — or when the point must
        be fixed or driven, which a distributing point cannot be.</li>
      <li>Either way, read stresses only some way from the coupled surface.
        Within about one characteristic size of it — the head diameter, the
        section depth — the coupling decides the stress, not the part it
        stands for. If the stress right there matters, model the part and its
        contact instead.</li>
    </ul>

    <h2 id="implementation">KoFEM implementation</h2>
    <p>A coupling is added in Supports &amp; Loads on picked faces, as
      <em>Distributing (RBE3)</em> or <em>Kinematic (RBE2)</em>. The point
      starts at the centre of the selection; for a cylindrical selection the
      ends of its axis are offered too, and any position can be typed in
      (${codeSource("web/src/lib/coupling.ts", 321, "reference point options")}).
      All coupled nodes have equal weights.</p>
    <p>The Rust solver writes each coupling as dependent degrees of freedom:
      ${codeSource("crates/kofem-fem/src/coupling.rs", 178, "kinematic")}
      couplings make the coupled nodes dependent;
      ${codeSource("crates/kofem-fem/src/coupling.rs", 229, "distributing")}
      couplings make the point dependent, fitted about the centroid and
      carried to the point as above
      (${codeSource("crates/kofem-fem/src/coupling.rs", 290, "the carry")}). A
      distributing coupling whose nodes lie on one line is refused when its
      point has rotations; a gap tie's node, which only needs its
      translation, follows the part of the motion such a row can measure
      (${codeSource("crates/kofem-fem/src/coupled_static.rs", 442, "rotation flags")}).
      The coupled solid solve then reduces the system as described in
      <a href="/theory/shells/solid-coupling/#reduction">solid–shell
      coupling</a>.</p>
    <p>Ties across a gap use distributing couplings too: each node of one
      surface is the point of a coupling to the patch of the other surface
      around it (${codeSource("crates/kofem-shellize/src/ties.rs", 153, "tie couplings")}).
      Its node is never at the patch's centroid, so carrying the fitted motion
      to the node, rotation included, is what makes such a tie transmit
      bending.</p>
    <p>The examples above were built from STEP files and meshed by the app's
      engine, then solved with the same coupled solve the app runs.</p>

    <h2 id="limits">Limitations</h2>
    <ul>
      <li>Both couplings are bonded and linear: no contact, no gap opening,
        no friction, no preload. A screw's clamping force is a load on the
        point here, not a bolt pretension.</li>
      <li>Weights are equal per node. On a graded mesh a distributing
        coupling then loads the fine region more per area than the coarse
        one.</li>
      <li>Stresses within about one characteristic size of the coupled
        surface reflect the coupling, not the part it replaces.</li>
      <li>A distributing point can be loaded but not supported; support a
        kinematic point instead.</li>
    </ul>

    <h2 id="references">References</h2>
    <ul>
      <li>Abaqus Analysis User’s Guide, “Coupling constraints”: kinematic and
        distributing coupling, and their weighting.</li>
      <li>MSC Nastran Quick Reference Guide, RBE2 and RBE3 elements.</li>
      <li>S. P. Timoshenko and J. N. Goodier, <em>Theory of Elasticity</em>,
        3rd ed., McGraw-Hill, 1970: torsion of rectangular bars
        (${tex("J = 0.1406 \\, a^4")} and ${tex("τ_{\\mathrm{max}} = T / (0.208 \\, a^3)")} for a square
        of side ${tex("a")}) and Saint-Venant's principle.</li>
      <li><a href="/theory/numerical-methods/loads-and-constraints/">Loads and
        constraints</a> and <a href="/theory/shells/solid-coupling/">solid–shell
        coupling</a> in this guide.</li>
    </ul>
  `,
};
