// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";

// The marketing landing at "/" is static HTML (no React) — verify it renders
// the headline and routes to the solver app.
test("landing page renders and links to the solver app", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      name: "Finite element analysis, right in your browser.",
    }),
  ).toBeVisible();

  // Several "Start Solver" buttons route to the app (nav, hero, closing CTA);
  // assert the first one points at the solver.
  const launch = page.getByRole("link", { name: /Start Solver/i }).first();
  await expect(launch).toHaveAttribute("href", "/app/");
});

// A rel=canonical pointing at a domain we do not own tells Google the real page
// lives elsewhere, so the page it sits on drops out of the index. These run
// against `vite preview`, i.e. the same build output that ships.
const SITE_ORIGIN = "https://kofem.org";

for (const path of ["/", "/examples/", "/privacy/"]) {
  test(`${path} declares its canonical URL on the production origin`, async ({
    page,
  }) => {
    await page.goto(path);

    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `${SITE_ORIGIN}${path}`,
    );
    expect(await page.content()).not.toContain("example.com");
  });
}
