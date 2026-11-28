// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The report's symbol markup (KOF-391): text with $…$ spans becomes MathML,
// set in Computer Modern like LaTeX: italic variables, upright units and
// labels, a true minus and thin-space digit groups.

import { expect, test } from "bun:test";
import { tex } from "../../src/lib/report/tex";

test("plain text is escaped, nothing else", () => {
  expect(tex('a < b & "c"')).toBe("a &lt; b &amp; &quot;c&quot;");
});

test("a variable is italic math", () => {
  expect(tex("Max $|U|$")).toBe(
    "Max <math><mo>|</mo><mi>U</mi><mo>|</mo></math>",
  );
});

test("a text subscript is upright", () => {
  const out = tex("$σ_{\\u{vm}}$");
  expect(out).toContain("<msub>");
  expect(out).toContain('<mi mathvariant="normal">vm</mi>');
});

test("numbers take a true minus and thin-space groups", () => {
  expect(tex("$-10 000$")).toBe("<math><mo>−</mo><mn>10 000</mn></math>");
});

test("units are upright after a thin space; exponents are superscripts", () => {
  expect(tex("$1.909~\\u{mm}$")).toBe(
    '<math><mn>1.909</mn><mspace width="0.17em"/><mi mathvariant="normal">mm</mi></math>',
  );
  expect(tex("$10^{-9}$")).toContain("<msup>");
});

test("Σ is upright and a slash has no spacing", () => {
  expect(tex("$Σ$")).toBe('<math><mi mathvariant="normal">Σ</mi></math>');
  expect(tex("$\\u{t}/\\u{mm}$")).toContain('<mo lspace="0" rspace="0">/</mo>');
});

test("markup characters inside math are escaped", () => {
  expect(tex("$<$")).toBe("<math><mo>&lt;</mo></math>");
});
