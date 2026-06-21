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
