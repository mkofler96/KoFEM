// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Observed against expected convergence rates of the mesh-convergence studies
// on the example pages (KOF-399): the analysis in
// examples/validation/lib/rates.mjs on made-up studies with a known answer,
// and the gate CI applies to the published ones.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadFem } from "../support/wasm.mjs";
import studies from "../../../examples/validation/convergence.mjs";
import {
  RATE_LEVELS,
  RATE_MARGIN,
  analyseStudy,
  expectedRate,
  rateFailures,
} from "../../../examples/validation/lib/rates.mjs";

const fem = await loadFem();

// A study whose results follow φ = φ∞ + C·hᵖ exactly, on meshes whose element
// counts grow as h^(−d).
function madeUpStudy({ limit, order, coefficient, dimension, rateOrder }) {
  const levels = [8, 4, 2, 1.4];
  const points = levels.map((h) => ({
    mesh: `${h} mm`,
    elements: Math.round(1000 * (8 / h) ** dimension),
    fe: limit + coefficient * h ** rateOrder,
  }));
  const def = {
    id: "made-up",
    title: "Made-up study",
    dimension,
    expect: { readout: "energy" },
    series: [{ label: `P${order}`, order, levels }],
  };
  const published = { id: "made-up", series: [{ label: `P${order}`, points }] };
  return { def, published };
}

describe("expected rates", () => {
  test("an energy-type result converges at 2p on a smooth solution", () => {
    expect(expectedRate({ readout: "energy" }, 1, fem).rate).toBe(2);
    expect(expectedRate({ readout: "energy" }, 2, fem).rate).toBe(4);
  });

  test("a displacement at a point converges at p + 1", () => {
    expect(expectedRate({ readout: "point" }, 2, fem).rate).toBe(3);
  });

  test("averaged element-centre stresses converge at 1 for either order", () => {
    expect(expectedRate({ readout: "centroid-stress" }, 2, fem).rate).toBe(1);
  });

  test("a clamped edge caps the rate at 2λ whatever the order", () => {
    const corner = { angleDeg: 90, poisson: 0.3, where: "the clamped edges" };
    const linear = expectedRate({ readout: "energy", corner }, 1, fem);
    const quadratic = expectedRate({ readout: "energy", corner }, 2, fem);
    expect(linear.lambda).toBeCloseTo(0.7112, 3);
    expect(linear.rate).toBeCloseTo(2 * 0.7112, 3);
    expect(quadratic.rate).toBeCloseTo(linear.rate, 12);
    expect(quadratic.why).toContain("2λ");
  });

  test("an unknown read-out is refused", () => {
    expect(() => expectedRate({ readout: "peak" }, 1, fem)).toThrow(/readout/);
  });
});

describe("analyseStudy", () => {
  test("recovers the limit and the order of an exact power law", () => {
    const { def, published } = madeUpStudy({
      limit: 5,
      order: 2,
      coefficient: 0.01,
      dimension: 3,
      rateOrder: 1.6,
    });
    const result = analyseStudy(def, published, fem);
    expect(result.reference.value).toBeCloseTo(5, 8);
    expect(result.series[0].observed).toBeCloseTo(1.6, 5);
    expect(result.series[0].levels).toHaveLength(RATE_LEVELS);
  });

  test("measures the size of a slab's elements in its plane", () => {
    const { def, published } = madeUpStudy({
      limit: 1,
      order: 2,
      coefficient: -0.02,
      dimension: 2,
      rateOrder: 2,
    });
    expect(analyseStudy(def, published, fem).series[0].observed).toBeCloseTo(
      2,
      5,
    );
  });

  test("refuses a dimension the element counts contradict", () => {
    const { def, published } = madeUpStudy({
      limit: 1,
      order: 2,
      coefficient: 0.1,
      dimension: 2,
      rateOrder: 2,
    });
    expect(() =>
      analyseStudy({ ...def, dimension: 3 }, published, fem),
    ).toThrow(/2\.00-dimensional/);
  });

  test("a study without a rate must say why", () => {
    const { def, published } = madeUpStudy({
      limit: 1,
      order: 1,
      coefficient: 0.1,
      dimension: 3,
      rateOrder: 1,
    });
    expect(() =>
      analyseStudy({ ...def, expect: null }, published, fem),
    ).toThrow(/noRate/);
    expect(
      analyseStudy({ ...def, expect: null, noRate: "scatters" }, published, fem)
        .noRate,
    ).toBe("scatters");
  });

  test("flags a series that converges more slowly than theory allows", () => {
    // Energy-type result of quadratic elements, smooth: expected 4.
    const { def, published } = madeUpStudy({
      limit: 3,
      order: 2,
      coefficient: 0.05,
      dimension: 3,
      rateOrder: 4 - RATE_MARGIN - 0.5,
    });
    expect(rateFailures([def], [published], fem)).toEqual([
      expect.stringContaining("is below the expected 4.00"),
    ]);
  });
});

const published = JSON.parse(
  readFileSync(
    new URL("../../public/examples/results.json", import.meta.url),
    "utf8",
  ),
);

// The gate: every published study converges at least as fast as theory says,
// within the margin. A slower rate is a solver or element bug, or a study that
// has not reached its asymptotic range.
test("every published convergence study meets its expected rate", () => {
  expect(rateFailures(studies, published.convergence, fem)).toEqual([]);
});

// The pages show the rates stored with the points; they must be the ones the
// points and the current theory give.
test("the published rates are the ones their points give", () => {
  for (const def of studies) {
    const record = published.convergence.find((s) => s.id === def.id);
    const again = analyseStudy(def, record, fem);
    expect(record.rates.noRate).toBe(again.noRate);
    expect(record.rates.series.map((s) => s.label)).toEqual(
      again.series.map((s) => s.label),
    );
    record.rates.series.forEach((s, i) => {
      expect(s.observed).toBeCloseTo(again.series[i].observed, 9);
      expect(s.expected).toBeCloseTo(again.series[i].expected, 9);
      expect(s.why).toBe(again.series[i].why);
    });
  }
});
