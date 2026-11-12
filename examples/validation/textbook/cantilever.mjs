// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: cantilever beam, linear tetrahedra. Shared beam theory with the
// quadratic cantilevers (cantilever-p2.mjs, cantilever-beam.mjs).

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

/** Euler–Bernoulli derivation, shared with the other cantilever pages. */
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

/** The published cantilever convergence study's P1 and P2 points. */
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
    "A cantilever with a tip load, δ = PL³/(3EI): Euler–Bernoulli derivation, shear locking of linear tetrahedra, mesh convergence and KoFEM's result.",
  opens: "Opens the model in the app, ready to solve.",
  figure: () => cantileverFigure({ div: null }),
  intro: () => `
        <p>A beam clamped at one end and loaded at the other is the standard
        bending benchmark. Bending is where simple solid elements struggle,
        so this case tests the element as much as the solver.</p>`,
  theory: beamTheory,
  model: ({ row, inp }) => `
        <p>The beam is the STEP file a user imports, meshed by Netgen with
        linear 4-node tetrahedra at a ${row.mesh.maxElementSize}&nbsp;mm
        maximum element size, about ${acrossDepth(inp, row.mesh.maxElementSize)}
        elements through the depth. The support and the load each sit on one
        whole CAD face. The tip load is a force on the end face, which the app
        integrates as a uniform traction.</p>`,
  discussion: ({ row, pct, study, inp, url }) => {
    const p1 = studySeries(study, 1);
    const p2 = studySeries(study, 2);
    const k = beam(inp);
    const last = p2[p2.length - 1];
    return `
        <p>KoFEM's deflection differs from the reference by
        ${pct(row.errPct)}: the linear elements are too stiff. The reason is
        <em>shear locking</em>. A linear tetrahedron has straight edges and
        the same strain everywhere inside it, so it can follow neither the
        curved shape of a bent piece of beam nor the strain that grows from
        the neutral axis to the surface. To bend at all, a patch of them also
        has to shear. In a slender beam the true shear strain is small, so
        this spurious shear stores strain energy that the real beam does not
        have, and the mesh is too stiff. The fewer elements span the depth,
        the worse it gets. Linear tetrahedra lock more than linear
        hexahedra, whose strain can vary inside the element, but Netgen
        fills any CAD shape with tetrahedra.</p>
        <p>Refining the mesh cures it slowly. In the convergence study above
        the linear-element error goes ${p1.map((p) => pct(p.errPct)).join(" → ")}
        as the maximum element size goes
        ${p1.map((p) => p.maxElementSize).join(" → ")}&nbsp;mm. An
        unstructured mesh does not refine in exact halves, so the steps are
        uneven.</p>
        <p>Quadratic elements can bend, so they do not lock; see the
        <a href="${url("cantilever-p2")}">quadratic tetrahedra</a> and the
        <a href="${url("cantilever-beam")}">cantilever that opens ready to
        run</a>. Their series levels off at ${pct(last.errPct)}. The shear
        deformation that Euler–Bernoulli theory leaves out would add
        ${pct((k.shear / k.bending) * 100)}, yet the 3-D result stays below
        that Timoshenko value: its fully clamped end face also stops the
        section from contracting sideways and from warping, which neither
        beam theory models.</p>`;
  },
  references: [REF.gere, REF.timoshenkoShear, REF.cmpw, REF.hughes],
};
