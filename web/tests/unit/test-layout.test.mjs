// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Where a test file lives decides whether anything runs it. bun finds
// *.test.* under web/tests/unit and web/tests/integration; Playwright finds
// *.spec.ts under web/tests; ctest runs what engine/tests/CMakeLists.txt
// lists. A test file anywhere else, or one written as a standalone script
// the way the tests used to be, would exist and never run. These checks turn
// that into a failure that says where the file belongs.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

// Tracked files and new ones that are not ignored, as repo-relative paths.
function repoFiles() {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: REPO },
  );
  if (listed.exitCode !== 0)
    throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  return listed.stdout.toString().split("\n").filter(Boolean);
}

const files = repoFiles();
const BUN_TEST = /\.test\.[cm]?[jt]sx?$/;
const BUN_FOLDERS = /^web\/tests\/(unit|integration)\//;

describe("every test file is where its runner looks", () => {
  test("bun tests live in web/tests/unit or web/tests/integration", () => {
    expect(
      files.filter((file) => BUN_TEST.test(file) && !BUN_FOLDERS.test(file)),
      "bun finds *.test.* files only under web/tests/unit and web/tests/integration; move these there",
    ).toEqual([]);
  });

  test("Playwright specs live under web/tests", () => {
    expect(
      files.filter(
        (file) =>
          /\.spec\.[cm]?[jt]sx?$/.test(file) && !/^web\/tests\//.test(file),
      ),
      "Playwright runs *.spec.ts files only under web/tests; move these there",
    ).toEqual([]);
  });

  test("no test is a standalone script", () => {
    expect(
      files.filter(
        (file) =>
          /^web\/tests\/test_[^/]+\.mjs$/.test(file) ||
          /^scripts\/test-[^/]+\.sh$/.test(file),
      ),
      "nothing runs script-style tests any more: write a bun test (web/tests/unit, web/tests/integration) or add a kofem_test() line to engine/tests/CMakeLists.txt",
    ).toEqual([]);
  });
});

describe("what the runner refuses on CI fails here first", () => {
  // bun rejects an exclusive test when CI is set: the property throws when it
  // is read, and a file that throws while it loads runs none of its tests.
  const exclusive = /\b(?:test|it|describe)\.only\b/;

  test("no bun test asks for an exclusive run", () => {
    expect(
      files
        .filter((file) => BUN_TEST.test(file))
        .filter((file) =>
          exclusive.test(readFileSync(`${REPO}${file}`, "utf8")),
        ),
      "bun refuses `.only` on CI, and the file then runs no test at all; remove it from these",
    ).toEqual([]);
  });
});

describe("the unit folder holds tests without WebAssembly", () => {
  const loadsWasm = /support\/wasm\.mjs|src\/wasm\/(pkg|fem)\//;

  test("no unit test loads the engine or the Rust module", () => {
    expect(
      files
        .filter(
          (file) => /^web\/tests\/unit\//.test(file) && BUN_TEST.test(file),
        )
        .filter((file) =>
          loadsWasm.test(readFileSync(`${REPO}${file}`, "utf8")),
        ),
      "a test that loads a WebAssembly module is an integration test; move these to web/tests/integration",
    ).toEqual([]);
  });
});
