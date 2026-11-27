// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-490: a solve that fails inside the solver tells the user what to change.
// A block hinged to the cantilever along one edge passes the rigid-body check
// (it is part of the held body) but leaves the stiffness matrix singular.

import { test, expect } from "./coverage";
import {
  bootstrapCantilever,
  hingeBlockOnCantilever,
} from "./fixtures/cantilever";
import { openTree } from "./fixtures/tree";

const ADVICE =
  "Part of the model can still move freely, so the solve has no unique answer. " +
  "Look for a part joined to the rest only along an edge or at a point: " +
  "support it, or join it to the rest over a face.";

test("a singular model names what to change, not just a solver error", async ({
  page,
}) => {
  await bootstrapCantilever(page);
  await hingeBlockOnCantilever(page);
  await openTree(page, "static");
  const runButton = page.getByRole("button", { name: /Run static solve/ });
  await expect(runButton).toBeEnabled();
  await runButton.click();

  const banner = page.getByTestId("solve-error");
  await expect(banner).toContainText(ADVICE);
  // The solver's own words stay as the detail, without a stack trace.
  await expect(banner).toContainText("is not positive definite");
  await expect(banner).not.toContainText("wasm-function");
});
