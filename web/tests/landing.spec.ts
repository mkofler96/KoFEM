import { test, expect } from "./coverage";

// The marketing landing at "/" is static HTML (no React) — verify it renders
// the headline and routes to the solver app.
test("landing page renders and links to the solver app", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Browser-based FEM analysis" }),
  ).toBeVisible();

  const launch = page.getByRole("link", { name: /Launch Solver/i });
  await expect(launch).toHaveAttribute("href", "/app/");
});
