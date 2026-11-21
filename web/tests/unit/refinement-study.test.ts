// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for the mesh refinement study's arithmetic (src/lib/refinementStudy.ts,
// KOF-401): the element sizes of each level, the size the next level would
// reach, and whether the levels' results have converged.

import { describe, expect, test } from "bun:test";
import {
  assessConvergence,
  checkLevelDisplacement,
  DEFAULT_REFINEMENT_INPUT,
  DEFAULT_REFINEMENT_SETTINGS,
  levelSizes,
  nextLevelNodes,
  parseRefinementSettings,
  studyFingerprint,
  type RefinementSettings,
  type StudyLevel,
} from "../../src/lib/refinementStudy";

const settings = DEFAULT_REFINEMENT_SETTINGS;
const { ratio } = settings;
const assess = (levels: StudyLevel[], with_: RefinementSettings = settings) =>
  assessConvergence(levels, with_);
const base = { max: 8, min: 0.8, regions: { 2: 4 } };

function level(
  k: number,
  maxDisplacement: number,
  maxVonMises: number | null,
): StudyLevel {
  return {
    sizes: levelSizes(base, k, ratio),
    nodes: Math.round(1000 * ratio ** (3 * k)),
    elements: Math.round(5000 * ratio ** (3 * k)),
    maxDisplacement,
    maxVonMises,
  };
}

describe("levelSizes", () => {
  test("level 0 is the base mesh", () => {
    expect(levelSizes(base, 0, ratio)).toEqual(base);
  });

  test("each level divides every size by the refinement ratio", () => {
    const fine = levelSizes(base, 2, ratio);
    expect(fine.max).toBeCloseTo(8 / ratio ** 2, 12);
    expect(fine.min).toBeCloseTo(0.8 / ratio ** 2, 12);
    expect(fine.regions[2]).toBeCloseTo(4 / ratio ** 2, 12);
  });

  test("the ratio halves the element size in two levels", () => {
    expect(ratio ** 2).toBeCloseTo(2, 12);
  });

  test("a ratio of 2 halves every size at each level", () => {
    const fine = levelSizes(base, 2, 2);
    expect(fine.max).toBeCloseTo(2, 12);
    expect(fine.min).toBeCloseTo(0.2, 12);
    expect(fine.regions[2]).toBeCloseTo(1, 12);
  });

  test("a ratio of 1 or less is refused: the levels would not refine", () => {
    expect(() => levelSizes(base, 1, 1)).toThrow(/ratio/);
  });

  test("a negative level is refused", () => {
    expect(() => levelSizes(base, -1, ratio)).toThrow(/level/);
  });
});

describe("nextLevelNodes", () => {
  test("a solid mesh grows with the cube of the ratio", () => {
    expect(nextLevelNodes(1000, 3, ratio)).toBeCloseTo(1000 * ratio ** 3, 6);
  });

  test("a shell mesh grows with the square of the ratio", () => {
    expect(nextLevelNodes(1000, 2, ratio)).toBeCloseTo(2000, 6);
  });
});

