// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: Kirsch stress concentration at a hole, in a strip of finite width.

import { plateFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

// Howland's Kt on the gross stress for a hole in a long strip, by 2a/W.
const HOWLAND = [
  [0, 3.0],
  [0.1, 3.03],
  [0.2, 3.14],
  [0.3, 3.36],
  [0.4, 3.74],
  [0.5, 4.32],
];

/** The P2 series of the page's convergence study (errors in %). */
function p2Errors(study) {
  if (!study) throw new Error("plate-with-hole: the page needs its study");
  const p2 = study.series.find((s) => s.order === 2);
  if (!p2) throw new Error("plate-with-hole: the study has no P2 series");
  return p2.points.map((p) => p.errPct);
}

export default {
  description:
    "Kirsch's plate with a hole: stress concentration Kt = 3, Howland's 3.14 for a strip of finite width, and KoFEM's peak stress as the Results panel shows it.",
  figure: () => plateFigure({ model: "strip" }),
  intro: () => `
        <p>A small circular hole in a plate under tension raises the stress at
        its edge to three times the nominal value. Kirsch's solution (1898)
        for this stress concentration is the classic test of how well a
        solver resolves a stress peak, a harder target than a displacement,
        which is what the finite element method approximates most
        accurately.</p>`,
  theory: ({ tex, texBlock, inp }) => {
    const at = (s) => 1 + 1 / (2 * s * s) + 3 / (2 * s ** 4);
    const ratio = (2 * inp("a")) / (2 * inp("b"));
    const howland = HOWLAND.map(
      ([r, k]) => `${tex(k.toFixed(2))} at ${tex(r.toFixed(1))}`,
    ).join(", ");
    return `
        <p>Take an infinite plate under uniaxial tension ${tex("σ")} along
        ${tex("x")}, with a hole of radius ${tex("a")}. In polar coordinates
        ${tex("(r, θ)")} about the hole centre, with ${tex("θ")} measured from
        the load direction, Kirsch's solution of the plane elasticity problem
        gives the hoop stress</p>
        ${texBlock("σ_{θθ} = \\frac{σ}{2}\\left(1 + \\frac{a^2}{r^2}\\right) - \\frac{σ}{2}\\left(1 + \\frac{3 a^4}{r^4}\\right)\\cos 2θ.")}
        <p>On the edge of the hole, ${tex("r = a")}, the radial and shear
        stresses vanish because the surface is free, and</p>
        ${texBlock("σ_{θθ}(a, θ) = σ (1 - 2 \\cos 2θ).")}
        <p>This is largest at ${tex("θ = ±90°")}, the points A across the load
        direction, and the stress concentration factor is</p>
        ${texBlock("K_{\\mathrm{t}} = \\frac{σ_{\\mathrm{max}}}{σ} = 3.")}
        <p>At ${tex("θ = 0")} the edge is in compression, ${tex("σ_{θθ} = -σ")},
        although the plate is pulled. Along the transverse axis the stress
        decays quickly with the distance from the hole,</p>
        ${texBlock("σ_{xx}(0, y) = σ\\left(1 + \\frac{a^2}{2 y^2} + \\frac{3 a^4}{2 y^4}\\right),")}
        <p>to ${tex(`${at(2).toFixed(2)} σ`)} at ${tex("y = 2a")} and
        ${tex(`${at(4).toFixed(2)} σ`)} at ${tex("y = 4a")} (figure, right). At
        the edge it falls steeply, ${tex("\\mathrm{d}σ_{xx} / \\mathrm{d}y = -7 σ / a")}.
        The solution does not depend on Poisson's ratio, so it holds in
        plane stress and plane strain alike.</p>
        <p>A real plate has edges. In a long strip of width ${tex("W = 2b")}
        the load that the hole cannot carry has less room to flow around it,
        so the peak rises. Howland (1930) solved the strip. On the gross
        stress ${tex("σ")} at the ends his factor grows with ${tex("2a / W")}:
        ${howland}.</p>
        <p>This strip has ${tex(`2a / W = ${ratio.toFixed(1)}`)}, so its reference is
        ${tex("K_{\\mathrm{t}} = 3.14")}. Heywood's and Peterson's fits to
        later solutions give the same value. The strip has to be long for
        this: its ends must be far enough from the hole that the uniform end
        tension has become the strip's own stress field. Built as a square
        plate of the same width, this model reads about 3.3.</p>`;
  },
  model: ({ row, tex, inp }) => `
        <p>The strip is symmetric about ${tex("x = 0")}, about ${tex("y = 0")}
        and about its mid-plane, and so is the load. The model keeps one
        eighth: the quarter ${tex("x, y ≥ 0")}, upper half of the
        thickness. Each cut face gets a symmetry support that fixes only the
        displacement across it: ${tex("u_{x}")} on ${tex("x = 0")},
        ${tex("u_{y}")} on ${tex("y = 0")} and ${tex("u_{z}")} on the
        mid-plane. Together they stop every rigid-body motion and restrain
        nothing else, so the plate contracts freely, as in Kirsch's problem.
        A fixed end would not. The strip reaches
        ${tex(`L = ${inp("L") / inp("b")} b`)} on each side of the hole, and
        its thickness ${tex(`t = a / ${inp("a") / inp("t")}`)} keeps it in
        plane stress.</p>
        <p>Netgen meshes it with quadratic tetrahedra and a
        ${row.mesh.maxElementSize}&nbsp;mm maximum element size. The app has
        no element size per face, but Netgen puts at least two elements along
        every edge. The edge through the thickness at A is only
        ${inp("t") / 2}&nbsp;mm long, so the elements there are a few tenths
        of a millimetre, much finer than in the rest of the plate, where the
        stress hardly changes.</p>
        <p>The read-out is the one the Results panel shows. The solver gives
        one von Mises stress per element, at its centre, and the app averages
        these to the nodes. The hand check takes the largest nodal value on
        the hole face and divides it by ${tex("σ")}. At A the surface is free
        and the only stress is ${tex("σ_{θθ}")}, so there the von Mises
        stress equals ${tex("σ_{θθ}")}.</p>`,
  discussion: ({ row, pct, pctAbs, tex, url, study }) => {
    const errs = p2Errors(study);
    const lo = Math.min(...errs.map(Math.abs)),
      hi = Math.max(...errs.map(Math.abs));
    return `
        <p>KoFEM's ${tex("K_{\\mathrm{t}}")} differs from Howland's 3.14 by
        ${pct(row.errPct)}. The nodal average explains why it reads low. The
        elements around A have their centres a fraction of an element inside
        the plate, where the stress has already started to fall, and with
        the steep drop ${tex("7 σ / a")} even a small distance counts. Finer
        elements at A would move the centres closer to the edge.</p>
        <p>The mesh convergence study above changes only the maximum element
        size. With quadratic elements the result stays between
        ${pctAbs(lo, 1)} and ${pctAbs(hi, 1)} below 3.14 on every mesh,
        because the elements at A keep their size. That is why the band is
        ±${row.tolPct}&nbsp;%. Linear elements read several percent high on
        the same meshes: their constant stress per element is noisy where the
        stress changes fast. For a peak stress in a design, use quadratic
        elements and refine at the stress raiser until the peak stops
        changing. The <a href="${url("plate-with-hole-shell")}">shell
        page</a> models the same strip with linear shell triangles.</p>`;
  },
  references: [REF.kirsch, REF.howland, REF.timoshenkoGoodier, REF.peterson],
};
