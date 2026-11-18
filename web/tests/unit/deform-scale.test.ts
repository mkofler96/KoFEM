// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/deformScale.ts (KOF-383): the deformation scale is
// the real factor the displacements are multiplied by. "Auto" picks it so the
// largest displacement shows as a fifth of the model size; a manual factor is
// used as typed. The slider is logarithmic, with its left end at 0
// (undeformed). The browser path is covered by tests/deformation-scale.spec.ts.

import { describe, expect, test } from "bun:test";
import {
  appliedDeformFactor,
  autoDeformFactor,
  deformSliderMax,
  factorToSlider,
  formatDeformFactor,
  modelExtent,
  parseDeformFactor,
  sliderToFactor,
} from "../../src/lib/deformScale";

describe("modelExtent", () => {
  test("is the largest side of the node bounding box", () => {
    const nodes = [
      { x: 0, y: 0, z: 0 },
      { x: 1000, y: 100, z: -50 },
      { x: 10, y: -20, z: 50 },
    ];
    expect(modelExtent(nodes)).toBe(1000);
  });

  test("an empty mesh has extent 1", () => {
    expect(modelExtent([])).toBe(1);
  });
});

describe("autoDeformFactor", () => {
  test("draws the largest displacement component as a fifth of the model, to 3 significant digits", () => {
    // 0.2 · 1000 / 0.4762 = 419.99…, shown and applied as 420.
    const disp = [0, 0, 0, 0.4762, -0.01, 0.02];
    expect(autoDeformFactor(disp, 1000)).toBe(420);
  });

  test("the sign of a component does not matter", () => {
    expect(autoDeformFactor([0, -0.002, 0], 10)).toBe(1000);
  });

  test("a result without displacement is drawn at true scale", () => {
    expect(autoDeformFactor([0, 0, 0], 10)).toBe(1);
  });
});

describe("appliedDeformFactor", () => {
  const disp = [0, 0.002, 0];
  test("auto uses the automatic factor", () => {
    expect(appliedDeformFactor({ mode: "auto" }, disp, 10)).toBe(1000);
  });
  test("a manual factor is used as is, 0 included", () => {
    expect(appliedDeformFactor({ mode: "manual", factor: 1 }, disp, 10)).toBe(
      1,
    );
    expect(appliedDeformFactor({ mode: "manual", factor: 0 }, disp, 10)).toBe(
      0,
    );
    expect(
      appliedDeformFactor({ mode: "manual", factor: 2500.5 }, disp, 10),
    ).toBe(2500.5);
  });
  test("a negative or non-finite manual factor is refused", () => {
    expect(() =>
      appliedDeformFactor({ mode: "manual", factor: -1 }, disp, 10),
    ).toThrow();
    expect(() =>
      appliedDeformFactor({ mode: "manual", factor: Number.NaN }, disp, 10),
    ).toThrow();
  });
});

describe("the logarithmic slider", () => {
  test("its left end is 0 (undeformed) and one decade per unit above", () => {
    expect(sliderToFactor(0)).toBe(0);
    expect(sliderToFactor(1)).toBe(1);
    expect(sliderToFactor(2)).toBe(10);
    expect(sliderToFactor(4)).toBe(1000);
    expect(sliderToFactor(0.5)).toBe(0.316);
  });

  test("a dragged factor is rounded to 3 significant digits", () => {
    expect(sliderToFactor(4.0934)).toBe(1240);
  });

  test("factors map back to their slider position", () => {
    const max = deformSliderMax(1240);
    expect(factorToSlider(0, max)).toBe(0);
    expect(factorToSlider(1, max)).toBe(1);
    expect(factorToSlider(1000, max)).toBeCloseTo(4, 10);
    // Tiny factors stay right of the undeformed stop; huge ones clamp.
    expect(factorToSlider(1e-9, max)).toBeGreaterThan(0);
    expect(factorToSlider(1e12, max)).toBe(max);
  });

  test("reaches from true scale to well past the automatic factor", () => {
    // At least up to 10 000×, and a decade past the automatic factor.
    expect(sliderToFactor(deformSliderMax(5))).toBe(10000);
    expect(sliderToFactor(deformSliderMax(1240))).toBe(100000);
    expect(sliderToFactor(deformSliderMax(2.3e6))).toBeGreaterThanOrEqual(
      2.3e7,
    );
  });
});

describe("formatDeformFactor", () => {
  test("groups thousands with a space", () => {
    expect(formatDeformFactor(1240)).toBe("1 240");
    expect(formatDeformFactor(2_300_000)).toBe("2 300 000");
  });
  test("small factors keep their decimals", () => {
    expect(formatDeformFactor(0)).toBe("0");
    expect(formatDeformFactor(1)).toBe("1");
    expect(formatDeformFactor(0.316)).toBe("0.316");
    expect(formatDeformFactor(12.5)).toBe("12.5");
  });
});

describe("parseDeformFactor", () => {
  test("accepts 0 and positive numbers", () => {
    expect(parseDeformFactor("0")).toEqual({ factor: 0 });
    expect(parseDeformFactor(" 2500 ")).toEqual({ factor: 2500 });
    expect(parseDeformFactor("1e3")).toEqual({ factor: 1000 });
  });
  test("refuses empty, negative and non-numeric text", () => {
    expect(parseDeformFactor("")).toHaveProperty("error");
    expect(parseDeformFactor("-1")).toHaveProperty("error");
    expect(parseDeformFactor("abc")).toHaveProperty("error");
    expect(parseDeformFactor("Infinity")).toHaveProperty("error");
  });
});
