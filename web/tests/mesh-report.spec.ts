// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test } from "./coverage";
import { fixturePath, importStep } from "./fixtures/app";

interface Geom {
  file: string;
  label: string;
}

const GEOMETRIES: Geom[] = [
  { file: "tube.stp", label: "Tube (hollow cylinder)" },
  { file: "new_bracket_2.stp", label: "Complex Bracket (STEP)" },
  { file: "Wall Bracket.stp", label: "Wall Bracket" },
];

const NIST_GEOMETRIES: Geom[] = [
  { file: "nist_ctc_03_asme1_ap242-e2.stp", label: "NIST CTC-03 (AP242 e2)" },
  { file: "nist_ctc_05_asme1_ap242-e1.stp", label: "NIST CTC-05 (AP242 e1)" },
];

const ALL_GEOMETRIES: Geom[] = [...GEOMETRIES, ...NIST_GEOMETRIES];

// Real CAD files, including two NIST AP242 test cases, import without error.
test.describe("STEP import of real CAD files", () => {
  for (const geom of ALL_GEOMETRIES) {
    test(geom.label, async ({ page }) => {
      test.setTimeout(90_000); // complex STEP imports can take >20 s in CI
      const stepFile = fixturePath(geom.file);

      page.on("console", (msg) => {
        if (msg.type() === "error")
          console.error(`[${geom.label}] browser error: ${msg.text()}`);
      });
      page.on("pageerror", (err) =>
        console.error(`[${geom.label}] page exception: ${err.message}`),
      );

      // Complex geometries can take >10 s in CI.
      await importStep(page, stepFile, 60_000);

      // The worker reports a failed import in the UI banner.
      const errorBanner = page.getByTestId("step-error");
      if (await errorBanner.isVisible()) {
        throw new Error(
          `STEP import failed for ${geom.label}: ${await errorBanner.textContent()}`,
        );
      }
    });
  }
});
