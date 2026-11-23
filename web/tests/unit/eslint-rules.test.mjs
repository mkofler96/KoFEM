// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The lint rules in web/eslint-rules. Two keep the browser specs
// deterministic: time budgets live in playwright.config.ts only, and the
// viewport is clicked through tests/fixtures/viewport.ts only. One keeps
// missing data from turning into a plausible default (no-silent-fallback).

import { describe, test } from "bun:test";
import { RuleTester } from "eslint";
import noSilentFallback from "../../eslint-rules/no-silent-fallback.js";
import noTestTimeouts from "../../eslint-rules/no-test-timeouts.js";
import viewportThroughFixture from "../../eslint-rules/viewport-through-fixture.js";

// RuleTester reports each case through the host runner's describe/it. Its
// hook for exclusive cases stays unset: no case here is one, and bun refuses
// to hand out an exclusive test on CI.
RuleTester.describe = describe;
RuleTester.it = test;

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

const valueDefaults = [{ checkValueDefaults: true }];

ruleTester.run("no-silent-fallback", noSilentFallback, {
  valid: [
    // A running sum, count or maximum read back into its own map entry: the
    // default is the identity of the reduction, not a stand-in for data.
    {
      code: "owners.set(key, (owners.get(key) ?? 0) + 1);",
      options: valueDefaults,
    },
    {
      code: "vmByNode.set(node, Math.max(vmByNode.get(node) ?? 0, vm));",
      options: valueDefaults,
    },
    {
      code: "area.set(face, (area.get(face) ?? 0) + triangleArea(t));",
      options: valueDefaults,
    },
    {
      code: "normals.set(id, (normals.get(id) ?? new Vector3()).add(normal));",
      options: valueDefaults,
    },
    // Absence markers stay allowed: they flow into explicit emptiness checks.
    { code: "const ids = payload.ids ?? [];", options: valueDefaults },
    { code: "const name = prop.name ?? null;", options: valueDefaults },
    { code: "const { ids = [] } = payload;", options: valueDefaults },
    { code: "function f(opts = {}) { return opts; }", options: valueDefaults },
    // An empty collection is "no data", like [] and {}.
    { code: "const taken = given ?? new Set();", options: valueDefaults },
    {
      code: "function f(byFace = new Map()) { return byFace; }",
      options: valueDefaults,
    },
    {
      code: "const t = mesh.t ?? new Float64Array(0);",
      options: valueDefaults,
    },
    // A default that is no value: the caller's own variable.
    {
      code: "const { size = requestedSize } = payload;",
      options: valueDefaults,
    },
    // Ternaries that are not presence checks choose between two real values.
    { code: 'const s = n === 1 ? "" : "s";', options: valueDefaults },
    { code: "const v = a > b ? a : 1;", options: valueDefaults },
    // A flag is no presence check: the chosen branch does not use it.
    { code: 'const label = isOn ? "On" : "Off";', options: valueDefaults },
    { code: "const n = hasShells ? shellCount : 0;", options: valueDefaults },
    {
      code: 'const id = ok ? "check-ok" : "check-fail";',
      options: valueDefaults,
    },
    // Prose is a message to the user that states the absence, not a value
    // standing in for data.
    {
      code: 'const os = match ? match[0] : "unrecognised OS";',
      options: valueDefaults,
    },
    {
      code: "const label = stale !== null ? stale : `Mesh ready · ${n} nodes`;",
      options: valueDefaults,
    },
    { code: 'const id = engineId ?? "not recorded";', options: valueDefaults },
    // Choosing between two messages is no fallback of the value checked.
    {
      code: 'const title = group ? `Add face to ${group.name}` : "New BC";',
      options: valueDefaults,
    },
    // A presence check whose absent branch is an absence marker or an error.
    {
      code: "const m = prop ? prop.materialId : null;",
      options: valueDefaults,
    },
    {
      code: "const m = prop ? prop.materialId : fail('no property');",
      options: valueDefaults,
    },
    // Outside the solver paths only the parse rule applies.
    "const { format = 'step' } = payload;",
    "const m = prop ? prop.materialId : 1;",
  ],
  invalid: [
    {
      code: "const e = parseFloat(text) || 0;",
      errors: [{ messageId: "nanMasking" }],
    },
    // The identity exemption needs the same map and key on both sides.
    {
      code: "totals.set(key, (counts.get(key) ?? 0) + 1);",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    {
      code: "counts.set(other, (counts.get(key) ?? 0) + 1);",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    {
      code: "const count = counts.get(key) ?? 0;",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    // Only the identity of a reduction: a direct write fabricates the value,
    // and a non-identity start corrupts the sum.
    {
      code: "stresses.set(node, stresses.get(node) ?? 0);",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    {
      code: "counts.set(key, (counts.get(key) ?? 42) + 1);",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    {
      code: "peaks.set(node, Math.max(peaks.get(node) ?? 7, vm));",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    // An empty object of another kind is a value: a zero vector.
    {
      code: "const acc = outward.get(id) ?? new Vector3();",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    {
      code: "const t = mesh.t ?? new Float64Array(3);",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    {
      code: "const m = prop.materialId ?? 1;",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    // KOF-432: the same default written as a destructuring default...
    {
      code: 'const { format = "step", maxElementSize = 20.0 } = payload;',
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }, { messageId: "valueDefault" }],
    },
    {
      code: "const [first = 1] = list;",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    // ...a parameter default...
    {
      code: "function mesh(size = 20) { return size; }",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    {
      code: "const f = ({ order = 1 }) => order;",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    // ...or a presence-check ternary (the KOF-413 shell material).
    {
      code: "const m = shellProp ? shellProp.materialId : 1;",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    {
      code: "const m = !shellProp ? 1 : shellProp.materialId;",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    // A one-word string is a value: an enum member, a format.
    {
      code: 'const f = payload.format !== undefined ? payload.format : "step";',
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    {
      code: "const kind = shape ?? `solid`;",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    {
      code: "const w = coupling.weights ? coupling.weights[i] : 1;",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    {
      code: "const n = mesh?.thicknesses ? mesh.thicknesses.length : 0;",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    {
      code: "const t = prop.thickness !== undefined ? prop.thickness : 1;",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    {
      code: "const t = prop.thickness == null ? 1 : prop.thickness;",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
    {
      code: "const t = undefined === prop.thickness ? DEFAULT_THICKNESS : prop.thickness;",
      options: valueDefaults,
      errors: [{ messageId: "valueDefault" }],
    },
  ],
});
