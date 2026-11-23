// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-466: before the part is meshed, the mesh row of the pre-flight checks
// says there is no mesh, not "Mesh ready · 0 nodes".

import { test, expect } from "./coverage";
import { gotoApp } from "./fixtures/app";
import { fakeImport } from "./fixtures/mesh";
import { openTree } from "./fixtures/tree";

for (const study of ["static", "topopt"] as const) {
  test(`${study} study: the mesh row says "No mesh" before meshing`, async ({
    page,
  }) => {
    await gotoApp(page);
    await fakeImport(page);
    await openTree(page, study);

    await expect(page.getByTestId("check-fail").first()).toHaveText("No mesh");
  });
}
