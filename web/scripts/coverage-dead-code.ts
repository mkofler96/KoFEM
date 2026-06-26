// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Lists src/ files that never executed during the coverage test run.
//
// nyc's report only contains files that were loaded at runtime — a file that
// is never imported by anything (dead code) is invisible to it.  This script
// closes that gap: it diffs the full src/ file tree against the files present
// in coverage/coverage-final.json and flags the ones missing entirely.
//
// Run after `nyc report` (which writes coverage-final.json):
//   bun scripts/coverage-dead-code.ts
import fs from "fs";
import path from "path";

const SRC_DIR = path.resolve("src");
const COVERAGE_JSON = path.resolve("coverage", "coverage-final.json");

// Excluded from dead-code detection (mirrors .nycrc.json):
// wasm/pkg is generated, .d.ts files have no runtime code.
const EXCLUDED = [path.join(SRC_DIR, "wasm", "pkg")];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (EXCLUDED.some((ex) => full.startsWith(ex))) continue;
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

if (!fs.existsSync(COVERAGE_JSON)) {
  console.error(
    `${COVERAGE_JSON} not found — run "bun run test:coverage" first.\n` +
      "(Coverage data is only produced when the app is built with COVERAGE=1; " +
      "if a non-instrumented dev/preview server was reused by Playwright, " +
      "stop it and re-run.)",
  );
  process.exit(1);
}

const coverage = JSON.parse(fs.readFileSync(COVERAGE_JSON, "utf-8")) as Record<
  string,
  { s: Record<string, number> }
>;
const coveredFiles = new Set(Object.keys(coverage).map((f) => path.resolve(f)));

const srcFiles = listSourceFiles(SRC_DIR);
const neverLoaded = srcFiles.filter((f) => !coveredFiles.has(f));
const loadedButNeverRun = Object.entries(coverage)
  .filter(([, data]) => {
    const counts = Object.values(data.s);
    return counts.length > 0 && counts.every((c) => c === 0);
  })
  .map(([f]) => f);

console.log(
  `\nDead-code check: ${srcFiles.length} src files, ` +
    `${coveredFiles.size} appear in coverage\n`,
);

if (neverLoaded.length > 0) {
  console.log("Files never loaded by any test (possible dead code):");
  for (const f of neverLoaded) console.log(`  ✗ ${path.relative(".", f)}`);
} else {
  console.log("✓ Every src file was loaded by at least one test.");
}

if (loadedButNeverRun.length > 0) {
  console.log("\nFiles bundled but with zero executed statements:");
  for (const f of loadedButNeverRun)
    console.log(`  ! ${path.relative(".", f)}`);
}
console.log();
