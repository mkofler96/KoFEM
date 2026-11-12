// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the cantilever beam, quadratic tetrahedra at 25 mm
// (cases/cantilever-beam.mjs), with the P1-vs-P2 convergence study.

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

/** The Euler–Bernoulli derivation of δ = −P·L³/(3·E·I). */
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
        <p>For this beam ${tex(`I = ${n(k.I)}\\text{ mm}^4`)} and
        ${tex(`δ = ${n(-k.bending)}\\text{ mm}`)}.</p>
        <p>Timoshenko beam theory adds the shear deformation that
        Euler–Bernoulli leaves out. For a cantilever with a tip load it adds
        a second term,</p>
        ${texBlock("δ_{\\mathrm{s}} = -\\frac{P L}{κ G A}, \\quad κ = \\frac{5}{6}, \\quad G = \\frac{E}{2(1 + ν)},")}
        <p>which is ${pctAbs((k.shear / k.bending) * 100)} of the bending term
        for this beam (span ten times the depth). A converged 3-D solid model
        should therefore deflect slightly more than
        ${tex("P L^3 / (3 E I)")}.</p>`;
}

/** The points of the convergence study's P1 or P2 series. */
export const studySeries = (study, order) => {
  const s = study.series.find((x) => x.order === order);
  if (!s) throw new Error(`cantilever study has no order-${order} series`);
  return s.points;
};

/** The study point of a series at one max element size (mm). */
export const studyPoint = (points, maxElementSize) => {
  const p = points.find((x) => x.maxElementSize === maxElementSize);
  if (!p)
    throw new Error(
      `cantilever study has no ${maxElementSize} mm point in this series`,
    );
  return p;
};

/** About how many elements of max size `size` (mm) span the depth h. */
export const acrossDepth = (inp, size) => Math.round(inp("b × h")[1] / size);

export default {
  description:
    "A cantilever with a tip load, δ = PL³/(3EI): Euler–Bernoulli derivation, why linear tetrahedra lock in bending, mesh convergence of linear and quadratic elements, and KoFEM's result.",
  figure: () => cantileverFigure(),
  intro: () => `
        <p>A beam clamped at one end and loaded at the other is the standard
        bending benchmark. Bending is where simple solid elements struggle,
        so this case tests the element as much as the solver. Press Run, and
        the Results panel compares the tip deflection with the hand
        formula.</p>`,
  theory: beamTheory,
  model: ({ row, tex, inp }) => `
        <p>The beam is the STEP file a user imports, meshed by Netgen with a
        ${row.mesh.maxElementSize}&nbsp;mm maximum element size, about
        ${acrossDepth(inp, row.mesh.maxElementSize)} elements through the
        depth. The elements are quadratic tetrahedra with 10 nodes, four at
        the corners and six at the edge midpoints, so an element can curve
        and its strain can vary inside it. The support and the load are each
        one CAD face, picked with one click, so they stay on the model when
        you change the element size and mesh it again. The tip load is a
        force on the end face, which the app integrates as a uniform
        traction. The deflection is the mean ${tex("u_{y}")} of the loaded
        face, which is what the app's hand check reads.</p>`,
  discussion: ({ row, pct, study, inp }) => {
    const p1 = studySeries(study, 1);
    const p2 = studySeries(study, 2);
    const k = beam(inp);
    const size = row.mesh.maxElementSize;
    const last = p2[p2.length - 1];
    return `
        <p>KoFEM's tip deflection differs from the Euler–Bernoulli value by
        ${pct(row.errPct)}; the quadratic series in the convergence study
        levels off at ${pct(last.errPct)}. The shear deformation that
        Euler–Bernoulli theory leaves out would add
        ${pct((k.shear / k.bending) * 100)}, yet the 3-D result stays below
        that Timoshenko value: its fully clamped end face also stops the
        section from contracting sideways and from warping, which neither
        beam theory models.</p>
        <p>The example uses quadratic elements because linear tetrahedra
        <em>lock</em> in bending. A linear tetrahedron has straight edges and
        the same strain everywhere inside it, so a patch of them can only
        bend by also shearing. That spurious shear stores energy the real
        beam does not have, and the mesh is too stiff: on this
        ${size}&nbsp;mm mesh linear tetrahedra give
        ${pct(studyPoint(p1, size).errPct)}, and still
        ${pct(studyPoint(p1, size / 2).errPct)} at ${size / 2}&nbsp;mm.
        Quadratic elements curve, so they bend without parasitic shear. For
        bending-dominated parts they give more accuracy per unknown.</p>`;
  },
  references: [
    REF.gere,
    REF.timoshenkoShear,
    REF.schoeberl,
    REF.cmpw,
    REF.hughes,
  ],
};
