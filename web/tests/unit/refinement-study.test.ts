// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for the mesh refinement study's arithmetic (src/lib/refinementStudy.ts,
// KOF-401): the element sizes of each level, the size the next level would
// reach, and whether the levels' results have converged.

import { describe, expect, test } from "bun:test";
import {
  assessConvergence,
  CONVERGED_TOLERANCE,
  levelSizes,
  nextLevelNodes,
  REFINEMENT_RATIO,
  type StudyLevel,
} from "../../src/lib/refinementStudy";

const ratio = REFINEMENT_RATIO;
const base = { max: 8, min: 0.8, regions: { 2: 4 } };

function level(
  k: number,
  maxDisplacement: number,
  maxVonMises: number | null,
): StudyLevel {
  return {
    sizes: levelSizes(base, k),
    nodes: Math.round(1000 * ratio ** (3 * k)),
    elements: Math.round(5000 * ratio ** (3 * k)),
    maxDisplacement,
    maxVonMises,
  };
}

describe("levelSizes", () => {
  test("level 0 is the base mesh", () => {
    expect(levelSizes(base, 0)).toEqual(base);
  });

  test("each level divides every size by the refinement ratio", () => {
    const fine = levelSizes(base, 2);
    expect(fine.max).toBeCloseTo(8 / ratio ** 2, 12);
    expect(fine.min).toBeCloseTo(0.8 / ratio ** 2, 12);
    expect(fine.regions[2]).toBeCloseTo(4 / ratio ** 2, 12);
  });

  test("the ratio halves the element size in two levels", () => {
    expect(ratio ** 2).toBeCloseTo(2, 12);
  });

  test("a negative level is refused", () => {
    expect(() => levelSizes(base, -1)).toThrow(/level/);
  });
});

describe("nextLevelNodes", () => {
  test("a solid mesh grows with the cube of the ratio", () => {
    expect(nextLevelNodes(1000, 3)).toBeCloseTo(1000 * ratio ** 3, 6);
  });

  test("a shell mesh grows with the square of the ratio", () => {
    expect(nextLevelNodes(1000, 2)).toBeCloseTo(2000, 6);
  });
});

describe("assessConvergence", () => {
  test("needs at least two levels", () => {
    expect(() => assessConvergence([level(0, 1, 1)])).toThrow(/two levels/);
  });

  test("lists each level's change from the level before", () => {
    const assessment = assessConvergence([
      level(0, 1.0, 100),
      level(1, 1.1, 110),
      level(2, 1.15, 112),
    ]);
    expect(assessment.displacementChanges[0]).toBeNull();
    expect(assessment.displacementChanges[1]).toBeCloseTo(0.1, 12);
    expect(assessment.displacementChanges[2]).toBeCloseTo(0.05 / 1.1, 12);
    expect(assessment.stressChanges[0]).toBeNull();
    expect(assessment.stressChanges[1]).toBeCloseTo(0.1, 12);
    expect(assessment.stressChanges[2]).toBeCloseTo(2 / 110, 12);
  });

  // f(h) = f∞ − C·h²: second-order convergence, as linear elements give for
  // displacement. Richardson extrapolation recovers f∞ and the order exactly.
  test("monotone convergence extrapolates to the exact value and its order", () => {
    const exact = 2.0;
    const disp = (k: number) => exact - 0.5 * (1 / ratio ** k) ** 2;
    const assessment = assessConvergence([
      level(0, disp(0), 50),
      level(1, disp(1), 50),
      level(2, disp(2), 50),
    ]);
    expect(assessment.method).toBe("richardson");
    expect(assessment.observedOrder).toBeCloseTo(2, 9);
    expect(assessment.extrapolated).toBeCloseTo(exact, 9);
    expect(assessment.estimatedError).toBeCloseTo((exact - disp(2)) / exact, 9);
  });

  test("converged when the estimated error is under the tolerance", () => {
    const exact = 2.0;
    const disp = (k: number) => exact - 0.05 * (1 / ratio ** k) ** 2;
    const assessment = assessConvergence([
      level(0, disp(0), 50),
      level(1, disp(1), 50),
      level(2, disp(2), 50),
    ]);
    expect(assessment.estimatedError).toBeLessThan(CONVERGED_TOLERANCE);
    expect(assessment.converged).toBe(true);
  });

  test("not converged when the estimated error is over the tolerance", () => {
    const exact = 2.0;
    const disp = (k: number) => exact - 1.0 * (1 / ratio ** k) ** 2;
    const assessment = assessConvergence([
      level(0, disp(0), 50),
      level(1, disp(1), 50),
      level(2, disp(2), 50),
    ]);
    expect(assessment.estimatedError).toBeGreaterThan(CONVERGED_TOLERANCE);
    expect(assessment.converged).toBe(false);
  });

  // Small changes that grow are not convergence: the last change is the only
  // honest estimate, and the levels say nothing about the order.
  test("non-monotone levels fall back to the last change", () => {
    const assessment = assessConvergence([
      level(0, 1.0, 50),
      level(1, 1.005, 50),
      level(2, 1.0151, 50),
    ]);
    expect(assessment.method).toBe("last-change");
    expect(assessment.observedOrder).toBeNull();
    expect(assessment.extrapolated).toBeNull();
    expect(assessment.estimatedError).toBeCloseTo(0.0101 / 1.005, 12);
    expect(assessment.converged).toBe(true);
  });

  test("two levels judge on their change", () => {
    const assessment = assessConvergence([
      level(0, 1.0, 50),
      level(1, 1.1, 50),
    ]);
    expect(assessment.method).toBe("last-change");
    expect(assessment.estimatedError).toBeCloseTo(0.1, 12);
    expect(assessment.converged).toBe(false);
  });

  test("identical levels are converged", () => {
    const assessment = assessConvergence([
      level(0, 1.0, 50),
      level(1, 1.0, 50),
      level(2, 1.0, 50),
    ]);
    expect(assessment.estimatedError).toBe(0);
    expect(assessment.converged).toBe(true);
  });

  test("a zero displacement on the finest level is refused", () => {
    expect(() =>
      assessConvergence([level(0, 1.0, 50), level(1, 0, 50)]),
    ).toThrow(/zero/);
  });

  // σ ~ h^-0.4 at a re-entrant corner: the peak grows at every refinement.
  test("a peak stress that keeps rising is flagged as a likely singularity", () => {
    const sigma = (k: number) => 100 * (1 / ratio ** k) ** -0.4;
    const assessment = assessConvergence([
      level(0, 1.0, sigma(0)),
      level(1, 1.0, sigma(1)),
      level(2, 1.0, sigma(2)),
    ]);
    expect(assessment.stressRising).toBe(true);
  });

  test("a peak stress that settles is not flagged", () => {
    const assessment = assessConvergence([
      level(0, 1.0, 100),
      level(1, 1.0, 104),
      level(2, 1.0, 105),
    ]);
    expect(assessment.stressRising).toBe(false);
  });

  test("no stress on a level means no stress verdict", () => {
    const assessment = assessConvergence([
      level(0, 1.0, null),
      level(1, 1.0, null),
    ]);
    expect(assessment.stressChanges).toEqual([null, null]);
    expect(assessment.stressRising).toBe(false);
  });
});
