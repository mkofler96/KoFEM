// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";

const PAGES = [
  "/",
  "/examples/",
  "/examples/plate-with-hole/",
  "/validation/plate-with-hole/",
];

test.use({ javaScriptEnabled: false });

test("public pages share navigation and typography without JavaScript", async ({
  page,
}) => {
  const appearances = [];
  for (const path of PAGES) {
    await page.goto(path);
    const header = page.getByRole("banner");
    await expect(header).toHaveCount(1);
    const home = header.getByRole("link", { name: "KoFEM home" });
    await expect(home).toHaveAttribute("href", "/");
    await expect(
      header.getByRole("link", { name: "Examples", exact: true }),
    ).toHaveAttribute("href", "/examples/");
    const solver = header.getByRole("link", { name: /Start Solver/ });
    await expect(solver).toHaveAttribute("href", "/app/");
    await header.getByText("More", { exact: true }).click();
    await expect(
      header.getByRole("link", { name: "Cookie settings" }),
    ).toBeVisible();
    await expect(
      header.getByRole("link", { name: "Validation", exact: true }),
    ).toHaveAttribute("href", "/validation/");
    appearances.push(
      await home.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.fontFamily, style.fontSize, style.color];
      }),
    );
  }
  for (const appearance of appearances)
    expect(appearance).toEqual(appearances[0]);
});

for (const width of [320, 390]) {
  test(`public navigation fits a ${width}px screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    for (const path of PAGES) {
      await page.goto(path);
      const header = page.getByRole("banner");
      await expect(
        header.getByRole("link", { name: /Start Solver/ }),
      ).toBeInViewport();
      expect(
        await header.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return element.scrollWidth <= bounds.width;
        }),
      ).toBe(true);
    }
  });
}
