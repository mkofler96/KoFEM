// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// CITATION.cff is what Zenodo reads for the metadata of each archived
// release, and what GitHub shows under "Cite this repository" (KOF-450).

import { YAML } from "bun";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const citation = YAML.parse(readFileSync(`${REPO}CITATION.cff`, "utf8"));
const pkg = JSON.parse(readFileSync(`${REPO}web/package.json`, "utf8"));

describe("CITATION.cff", () => {
  test("cites the KoFEM software under its licence", () => {
    expect(citation["cff-version"]).toBe("1.2.0");
    expect(citation.type).toBe("software");
    expect(citation.title).toBe("KoFEM");
    expect(citation.license).toBe(pkg.license);
    expect(citation["repository-code"]).toBe(
      "https://github.com/mkofler96/KoFEM",
    );
    expect(citation.authors).toEqual([
      { "given-names": "Michael", "family-names": "Kofler" },
    ]);
    expect(citation.abstract.length).toBeGreaterThan(0);
  });

  // Zenodo takes the version from the release tag unless the file names one;
  // a version written here would go stale on the next release.
  test("names no version or release date, so Zenodo takes them from the tag", () => {
    expect(citation).not.toHaveProperty("version");
    expect(citation).not.toHaveProperty("date-released");
  });
});
