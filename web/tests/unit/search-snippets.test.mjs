// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The title and description a search result shows (KOF-333). Google cuts a
// title after about 60 characters and a description after about 155, and a
// cut snippet loses the reason to click. The pages are generated
// (web/theory/generate.mjs, examples/validation/run.mjs) and CI fails when a
// committed page no longer matches its generator, so these tests read the
// committed HTML.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const unescape = (s) =>
  s
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

function snippet(path) {
  const html = readFileSync(resolve(web, path), "utf8");
  const one = (re) => {
    const match = html.match(re);
    if (!match) throw new Error(`${path}: no match for ${re}`);
    return unescape(match[1].replace(/\s+/g, " ").trim());
  };
  return {
    title: one(/<title>([\s\S]*?)<\/title>/),
    description: one(/<meta name="description"\s+content="([^"]*)"/),
    ogTitle: one(/<meta property="og:title" content="([^"]*)"/),
    ogDescription: one(/<meta property="og:description"\s+content="([^"]*)"/),
  };
}

// Word pairs a title uses more than once, as in "Theory Guide | KoFEM Theory
// Guide".
function repeatedPairs(title) {
  const words = title.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const pairs = words.slice(1).map((w, i) => `${words[i]} ${w}`);
  return [...new Set(pairs.filter((p, i) => pairs.indexOf(p) !== i))];
}

test("a repeated phrase is found", () => {
  expect(repeatedPairs("Theory Guide | KoFEM Theory Guide")).toEqual([
    "theory guide",
  ]);
});

// Every published reading page: the home page, the example pages and the
// Theory Guide.
const pages = execFileSync(
  "git",
  ["ls-files", "index.html", "examples/*index.html", "theory/*index.html"],
  { cwd: web, encoding: "utf8" },
)
  .trim()
  .split("\n");

// The pages that rank on Google's first page but get almost no clicks
// (Search Console, Aug–Nov 2026), and the phrase each title leads with.
const RANKING = [
  ["index.html", /^Free online FEM solver/i],
  ["examples/index.html", /^FEM examples/i],
  ["examples/mbb-beam-topopt/index.html", /^MBB beam topology optimization/i],
  ["examples/cooks-membrane/index.html", /^Cook's membrane/i],
  ["examples/plate-with-hole/index.html", /^Plate with a hole/i],
  ["theory/index.html", /^FEM theory guide/i],
  ["theory/foundations/what-is-fem/index.html", /^What is FEM\?/i],
  ["theory/foundations/consistent-units/index.html", /^Consistent units/i],
  [
    "theory/solid-mechanics/linear-elasticity/index.html",
    /^Linear elasticity/i,
  ],
];

describe("every page", () => {
  test("lists the pages", () => {
    expect(pages.length).toBeGreaterThan(20);
  });

  test.each(pages)("%s: title fits a search result", (path) => {
    expect(snippet(path).title.length).toBeLessThanOrEqual(60);
  });

  test.each(pages)("%s: social card repeats title and description", (path) => {
    const page = snippet(path);
    expect(page.ogTitle).toBe(page.title);
    expect(page.ogDescription).toBe(page.description);
  });

  test.each(pages)("%s: title names KoFEM once", (path) => {
    expect(snippet(path).title.match(/KoFEM/g)).toHaveLength(1);
  });

  test.each(pages)("%s: title does not repeat a phrase", (path) => {
    expect(repeatedPairs(snippet(path).title)).toEqual([]);
  });
});

describe("pages that rank without clicks", () => {
  test.each(RANKING)(
    "%s: title leads with the searched phrase",
    (path, lead) => {
      expect(snippet(path).title).toMatch(lead);
    },
  );

  test.each(RANKING)("%s: description fits a search result", (path) => {
    expect(snippet(path).description.length).toBeLessThanOrEqual(155);
  });
});
