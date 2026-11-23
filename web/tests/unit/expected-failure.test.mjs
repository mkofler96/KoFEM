// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A validation case can publish a known limitation (KOF-400): the same recipe
// at the other element order, whose error lies outside the tolerance and is
// recorded, so CI fails when it grows or disappears. These tests pin the
// case's contract (examples/validation/cases/index.mjs), the published row
// (web/public/examples/results.json) and the page that shows it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cases, { register } from "../../../examples/validation/cases/index.mjs";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ID = "cooks-membrane-incompressible";
const locking = cases.find((c) => c.id === ID);
const { reference, referenceLabel, ...source } = locking;
void reference;
void referenceLabel;

const withFailure = (expectedFailure) => () =>
  register({ ...source, expectedFailure });

describe("a case's expected failure", () => {
  test("the nearly incompressible Cook's membrane records linear tetrahedra", () => {
    expect(locking.recipe.mesh.order).toBe(2);
    expect(locking.recipe.material.poisson).toBe(0.4999);
    expect(locking.expectedFailure.order).toBe(1);
  });

  test("must be at the other element order", () => {
    expect(withFailure({ order: 2, errPct: -43, bandPct: 2 })).toThrow(
      /differ from the recipe's own order/,
    );
  });

  test("must miss the reference by more than the tolerance", () => {
    expect(withFailure({ order: 1, errPct: -0.5, bandPct: 0.1 })).toThrow(
      /outside the ±1 % tolerance/,
    );
  });

  test("its band must stay outside the tolerance", () => {
    expect(withFailure({ order: 1, errPct: -3, bandPct: 2.5 })).toThrow(
      /keep the band outside the tolerance/,
    );
  });
});

describe("the published result", () => {
  const row = JSON.parse(
    readFileSync(resolve(web, "public/examples/results.json"), "utf8"),
  ).cases.find((c) => c.id === ID);

  test("quadratic tetrahedra pass their tolerance", () => {
    expect(row.mesh.order).toBe(2);
    expect(row.pass).toBe(true);
  });

  test("linear tetrahedra lock, by the recorded error", () => {
    const xf = row.expectedFailure;
    expect(xf.order).toBe(1);
    expect(xf.mesh.order).toBe(1);
    expect(Math.abs(xf.errPct)).toBeGreaterThan(row.tolPct);
    expect(xf.holds).toBe(true);
    expect(Math.abs(xf.errPct - xf.recordedErrPct)).toBeLessThanOrEqual(
      xf.bandPct,
    );
  });
});

describe("the page", () => {
  const html = readFileSync(resolve(web, `examples/${ID}/index.html`), "utf8");

  test("says it shows a limitation and links the Theory Guide note", () => {
    const notice = html.match(
      /<p class="note" data-testid="limitation">([\s\S]*?)<\/p>/,
    );
    expect(notice).not.toBeNull();
    expect(notice[1]).toContain("This example shows a limitation");
    expect(notice[1]).toContain(
      'href="/theory/numerical-methods/elements-and-quadrature/#incompressible"',
    );
  });

  test("shows both element orders", () => {
    expect(html).toContain('data-testid="expected-failure"');
    expect(html).toContain("Linear tetrahedra");
    expect(html).toContain("Quadratic tetrahedra");
  });

  test("embeds the 3D view and opens the model in KoFEM", () => {
    expect(html).toContain(`data-viewer="`);
    expect(html).toContain(`href="/app/?example=${ID}"`);
  });

  test("cites the reference", () => {
    expect(html).toContain("10.1007/s00466-023-02409-5");
  });
});

test("the Theory Guide note links back to the example", () => {
  const html = readFileSync(
    resolve(web, "theory/numerical-methods/elements-and-quadrature/index.html"),
    "utf8",
  );
  expect(html).toContain('id="incompressible"');
  expect(html).toContain(`href="/examples/${ID}/"`);
});
