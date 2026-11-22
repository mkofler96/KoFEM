// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Observed against expected convergence rates for the mesh-convergence
// studies on the example pages (KOF-399). The arithmetic is the Rust
// module's (crates/kofem-fem/src/convergence.rs); this file decides which
// levels go into it and what theory expects.
//
// Method, per study:
//
//   1. Element size. Netgen meshes are unstructured and their levels do not
//      refine by a constant ratio, so a level's size is taken from its
//      element count, h ∝ N^(−1/d), with d the directions the mesh refines
//      in: 3 for a solid, 2 for a slab meshed one element thick at every
//      level (study.dimension, checked against the element counts).
//   2. Reference. The finest mesh of the highest-order series (an "overkill"
//      solution of the same model). Errors against it are discretisation
//      errors alone; the closed-form reference on the page also carries the
//      model's own difference from 3D elasticity (beam theory, plane stress),
//      which would flatten every rate. A finest mesh rather than a Richardson
//      extrapolation, because the quadratic series of several studies are
//      converged to a few parts in 10⁴, where the read-out's mesh-to-mesh noise
//      decides an extrapolated limit.
//   3. Observed rate. The slope of ln|error| against ln h, least squares,
//      over the RATE_LEVELS finest levels of each series that are coarser than
//      the reference. A series whose error does not fall monotonically over
//      them has not reached the range where a rate means anything; it gets no
//      rate, and the page says so.
//   4. Expected rate. What a priori theory gives for the read-out on a
//      quasi-uniform mesh: 2p for an energy-type quantity (a mean
//      displacement under the load it is conjugate to, an angle of twist) and
//      p+1 for a displacement at a point. Where a clamped face meets a free
//      face, the stress is singular along the edge, u ~ r^λ, and the rate
//      cannot exceed 2λ whatever p is; λ is the root of Williams' clamped–free
//      equation for that corner angle and Poisson's ratio. A load that is
//      itself refined with the mesh can cap it too (`loadCap`).
//
// CI fails when an observed rate falls short of the expected one by more than
// RATE_MARGIN.

/** Levels a rate is fitted over: the finest ones coarser than the reference. */
export const RATE_LEVELS = 3;
/** How far an observed rate may fall short of theory before CI fails. */
export const RATE_MARGIN = 0.25;
/** How far the element counts may imply another refinement dimension. */
const DIMENSION_TOLERANCE = 0.6;

const READOUTS = {
  energy: {
    smooth: (p) => 2 * p,
    why: (p) =>
      `an energy-type result converges at 2p = ${2 * p} on a smooth solution`,
  },
  point: {
    smooth: (p) => p + 1,
    why: (p) =>
      `a displacement at a point converges at p + 1 = ${p + 1} on a smooth solution`,
  },
};

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * The rate theory expects for one series of a study: the read-out's rate on a
 * smooth solution, capped by a singular clamped–free corner (`corner`) and by
 * a load that is itself refined with the mesh (`loadCap`), whichever is
 * lowest.
 * @returns {{ rate: number, smooth: number, lambda: number | null, why: string }}
 */
export function expectedRate(expect, order, fem) {
  const readout = READOUTS[expect?.readout];
  if (!readout)
    throw new Error(
      `expected rate: readout must be one of ${Object.keys(READOUTS).join(", ")}, got ${JSON.stringify(expect?.readout)}`,
    );
  const smooth = readout.smooth(order);
  const caps = [];
  let lambda = null;
  if (expect.corner) {
    const { angleDeg, poisson, where } = expect.corner;
    if (!(angleDeg > 0) || typeof where !== "string")
      throw new Error(
        "expected rate: a corner needs angleDeg > 0, poisson and where",
      );
    lambda = fem.clampedFreeWedgeExponent((angleDeg * Math.PI) / 180, poisson);
    caps.push({
      rate: 2 * lambda,
      why: `${where} (clamped meeting free at ${round2(angleDeg)}°, ν = ${round2(poisson)}) are singular, u ~ r^λ with λ = ${round2(lambda)}, which caps it at 2λ = ${round2(2 * lambda)}`,
    });
  }
  if (expect.loadCap) {
    const { rate, why } = expect.loadCap;
    if (!(rate > 0) || typeof why !== "string")
      throw new Error("expected rate: a load cap needs rate > 0 and why");
    caps.push({ rate, why: `${why}, which caps it at ${rate}` });
  }
  const binding = caps.filter((c) => c.rate < smooth);
  const rate = Math.min(smooth, ...caps.map((c) => c.rate));
  const why = binding.length
    ? `${readout.why(order)}, but ${binding.map((c) => c.why).join("; and ")}`
    : readout.why(order);
  return { rate, smooth, lambda, why };
}

