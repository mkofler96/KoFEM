// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The two lint rules that keep the browser specs deterministic
// (web/eslint-rules): time budgets live in playwright.config.ts only, and the
// viewport is clicked through tests/fixtures/viewport.ts only.

import { describe, test } from "bun:test";
import { RuleTester } from "eslint";
import noTestTimeouts from "../../eslint-rules/no-test-timeouts.js";
import viewportThroughFixture from "../../eslint-rules/viewport-through-fixture.js";

// RuleTester reports each case through the host runner's describe/it.
RuleTester.describe = describe;
RuleTester.it = test;
RuleTester.itOnly = test.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
});

ruleTester.run("no-test-timeouts", noTestTimeouts, {
  valid: [
    "await expect(page.getByRole('button')).toBeVisible();",
    "await expect.poll(() => count(page)).toBe(1);",
    "await page.waitForFunction(() => window.ready);",
    // A variable is not a budget; only what is handed to a call is.
    "const timeout = settings.timeout;",
    // The app's own code may time things inside the page.
    "await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));",
  ],
  invalid: [
    {
      code: "test.setTimeout(120_000);",
      errors: [{ messageId: "testBudget" }],
    },
    { code: "test.slow();", errors: [{ messageId: "testBudget" }] },
    // The same budget through the test's info object.
    {
      code: "testInfo.setTimeout(500_000);",
      errors: [{ messageId: "testBudget" }],
    },
    {
      code: "test.info().setTimeout(500_000);",
      errors: [{ messageId: "testBudget" }],
    },
    { code: "testInfo.slow();", errors: [{ messageId: "testBudget" }] },
    {
      code: "await expect(locator).toBeVisible({ timeout: 60_000 });",
      errors: [{ messageId: "waitBudget" }],
    },
    {
      code: "await expect.poll(() => count(page), { timeout: 30_000 }).toBe(1);",
      errors: [{ messageId: "waitBudget" }],
    },
    {
      code: "await page.waitForFunction(() => window.ready, undefined, { timeout });",
      errors: [{ messageId: "waitBudget" }],
    },
    {
      code: "await page.waitForTimeout(400);",
      errors: [{ messageId: "sleep" }],
    },
    {
      code: "await new Promise((resolve) => setTimeout(resolve, 50));",
      errors: [{ messageId: "sleep" }],
    },
    {
      code: "await new Promise((resolve) => window.setTimeout(resolve, 50));",
      errors: [{ messageId: "sleep" }],
    },
  ],
});

ruleTester.run("viewport-through-fixture", viewportThroughFixture, {
  valid: [
    "await clickModelAt(page, [100, 50, 5]);",
    "await clickViewportAt(page, box.x, box.y);",
    "await page.getByTestId('split-apply').click();",
    // Moving the pointer off the model, or dragging a panel edge, is not a
    // viewport click.
    "await page.mouse.move(0, 0);",
    "await page.mouse.down(); await page.mouse.up();",
    // Looking at the canvas is not clicking it.
    "await expect(page.locator('canvas')).toBeVisible();",
    "const box = await page.locator('canvas').first().boundingBox();",
  ],
  invalid: [
    {
      code: "await page.mouse.click(screen.x, screen.y);",
      errors: [{ messageId: "viaFixture" }],
    },
    {
      code: "await page.mouse.dblclick(10, 20);",
      errors: [{ messageId: "viaFixture" }],
    },
    // The same click by another route.
    {
      code: "const { mouse } = page; await mouse.click(10, 20);",
      errors: [{ messageId: "viaFixture" }],
    },
    {
      code: "await page.locator('canvas').click();",
      errors: [{ messageId: "viaFixture" }],
    },
    {
      code: "await page.locator('canvas').first().dblclick({ position: { x: 1, y: 2 } });",
      errors: [{ messageId: "viaFixture" }],
    },
    {
      code: "const canvas = page.locator('canvas'); await canvas.click();",
      errors: [{ messageId: "viaFixture" }],
    },
  ],
});
