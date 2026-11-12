// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: Saint-Venant torsion of a square bar.

import { squareTorsionFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

// Roark's square-section constant, as the case computes it.
const BETA = 1 / 3 - 0.21 * (1 - 1 / 12);

export default {
  description:
    "Saint-Venant torsion of a square bar, θ = TL/(GK): warping, the Prandtl stress function, the torsion constant and KoFEM's result.",
  figure: () => squareTorsionFigure(),
  intro: () => `
        <p>Twisting a bar with a square section is the simplest torsion
        problem that the circular-shaft formula gets wrong. The sections do
        not stay plane: they warp out of their plane, and the bar is softer
        in torsion than its polar moment of inertia suggests. The case checks
        that KoFEM captures this 3-D behaviour.</p>`,
  theory: ({ tex, texBlock, n, pctAbs, row, inp }) => {
    const b = inp("b"),
      E = inp("E"),
      nu = inp("ν");
    const G = E / (2 * (1 + nu));
    const beta = BETA;
    return `
        <p>In a circular shaft the shear stress grows linearly with the radius
        and the torsional stiffness is ${tex("G J")}, with the polar moment
        ${tex("J")}. Saint-Venant's theory (1855) covers any section. Each
        section rotates rigidly in its own plane by an angle that grows
        linearly along the bar, ${tex("θ(x) = θ' x")}, and is free to warp
        axially by ${tex("u_{x} = θ' ω(y, z)")}, with a warping function
        ${tex("ω")} that depends on the shape of the section.</p>
        <p>The shear stresses follow from Prandtl's stress function
        ${tex("φ(y, z)")}, with ${tex("τ_{xy} = ∂φ / ∂z")} and
        ${tex("τ_{xz} = -∂φ / ∂y")}. Compatibility requires</p>
        ${texBlock("\\nabla^2 φ = -2 G θ' \\text{ in the section}, \\quad φ = 0 \\text{ on its boundary},")}
        <p>and the torque is twice the volume under ${tex("φ")}:</p>
        ${texBlock("T = 2 \\int_{A} φ \\,\\mathrm{d}A = G K θ'.")}
        <p>This defines the torsion constant ${tex("K")}. For a square of side
        ${tex("b")} the series solution gives ${tex("K ≈ 0.1406 b^4")}
        (Timoshenko and Goodier tabulate 0.141). The case uses Roark's
        closed-form fit for rectangles, evaluated for a square:</p>
        ${texBlock(`K = β b^4, \\quad β = \\frac{1}{3} - 0.21\\left(1 - \\frac{1}{12}\\right) = ${beta.toFixed(4)}.`)}
        <p>The polar moment of the square, ${tex("J = b^4 / 6 ≈ 0.1667 b^4")},
        would overestimate the stiffness by ${pctAbs((1 / 6 / beta - 1) * 100, 0)}.
        The free end rotates by</p>
        ${texBlock("θ = \\frac{T L}{G K}, \\quad G = \\frac{E}{2(1 + ν)}.")}
        <p>Here ${tex(`G = ${n(G / 1e3)}\\text{ GPa}`)},
        ${tex(`K = ${n(beta * b ** 4)}\\text{ mm}^4`)} and
        ${tex(`θ = ${n(row.reference)}\\text{ rad}`)}.</p>
        <p>The warping is largest at the corners and changes sign from one
        quadrant of the section to the next (inset in the figure). The
        largest shear stress is at the middle of each side, not at the
        corners, where it is zero.</p>`;
  },
  model: ({ tex }) => `
        <p>The beam is the STEP file a user imports, meshed by Netgen with
        quadratic tetrahedra; the clamp and the torque each sit on one whole
        CAD face. The torque is a moment load on the end face. The app turns
        it into one tangential force per node of the face's surface mesh,
        proportional to the node's distance ${tex("r")} from the centroid of
        those nodes and scaled so the net force is zero and the moment is
        ${tex("T")}. That is not the exact Saint-Venant stress distribution
        over a square, but by Saint-Venant's principle the difference only
        affects the region near the loaded end.</p>
        <p>The Results panel reads the twist as the mean in-plane rotation of
        the end face's nodes about the same centroid,
        ${tex("(y u_{z} - z u_{y}) / r^2")}.</p>`,
  discussion: ({ row, pct, pctAbs, tex, study }) => {
    const series = (order) => {
      const s = study.series.find((x) => x.order === order);
      if (!s)
        throw new Error(`beam-torsion study has no order-${order} series`);
      return s.points;
    };
    const errs = (points) => points.map((p) => pct(p.errPct)).join(" → ");
    return `
        <p>KoFEM's twist differs from the reference by ${pct(row.errPct)}.
        Linear tetrahedra would be far too stiff: in the convergence study
        above their error goes ${errs(series(1))} as the element size halves.
        A linear tetrahedron has constant strain, so it follows the shear
        that varies across a twisted section poorly and locks. The case
        therefore uses quadratic tetrahedra, which are within a few percent
        on every mesh (${errs(series(2))}).</p>
        <p>From 25&nbsp;mm down, the quadratic series comes down to the
        reference from above. Sections inside the bar rotate at the
        Saint-Venant rate to within a few tenths of a percent; the excess is
        on the loaded face itself. The torque reaches that face as point
        forces at its nodes, which deform it locally. The finer the mesh, the
        smaller each force and its local effect. The coarsest mesh, two
        elements across the section, lands close to the reference by chance,
        before this trend sets in.</p>
        <p>Two smaller effects remain in a converged result. Saint-Venant's
        solution assumes that every section warps freely, but the clamp
        holds the ${tex("x = 0")} section flat, which stiffens the bar near
        it. A square section warps little, so this costs only a few tenths
        of a percent. And Roark's fit for ${tex("β")} is larger than the
        series value 0.1406, so the reference is
        ${pctAbs((BETA / 0.1406 - 1) * 100)} low. The ±${row.tolPct}&nbsp;%
        band covers all three.</p>`;
  },
  references: [REF.timoshenkoGoodier, REF.roark, REF.gere],
};
