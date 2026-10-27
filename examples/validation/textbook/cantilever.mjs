// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Case page text: cantilever beam, linear elements. Shared beam theory with the
// P2 case (cantilever-p2.mjs).

import { cantileverFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

/** Beam constants from the case inputs: I, G, A and the shear-term ratio. */
export function beam(inp) {
  const [b, h] = inp("b × h");
  const E = inp("E"),
    nu = inp("ν"),
    L = inp("L"),
    P = inp("P");
  const I = (b * h ** 3) / 12;
  const G = E / (2 * (1 + nu));
  const A = b * h;
  const kappa = 5 / 6;
  const bending = (P * L ** 3) / (3 * E * I);
  const shear = (P * L) / (kappa * G * A);
  return { b, h, E, nu, L, P, I, G, A, bending, shear };
}

/** Euler–Bernoulli derivation, shared with the P2 case page. */
export function beamTheory({ tex, texBlock, n, pctAbs, inp }) {
  const k = beam(inp);
  return `
        <p>Euler–Bernoulli beam theory assumes that cross-sections stay plane
        and perpendicular to the deformed axis, which neglects shear
        deformation. Take ${tex("w(x)")} as the deflection, positive upwards,
        with the load ${tex("P")} acting downwards at the tip. Equilibrium of
        the part beyond a section ${tex("x")} gives the bending moment</p>
        ${texBlock("M(x) = -P (L - x),")}
        <p>and the curvature is proportional to it:</p>
        ${texBlock("E I \\frac{\\mathrm{d}^2 w}{\\mathrm{d}x^2} = M(x), \\quad I = \\frac{b h^3}{12}.")}
        <p>Integrating twice with the clamp conditions ${tex("w(0) = 0")} and
        ${tex("\\frac{\\mathrm{d}w}{\\mathrm{d}x}(0) = 0")} gives the deflection
        curve</p>
        ${texBlock("w(x) = -\\frac{P x^2}{6 E I}(3 L - x),")}
        <p>and at the tip</p>
        ${texBlock("δ = w(L) = -\\frac{P L^3}{3 E I}.")}
        <p>For this beam ${tex(`I = ${n(k.I)}\\text{ m}^4`)} and
        ${tex(`δ = ${n(-k.bending)}\\text{ m}`)}.</p>
        <p>Timoshenko beam theory adds the shear deformation that
        Euler–Bernoulli leaves out. For a cantilever with a tip load it adds
        a second term,</p>
        ${texBlock("δ_{\\mathrm{s}} = -\\frac{P L}{κ G A}, \\quad κ = \\frac{5}{6}, \\quad G = \\frac{E}{2(1 + ν)},")}
        <p>which is ${pctAbs((k.shear / k.bending) * 100)} of the bending term
        for this beam (span ten times the depth). A converged 3-D solid model
        should therefore deflect slightly more than
        ${tex("P L^3 / (3 E I)")}.</p>`;
}

/** The published cantilever convergence study's P1 and P2 points. */
export const studySeries = (study, order) => {
  const s = study.series.find((x) => x.order === order);
  if (!s) throw new Error(`cantilever study has no order-${order} series`);
  return s.points;
};

export default {
  description:
    "A cantilever with a tip load, δ = PL³/(3EI): Euler–Bernoulli derivation, shear locking of linear hexahedra, mesh convergence and KoFEM's result.",
  figure: ({ page }) => cantileverFigure({ div: page.grid }),
  intro: () => `
        <p>A beam clamped at one end and loaded at the other is the standard
        bending benchmark. Bending is where simple solid elements struggle,
        so this case tests the element as much as the solver.</p>`,
  theory: beamTheory,
  model: () => `
        <p>The beam is meshed with linear 8-node hexahedra, the fast
        interactive default. Each element is a cube with sides one quarter of
        the beam depth.</p>`,
  discussion: ({ row, pct, study, inp }) => {
    const p1 = studySeries(study, 1);
    const p2 = studySeries(study, 2);
    const k = beam(inp);
    const last = p2[p2.length - 1];
    return `
        <p>KoFEM's deflection differs from the reference by
        ${pct(row.errPct)}: the linear elements are too stiff. The reason is <em>shear locking</em>. The
        edges of a linear hexahedron stay straight, so it cannot take the
        curved shape of a bent piece of beam; to bend at all, it has to shear.
        In a beam under pure bending the true shear strain is zero, so this
        spurious, parasitic shear stores strain energy that the real beam
        does not have, and the element is too stiff. The longer the element
        compared with the depth it spans, the worse it gets.</p>
        <p>Refining the mesh cures it slowly. In the convergence study below
        the linear-element error goes ${p1.map((p) => pct(p.errPct)).join(" → ")}
        as the element size halves, approaching a factor of four per step: the
        second-order convergence of displacements with linear elements, once
        locking is under control.</p>
        <p>Quadratic elements can bend, so they do not lock; see the
        <a href="/validation/cantilever-p2/">P2 case</a>. Their series settles
        near ${pct(last.errPct)}, above the reference. About
        ${pct((k.shear / k.bending) * 100)} of
        that is the shear deformation that Euler–Bernoulli theory leaves out.
        The rest comes from the 3-D stress state at the clamped root and the
        loaded end.</p>`;
  },
  references: [REF.gere, REF.timoshenkoShear, REF.cmpw, REF.hughes],
};
