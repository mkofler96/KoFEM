// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Case page text: Kirsch stress concentration at a hole.

import { plateFigure } from "../lib/figures.mjs";
import { plateMesh } from "../cases/plate-with-hole.mjs";
import { REF } from "./refs.mjs";

/** Kirsch's stresses (per unit σ) at polar position (r, θ), hole radius a. */
function kirsch(r, th, a) {
  const q = (a * a) / (r * r);
  const c = Math.cos(2 * th),
    s = Math.sin(2 * th);
  const rr = 0.5 * (1 - q) + 0.5 * (1 - 4 * q + 3 * q * q) * c;
  const tt = 0.5 * (1 + q) - 0.5 * (1 + 3 * q * q) * c;
  const rt = -0.5 * (1 + 2 * q - 3 * q * q) * s;
  return { rr, tt, rt };
}

const vonMises = ({ rr, tt, rt }) =>
  Math.sqrt(rr * rr + tt * tt - rr * tt + 3 * rt * rt);

/**
 * Where the case samples the peak: the centre of a first-ring element next
 * to θ = 90°. The O-grid's ring i sits at s = (i/nr)^grade between the hole
 * and the square edge, which on the transverse axis is b − a away.
 */
function firstRingCentre() {
  const { a, b, nr, nth, grade } = plateMesh;
  if (nth % 4 !== 0)
    throw new Error("plate mesh: θ = 90° must be a node line (nth % 4 = 0)");
  const r = a + ((b - a) * (1 / nr) ** grade) / 2;
  const th = Math.PI / 2 - Math.PI / nth;
  return { r, th, sv: vonMises(kirsch(r, th, a)) };
}

export default {
  description:
    "Kirsch's plate with a hole: stress concentration Kt = 3, the stress field around the hole, and how KoFEM's element stresses resolve the peak.",
  figure: () => plateFigure(),
  intro: () => `
        <p>A small circular hole in a plate under tension raises the stress at
        its edge to three times the nominal value. Kirsch's solution (1898)
        for this stress concentration is the classic test of how well a
        solver resolves a stress peak, a harder target than a displacement,
        which is what the finite element method approximates most
        accurately.</p>`,
  theory: ({ tex, texBlock }) => {
    const at = (s) => 1 + 1 / (2 * s * s) + 3 / (2 * s ** 4);
    return `
        <p>Take an infinite plate under uniaxial tension ${tex("σ")} along
        ${tex("x")}, with a hole of radius ${tex("a")}. In polar coordinates
        ${tex("(r, θ)")} about the hole centre, with ${tex("θ")} measured from
        the load direction, Kirsch's solution of the plane elasticity problem
        gives the hoop stress</p>
        ${texBlock("σ_{θθ} = \\frac{σ}{2}\\left(1 + \\frac{a^2}{r^2}\\right) - \\frac{σ}{2}\\left(1 + \\frac{3 a^4}{r^4}\\right)\\mathrm{cos}\\, 2θ.")}
        <p>On the edge of the hole, ${tex("r = a")}, the radial and shear
        stresses vanish because the surface is free, and</p>
        ${texBlock("σ_{θθ}(a, θ) = σ (1 - 2 \\mathrm{cos}\\, 2θ).")}
        <p>This is largest at ${tex("θ = ±90°")}, the points A across the load
        direction, and the stress concentration factor is</p>
        ${texBlock("K_{\\mathrm{t}} = \\frac{σ_{\\mathrm{max}}}{σ} = 3.")}
        <p>At ${tex("θ = 0")} the edge is in compression, ${tex("σ_{θθ} = -σ")},
        although the plate is pulled. Along the transverse axis the stress
        decays quickly with the distance from the hole,</p>
        ${texBlock("σ_{xx}(0, y) = σ\\left(1 + \\frac{a^2}{2 y^2} + \\frac{3 a^4}{2 y^4}\\right),")}
        <p>to ${tex(`${at(2).toFixed(2)} σ`)} at ${tex("y = 2a")} and
        ${tex(`${at(4).toFixed(2)} σ`)} at ${tex("y = 4a")} (figure, right). At
        the edge it falls steeply, ${tex("\\mathrm{d}σ_{xx} / \\mathrm{d}y = -7 σ / a")}.</p>
        <p>The solution does not depend on Poisson's ratio, so it holds in
        plane stress and plane strain alike. A plate of finite half-width
        ${tex("b")} raises ${tex("K_{\\mathrm{t}}")} slightly; for ${tex("a / b = 0.1")},
        as here, by about 1&nbsp;% (Peterson's), so ${tex("K_{\\mathrm{t}} = 3")} is a
        good reference.</p>`;
  },
  model: ({ tex }) => {
    const { nr, nth } = plateMesh;
    return `
        <p>The O-grid has ${nr} rings of ${nth} elements, graded so the rings
        are thinnest at the hole, with one element through the thickness.
        KoFEM reports one von Mises stress per element, at its centre; the
        case takes the largest value in the ring around the hole and divides
        it by ${tex("σ")}. At A the surface is free and the only stress is
        ${tex("σ_{θθ}")}, so there the von Mises stress equals
        ${tex("σ_{θθ}")} and its peak is ${tex("3σ")}.</p>`;
  },
  discussion: ({ row, pct, pctAbs, tex }) => {
    const c = firstRingCentre();
    const deg = (c.th * 180) / Math.PI;
    return `
        <p>KoFEM's ${tex("K_{\\mathrm{t}}")} differs from 3 by ${pct(row.errPct)}. Two effects
        meet here. First, the measured stress is not the stress at the edge
        but at the centre of the first element, a small distance away, where
        the stress has already started to fall. Kirsch's solution at that
        point, ${tex(`r = ${c.r.toFixed(3)} a`)} and
        ${tex(`θ = ${deg.toFixed(1)}°`)}, gives a von Mises stress of
        ${tex(`${c.sv.toFixed(2)} σ`)}, ${pctAbs((1 - c.sv / 3) * 100, 1)} below
        the peak. Even exact element stresses could not reach 3 with this
        measure.</p>
        <p>Second, element stresses carry their own discretisation error.
        Stress comes from derivatives of the displacement field, so it
        converges more slowly than the displacement does; here it lands above
        the exact value at the element centre. The published ${row.fe.toFixed(2)}
        is the net of both. That is why this case has a wider ±${row.tolPct}&nbsp;%
        band. Treat it as a check that the peak is in the right place and of
        the right size. To resolve a peak stress in a design, refine the mesh
        at the stress raiser until the peak stops changing.</p>`;
  },
  references: [REF.kirsch, REF.timoshenkoGoodier, REF.peterson],
};
