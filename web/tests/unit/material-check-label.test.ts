// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The material row of the Solve and Optimize pre-flight checks, once every
// body resolves to a confirmed material (KOF-415).

import { expect, test } from "bun:test";
import { materialCheckLabel } from "../../src/lib/modelDisplay";

const steel = { name: "Steel", young: 210000 };
const aluminium = { name: "Aluminium", young: 70000 };

test("one body names its material and stiffness", () => {
  expect(materialCheckLabel([steel], 1)).toBe(
    "Material assigned · Steel · E=2.100e+5 MPa",
  );
});

test("several bodies count the bodies and the materials", () => {
  expect(materialCheckLabel([steel, aluminium], 3)).toBe(
    "Materials assigned · 3 bodies · 2 materials",
  );
});

test("several bodies of one material say so in the singular", () => {
  expect(materialCheckLabel([steel], 2)).toBe(
    "Materials assigned · 2 bodies · 1 material",
  );
});