describe("assessConvergence", () => {
  test("needs at least two levels", () => {
    expect(() => assess([level(0, 1, 1)])).toThrow(/two levels/);
  });

  test("lists each level's change from the level before", () => {
    const assessment = assess([
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
    const assessment = assess([
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
    const assessment = assess([
      level(0, disp(0), 50),
      level(1, disp(1), 50),
      level(2, disp(2), 50),
    ]);
    expect(assessment.estimatedError).toBeLessThan(settings.tolerance);
    expect(assessment.converged).toBe(true);
  });

  test("not converged when the estimated error is over the tolerance", () => {
    const exact = 2.0;
    const disp = (k: number) => exact - 1.0 * (1 / ratio ** k) ** 2;
    const assessment = assess([
      level(0, disp(0), 50),
      level(1, disp(1), 50),
      level(2, disp(2), 50),
    ]);
    expect(assessment.estimatedError).toBeGreaterThan(settings.tolerance);
    expect(assessment.converged).toBe(false);
  });

  // Small changes that grow are not convergence: the last change is the only
  // honest estimate, and the levels say nothing about the order.
  test("non-monotone levels fall back to the last change", () => {
    const assessment = assess([
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
    const assessment = assess([level(0, 1.0, 50), level(1, 1.1, 50)]);
    expect(assessment.method).toBe("last-change");
    expect(assessment.estimatedError).toBeCloseTo(0.1, 12);
    expect(assessment.converged).toBe(false);
  });

  test("identical levels are converged", () => {
    const assessment = assess([
      level(0, 1.0, 50),
      level(1, 1.0, 50),
      level(2, 1.0, 50),
    ]);
    expect(assessment.estimatedError).toBe(0);
    expect(assessment.converged).toBe(true);
  });

  test("a zero displacement on the finest level is refused", () => {
    expect(() => assess([level(0, 1.0, 50), level(1, 0, 50)])).toThrow(/zero/);
  });

  // σ ~ h^-0.4 at a re-entrant corner: the peak grows at every refinement.
  test("a peak stress that keeps rising is flagged as a likely singularity", () => {
    const sigma = (k: number) => 100 * (1 / ratio ** k) ** -0.4;
    const assessment = assess([
      level(0, 1.0, sigma(0)),
      level(1, 1.0, sigma(1)),
      level(2, 1.0, sigma(2)),
    ]);
    expect(assessment.stressRising).toBe(true);
  });

  test("a peak stress that settles is not flagged", () => {
    const assessment = assess([
      level(0, 1.0, 100),
      level(1, 1.0, 104),
      level(2, 1.0, 105),
    ]);
    expect(assessment.stressRising).toBe(false);
  });

  test("no stress on a level means no stress verdict", () => {
    const assessment = assess([level(0, 1.0, null), level(1, 1.0, null)]);
    expect(assessment.stressChanges).toEqual([null, null]);
    expect(assessment.stressRising).toBe(false);
  });
});

// What the study holds fixed across its levels: the materials, the bodies'
// assignments and the supports and loads, but not the mesh they sit on.
describe("studyFingerprint", () => {
  const model = {
    materials: [{ id: 1, name: "Steel", young: 210000, poisson: 0.3 }],
    properties: [{ id: 1, materialId: 1, discretization: "solid" }],
    bcGroups: [
      {
        id: 1,
        dofs: [0, 1, 2],
        value: 0,
        faces: [{ cadFaceId: 3, nodeIds: [1, 2] }],
      },
    ],
    loadGroups: [
      {
        id: 2,
        dof: 1,
        totalForce: -1000,
        faces: [{ cadFaceId: 7, nodeIds: [9] }],
      },
    ],
    tieGroups: [],
    couplingGroups: [
      {
        id: 1,
        name: "Coupling1",
        kind: "kinematic",
        dofs: [0, 1, 2],
        refNodeId: 500,
        point: [1, 2, 3],
        faces: [{ cadFaceId: 4, nodeIds: [5, 6] }],
      },
    ],
    elementOrder: 1,
    solverMethod: "amg",
  };

  // A re-mesh re-creates a coupling's reference point as a node of the new
  // mesh (KOF-422): a new node id, the same coupling.
  test("a re-mesh, which gives a coupling a new reference node, keeps it", () => {
    const remeshed = structuredClone(model);
    remeshed.couplingGroups[0].refNodeId = 9001;
    remeshed.couplingGroups[0].faces[0].nodeIds = [70, 71, 72];
    expect(studyFingerprint(remeshed)).toBe(studyFingerprint(model));
  });

  test("a different coupling changes it", () => {
    const edited = structuredClone(model);
    edited.couplingGroups[0].kind = "distributing";
    expect(studyFingerprint(edited)).not.toBe(studyFingerprint(model));
  });

  test("a re-mesh, which moves the groups onto new nodes, keeps it", () => {
    const remeshed = structuredClone(model);
    remeshed.bcGroups[0].faces[0].nodeIds = [11, 12, 13];
    remeshed.loadGroups[0].faces[0].nodeIds = [19, 20];
    expect(studyFingerprint(remeshed)).toBe(studyFingerprint(model));
  });

  test("a different material changes it", () => {
    const edited = structuredClone(model);
    edited.materials[0].young = 70000;
    expect(studyFingerprint(edited)).not.toBe(studyFingerprint(model));
  });

  test("a different load changes it", () => {
    const edited = structuredClone(model);
    edited.loadGroups[0].totalForce = -2000;
    expect(studyFingerprint(edited)).not.toBe(studyFingerprint(model));
  });

  test("a different element order changes it", () => {
    expect(studyFingerprint({ ...model, elementOrder: 2 })).not.toBe(
      studyFingerprint(model),
    );
  });

  // A shell mesh adds the PSHELL sections it derived; the CAD bodies are what
  // the user set.
  test("sections a mesh derived do not change it", () => {
    const meshed = structuredClone(model);
    meshed.properties.push({
      id: 101,
      materialId: 1,
      discretization: "shell",
      sourceBodyId: 1,
    });
    expect(studyFingerprint(meshed)).toBe(studyFingerprint(model));
  });
});

describe("checkLevelDisplacement", () => {
  test("a level that moves passes", () => {
    expect(() => checkLevelDisplacement(1.2, 8)).not.toThrow();
  });

  test("a level that moves nothing is refused with its size", () => {
    expect(() => checkLevelDisplacement(0, 8)).toThrow(/8 mm.*moved nothing/);
  });
});

// The study's settings (KOF-424): how many levels, how much finer each is,
// and the error the verdict accepts.
describe("refinement settings", () => {
  test("the defaults are three levels, each √2 finer, judged at 2 %", () => {
    expect(DEFAULT_REFINEMENT_SETTINGS).toEqual({
      levels: 3,
      ratio: Math.SQRT2,
      tolerance: 0.02,
    });
    expect(parseRefinementSettings(DEFAULT_REFINEMENT_INPUT)).toEqual({
      settings: DEFAULT_REFINEMENT_SETTINGS,
      errors: {},
    });
  });

  test("typed values parse, the target as a percentage", () => {
    expect(
      parseRefinementSettings({ levels: "5", ratio: "2", tolerance: "0.5" }),
    ).toEqual({
      settings: { levels: 5, ratio: 2, tolerance: 0.005 },
      errors: {},
    });
  });

  test.each([["1"], ["7"], ["2.5"], [""], ["three"]])(
    "%p levels is refused",
    (levels) => {
      const parsed = parseRefinementSettings({
        ...DEFAULT_REFINEMENT_INPUT,
        levels,
      });
      expect(parsed.settings).toBeNull();
      expect(parsed.errors.levels).toMatch(/2 to 6/);
    },
  );

  test.each([["1"], ["0.8"], ["2.5"], ["x"]])(
    "ratio %p is refused",
    (ratio) => {
      const parsed = parseRefinementSettings({
        ...DEFAULT_REFINEMENT_INPUT,
        ratio,
      });
      expect(parsed.settings).toBeNull();
      expect(parsed.errors.ratio).toMatch(/1 and 2/);
    },
  );

  test.each([["0"], ["0.05"], ["25"], ["-1"], ["%"]])(
    "target %p is refused",
    (tolerance) => {
      const parsed = parseRefinementSettings({
        ...DEFAULT_REFINEMENT_INPUT,
        tolerance,
      });
      expect(parsed.settings).toBeNull();
      expect(parsed.errors.tolerance).toMatch(/0.1 to 20/);
    },
  );

  // f(h) = f∞ − C·h² on levels that halve the size: Richardson must use the
  // study's own ratio to recover the order and f∞.
  test("Richardson extrapolation uses the study's ratio", () => {
    const halving = { ...settings, ratio: 2 };
    const exact = 2.0;
    const disp = (k: number) => exact - 0.5 * (1 / 2 ** k) ** 2;
    const assessment = assess(
      [level(0, disp(0), 50), level(1, disp(1), 50), level(2, disp(2), 50)],
      halving,
    );
    expect(assessment.observedOrder).toBeCloseTo(2, 9);
    expect(assessment.extrapolated).toBeCloseTo(exact, 9);
  });

  test("the verdict is judged against the study's target", () => {
    const levels = [level(0, 1.0, 50), level(1, 1.01, 50)];
    expect(assess(levels, { ...settings, tolerance: 0.02 }).converged).toBe(
      true,
    );
    expect(assess(levels, { ...settings, tolerance: 0.005 }).converged).toBe(
      false,
    );
  });
});
