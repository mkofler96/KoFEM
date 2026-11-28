// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The materials a safety factor (KOF-496) is taken with: the solve's, with
// the yield strength as it is now. The factors themselves are covered in
// crates/kofem-fem/tests/safety_factor.rs.

import { describe, expect, test } from "bun:test";
import { withCurrentYield } from "../../src/lib/safetyFactor";
import type { Material } from "../../src/store/modelStore";

const material = (id: number, yieldStrength?: number): Material => ({
  id,
  name: `M${id}`,
  young: 210000,
  poisson: 0.3,
  density: 7.85e-9,
  color: "#4e79a7",
  yieldStrength,
});
describe("withCurrentYield", () => {
  test("keeps the solved materials, with the yield strength as it is now", () => {
    const solved = [material(1), { ...material(2, 100), name: "Old" }];
    const current = [material(1, 250), { ...material(2), name: "New" }];
    expect(withCurrentYield(solved, current)).toEqual([
      material(1, 250),
      { ...material(2), name: "Old" },
    ]);
  });

  test("refuses a solved material the model no longer has", () => {
    expect(() => withCurrentYield([material(3)], [material(1)])).toThrow(
      /material 3/,
    );
  });
});
