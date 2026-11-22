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

// A study of two series whose results follow φ = φ∞ + C·hᵖ exactly, on
// meshes whose element counts grow as h^(−d). The quadratic series ends on a
// mesh fine enough to stand for φ∞: the reference.
function madeUpStudy({ dimension, linearRate, coefficient = 0.05 }) {
  const limit = 3;
  const level = (h, rate, c) => ({
    mesh: `${h} mm`,
    elements: Math.round(1000 * (8 / h) ** dimension),
    dofs: Math.round(500 * (8 / h) ** dimension),
    fe: limit + c * h ** rate,
  });
  const linear = [8, 4, 2, 1.4];
  const quadratic = [8, 4, 2, 0.25];
  const def = {
    id: "made-up",
    title: "Made-up study",
    dimension,
    expect: { readout: "energy" },
    series: [
      { label: "P1", order: 1, levels: linear },
      { label: "P2", order: 2, levels: quadratic },
    ],
  };
  const published = {
    id: "made-up",
    series: [
      {
        label: "P1",
        points: linear.map((h) => level(h, linearRate, coefficient)),
      },
      { label: "P2", points: quadratic.map((h) => level(h, 4, 1e-6)) },
    ],
  };
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
  test("measures the rate against the finest mesh of the highest order", () => {
    const { def, published } = madeUpStudy({ dimension: 3, linearRate: 1.6 });
    const result = analyseStudy(def, published, fem);
    expect(result.reference.series).toBe("P2");
    expect(result.reference.mesh).toBe("0.25 mm");
    const linear = result.series.find((s) => s.label === "P1");
    expect(linear.observed).toBeCloseTo(1.6, 3);
    expect(linear.levels).toEqual(["4 mm", "2 mm", "1.4 mm"]);
    // The reference series is fitted over its levels coarser than the reference.
    expect(result.series.find((s) => s.label === "P2").levels).toEqual([
      "8 mm",
      "4 mm",
      "2 mm",
    ]);
  });

  test("measures the size of a slab's elements in its plane", () => {
    const { def, published } = madeUpStudy({ dimension: 2, linearRate: 2 });
    const linear = analyseStudy(def, published, fem).series[0];
    expect(linear.observed).toBeCloseTo(2, 3);
  });

  test("refuses a dimension the element counts contradict", () => {
    const { def, published } = madeUpStudy({ dimension: 2, linearRate: 2 });
    expect(() =>
      analyseStudy({ ...def, dimension: 3 }, published, fem),
    ).toThrow(/2\.00-dimensional/);
  });

  test("gives no rate to a series whose error does not fall monotonically", () => {
    const { def, published } = madeUpStudy({ dimension: 3, linearRate: 1 });
    published.series[0].points[2].fe = published.series[0].points[1].fe + 0.5;
    const linear = analyseStudy(def, published, fem).series[0];
    expect(linear.observed).toBeNull();
    expect(linear.pass).toBe(true);
  });

  test("a study without a rate must say why", () => {
    const { def, published } = madeUpStudy({ dimension: 3, linearRate: 1 });
    expect(() =>
      analyseStudy({ ...def, expect: null }, published, fem),
    ).toThrow(/noRate/);
    expect(
      analyseStudy({ ...def, expect: null, noRate: "scatters" }, published, fem)
        .noRate,
    ).toBe("scatters");
  });

  test("flags a series that converges more slowly than theory allows", () => {
    // Energy-type result of linear elements, smooth: expected 2.
    const { def, published } = madeUpStudy({
      dimension: 3,
      linearRate: 2 - RATE_MARGIN - 0.4,
    });
    expect(rateFailures([def], [published], fem)).toEqual([
      expect.stringContaining(
        "P1: observed rate 1.35 is below the expected 2.00",
      ),
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
      if (again.series[i].observed === null) expect(s.observed).toBeNull();
      else expect(s.observed).toBeCloseTo(again.series[i].observed, 9);
      expect(s.expected).toBeCloseTo(again.series[i].expected, 9);
      expect(s.why).toBe(again.series[i].why);
    });
  }
});
