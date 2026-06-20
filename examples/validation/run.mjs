// Validation runner: solves every case through the real WASM engine and checks
// the finite-element result against its closed-form / published reference.
//
//   node examples/validation/run.mjs            # run + print table
//   node examples/validation/run.mjs --report   # also (re)write REPORT.md
//
// Exits non-zero if any case falls outside its tolerance band, so CI fails on a
// solver regression. See README.md for what each case validates.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadSolver } from "./lib/solver.mjs";
import cases from "./cases/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function fmt(x) {
  if (x === 0) return "0";
  const a = Math.abs(x);
  return a >= 1e4 || a < 1e-3 ? x.toExponential(4) : x.toFixed(4);
}

const solve = await loadSolver();
const rows = [];
let failed = 0;

for (const c of cases) {
  const fe = c.run(solve);
  const relErr = Math.abs((fe - c.reference) / c.reference) * 100;
  const pass = relErr <= c.tolPct;
  if (!pass) failed++;
  rows.push({ ...c, fe, relErr, pass });
}

// ── Console table ─────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);
console.log("\nKoFEM validation suite — FE result vs. analytical reference\n");
console.log(
  pad("Case", 30) +
    pad("Quantity", 26) +
    padl("FE", 13) +
    padl("Reference", 13) +
    padl("Err%", 8) +
    padl("Tol%", 7) +
    "  Status",
);
console.log("-".repeat(110));
for (const r of rows) {
  console.log(
    pad(r.name, 30) +
      pad(r.quantity, 26) +
      padl(fmt(r.fe), 13) +
      padl(fmt(r.reference), 13) +
      padl(r.relErr.toFixed(2), 8) +
      padl(r.tolPct, 7) +
      "  " +
      (r.pass ? "PASS" : "FAIL"),
  );
}
console.log("-".repeat(110));
console.log(
  `${rows.length - failed}/${rows.length} passed` +
    (failed ? `  —  ${failed} FAILED` : "  —  all within tolerance"),
);

// ── Markdown report (for the tutorial / docs) ────────────────────────────────
if (process.argv.includes("--report")) {
  const lines = [
    "# KoFEM validation results",
    "",
    "Each case is solved by the real MFEM WASM engine and compared against its",
    "closed-form or published reference. Regenerate with:",
    "",
    "```bash",
    "node examples/validation/run.mjs --report",
    "```",
    "",
    "| Case | Quantity | FE result | Reference | Error | Tol | Status |",
    "| --- | --- | ---: | ---: | ---: | ---: | :---: |",
    ...rows.map(
      (r) =>
        `| ${r.name} | ${r.quantity} | ${fmt(r.fe)}${r.unit ? " " + r.unit : ""} | ${r.referenceLabel} | ${r.relErr.toFixed(2)}% | ${r.tolPct}% | ${r.pass ? "✅" : "❌"} |`,
    ),
    "",
  ];
  writeFileSync(join(here, "REPORT.md"), lines.join("\n"));
  console.log("\nWrote examples/validation/REPORT.md");
}

process.exit(failed ? 1 : 0);
