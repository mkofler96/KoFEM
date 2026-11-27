// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What the status bar says about the selected CAD face (KOF-493): its id, its
// surface type (a cylinder with its diameter), its area in the model's units,
// and a plane's normal or a cylinder's or cone's axis.

import { describe, expect, test } from "bun:test";
import { cadFaceLabel } from "../../src/lib/cadFaceProperties";
import { MODEL_UNITS } from "../../src/lib/modelUnits";
import { statusMessages } from "../../src/i18n/messages/shell";

const en = statusMessages.en;
const de = statusMessages.de;

describe("cadFaceLabel", () => {
  test("a plane facing +Z", () => {
    expect(
      cadFaceLabel(
        12,
        { kind: "plane", area: 149.2, normal: [0, 0, 1] },
        en,
        "en-US",
        MODEL_UNITS.length,
      ),
    ).toBe("Face 12 · plane · 149 mm² · normal +Z");
  });

  test("a plane facing −X", () => {
    expect(
      cadFaceLabel(
        3,
        { kind: "plane", area: 40, normal: [-1, 0, 0] },
        en,
        "en-US",
        "mm",
      ),
    ).toBe("Face 3 · plane · 40 mm² · normal −X");
  });

  test("an oblique plane gives its normal's components", () => {
    expect(
      cadFaceLabel(
        5,
        {
          kind: "plane",
          area: 2.5,
          normal: [Math.SQRT1_2, 0, -Math.SQRT1_2],
        },
        en,
        "en-US",
        "mm",
      ),
    ).toBe("Face 5 · plane · 2.5 mm² · normal (0.71, 0, -0.71)");
  });

  test("a cylinder with its diameter and axis", () => {
    expect(
      cadFaceLabel(
        39,
        { kind: "cylinder", area: 37.04, axis: [0, 0, -1], radius: 1.6 },
        en,
        "en-US",
        "mm",
      ),
    ).toBe("Face 39 · cylinder Ø3.2 · 37 mm² · axis Z");
  });

  test("an axis has no sign: the first non-zero component is shown positive", () => {
    expect(
      cadFaceLabel(
        8,
        {
          kind: "cylinder",
          area: 1000,
          axis: [-0.6, 0.8, 0],
          radius: 10,
        },
        en,
        "en-US",
        "mm",
      ),
    ).toBe("Face 8 · cylinder Ø20 · 1,000 mm² · axis (0.6, -0.8, 0)");
  });

  test("a cone with its axis", () => {
    expect(
      cadFaceLabel(
        2,
        { kind: "cone", area: 307.3, axis: [0, 1, 0] },
        en,
        "en-US",
        "mm",
      ),
    ).toBe("Face 2 · cone · 307 mm² · axis Y");
  });

  test("any other surface gives only its area", () => {
    expect(
      cadFaceLabel(1, { kind: "other", area: 0.01234 }, en, "en-US", "mm"),
    ).toBe("Face 1 · other surface · 0.0123 mm²");
  });

  test("numbers follow the language", () => {
    expect(
      cadFaceLabel(
        39,
        { kind: "cylinder", area: 1234.5, axis: [1, 0, 0], radius: 1.6 },
        de,
        "de-DE",
        "mm",
      ),
    ).toBe("Fläche 39 · Zylinder Ø3,2 · 1.235 mm² · Achse X");
  });

  test("the area takes the model's length unit", () => {
    expect(
      cadFaceLabel(
        4,
        { kind: "plane", area: 12, normal: [0, 1, 0] },
        en,
        "en-US",
        "in",
      ),
    ).toBe("Face 4 · plane · 12 in² · normal +Y");
  });
});