// The refinement dimension the fitted levels imply, from the coarsest to the
// finest of them: N grows as h^(−d). Over one small step Netgen's element
// counts are too noisy to say.
function impliedDimension(fit, levels) {
  const [first, last] = [fit[0], fit[fit.length - 1]];
  return (
    Math.log(last.point.elements / first.point.elements) /
    Math.log(levels[first.index] / levels[last.index])
  );
}

/**
 * Observed and expected rates of one study, from its published points.
 * @param def        the study's definition (convergence.mjs)
 * @param published  the study's record (results.json `convergence[]`)
 */
export function analyseStudy(def, published, fem) {
  const where = `convergence study "${def.id}"`;
  if (def.expect === null) {
    if (typeof def.noRate !== "string" || def.noRate === "")
      throw new Error(`${where}: expect is null, so noRate must say why`);
    return { reference: null, series: [], noRate: def.noRate };
  }
  if (![2, 3].includes(def.dimension))
    throw new Error(`${where}: dimension must be 2 or 3`);
  const records = def.series.map((s) => {
    const record = published.series.find((r) => r.label === s.label);
    if (!record) throw new Error(`${where}: no published series "${s.label}"`);
    if (record.points.length !== s.levels.length)
      throw new Error(
        `${where}, ${s.label}: ${record.points.length} published levels for ${s.levels.length} defined`,
      );
    return { def: s, record };
  });

  // The reference: the finest level of the highest-order series.
  const top = records.reduce((a, b) => (b.def.order > a.def.order ? b : a));
  const finest = top.record.points[top.record.points.length - 1];
  const reference = {
    series: top.def.label,
    mesh: finest.mesh,
    dofs: finest.dofs,
    value: finest.fe,
  };

  const series = records.map(({ def: s, record }) => {
    const candidates = record.points
      .map((point, index) => ({ point, index }))
      .filter(({ point }) => point !== finest);
    if (candidates.length < RATE_LEVELS)
      throw new Error(
        `${where}, ${s.label}: a rate needs ${RATE_LEVELS} levels coarser than the reference, the study has ${candidates.length}`,
      );
    const fit = candidates.slice(-RATE_LEVELS);
    const implied = impliedDimension(fit, s.levels);
    if (Math.abs(implied - def.dimension) > DIMENSION_TOLERANCE)
      throw new Error(
        `${where}, ${s.label}: the fitted levels refine as a ${implied.toFixed(2)}-dimensional mesh, not ${def.dimension}D — set the study's dimension or its levels`,
      );
    const sizes = Array.from(
      fem.relativeElementSizes(
        Uint32Array.from(fit.map(({ point }) => point.elements)),
        def.dimension,
      ),
    );
    const errors = fit.map(({ point }) => point.fe - reference.value);
    const magnitudes = errors.map(Math.abs);
    const monotone = magnitudes.every(
      (e, k) => k === 0 || e < magnitudes[k - 1],
    );
    let observed = null;
    if (monotone) {
      const rate = fem.fitConvergenceRate(
        Float64Array.from(sizes),
        Float64Array.from(errors),
      );
      observed = rate.rate;
      rate.free();
    }
    const expected = expectedRate(def.expect, s.order, fem);
    return {
      label: s.label,
      order: s.order,
      levels: fit.map(({ point }) => point.mesh),
      sizes,
      relErrors: errors.map((e) => e / reference.value),
      observed,
      expected: expected.rate,
      why: expected.why,
      pass: observed === null || observed >= expected.rate - RATE_MARGIN,
    };
  });
  if (series.every((s) => s.observed === null))
    throw new Error(
      `${where}: no series converges monotonically on its fitted levels, so the study has no rate — refine its levels, or set expect: null with noRate`,
    );
  return { reference, series };
}

/** Every study whose observed rate falls short of theory, as messages. */
export function rateFailures(defs, publishedStudies, fem) {
  const out = [];
  for (const def of defs) {
    const published = publishedStudies.find((s) => s.id === def.id);
    if (!published) {
      out.push(`convergence study "${def.id}" is not published`);
      continue;
    }
    for (const s of analyseStudy(def, published, fem).series)
      if (!s.pass)
        out.push(
          `${def.title}, ${s.label}: observed rate ${s.observed.toFixed(2)} is below the expected ${s.expected.toFixed(2)} by more than ${RATE_MARGIN}`,
        );
  }
  return out;
}
