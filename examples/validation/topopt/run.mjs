// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Topology-optimization benchmark runner (KOF-234): optimizes each canonical
// case through the real WASM engine (the same SIMP/MMA loop the browser runs)
// and checks the converged compliance, volume fraction and emergent layout
// against a documented tolerance band.
//
//   node examples/validation/topopt/run.mjs            # run + print results
//   node examples/validation/topopt/run.mjs --report   # also (re)write REPORT.md
//
// Exits non-zero if any check fails, so it gates a solver regression. Unlike the
// linear-elastic suite in ../, each case asserts several properties (a
// trajectory and a topology, not one scalar), so the runner prints per-case
// metrics and a pass/fail line per check. See README.md for what each validates.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadOptimizer } from "./lib/optimize.mjs";
import cases from "./cases/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const optimize = await loadOptimizer();

const results = [];
let failed = 0;

for (const c of cases) {
  process.stdout.write(`\n▶ ${c.name} — ${c.description}\n`);
  const start = Date.now();
  const { metrics, checks, layout } = c.run(optimize);
  const secs = ((Date.now() - start) / 1000).toFixed(1);

  for (const m of metrics) console.log(`    ${m.label.padEnd(24)} ${m.value}`);
  if (layout) console.log("\n" + layout + "\n");
  for (const chk of checks) {
    if (!chk.pass) failed++;
    console.log(`    [${chk.pass ? "PASS" : "FAIL"}] ${chk.label}`);
  }
  console.log(`    (${secs}s)`);
  results.push({ ...c, metrics, checks, layout });
}

const total = results.reduce((n, r) => n + r.checks.length, 0);
console.log(
  `\n${total - failed}/${total} checks passed` +
    (failed ? `  —  ${failed} FAILED` : "  —  all within tolerance") +
    "\n",
);

if (process.argv.includes("--report")) {
  const lines = [
    "# KoFEM topology-optimization benchmark results",
    "",
    "Each case is optimized by the real WASM engine (the SIMP minimum-compliance",
    "loop + MMA optimizer, KOF-230/231) and its converged compliance, volume",
    "fraction and layout are checked against a documented tolerance band.",
    "Regenerate with:",
    "",
    "```bash",
    "node examples/validation/topopt/run.mjs --report",
    "```",
    "",
  ];
  for (const r of results) {
    lines.push(`## ${r.name}`, "", `${r.description}`, "");
    for (const m of r.metrics) lines.push(`- **${m.label}:** ${m.value}`);
    lines.push("");
    if (r.layout) lines.push("```", r.layout, "```", "");
    for (const chk of r.checks)
      lines.push(`- ${chk.pass ? "✅" : "❌"} ${chk.label}`);
    lines.push("");
  }
  writeFileSync(join(here, "REPORT.md"), lines.join("\n"));
  console.log("Wrote examples/validation/topopt/REPORT.md\n");
}

process.exit(failed ? 1 : 0);
