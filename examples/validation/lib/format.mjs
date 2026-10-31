// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Number formatting shared by the console table (run.mjs) and the public
// validation page (page.mjs), so the page can quote the exact line a user sees
// when they run the suite themselves.

/** Five significant digits; exponent notation outside [0.01, 10⁴). */
export function fmt(x) {
  if (x === 0) return "0";
  const a = Math.abs(x);
  return a >= 1e4 || a < 1e-2 ? x.toExponential(4) : x.toPrecision(5);
}

/** Signed relative error in percent: negative = below the reference magnitude. */
export function relErrPct(fe, reference) {
  return ((fe - reference) / reference) * 100;
}

/** Signed percentage with two decimals, e.g. "-3.51". */
export function fmtErr(errPct) {
  return (errPct > 0 ? "+" : "") + errPct.toFixed(2);
}

const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

export const CONSOLE_RULE = "-".repeat(118);

export function consoleHeader() {
  return (
    pad("Case", 35) +
    pad("Quantity", 32) +
    padl("FE", 12) +
    padl("Reference", 12) +
    padl("Err%", 9) +
    padl("Tol%", 6) +
    "  Status"
  );
}

/** One console row; `row` carries name, quantity, fe, reference, errPct, tolPct, pass. */
export function consoleRow(row) {
  return (
    pad(row.name, 35) +
    pad(row.quantity, 32) +
    padl(fmt(row.fe), 12) +
    padl(fmt(row.reference), 12) +
    padl(fmtErr(row.errPct), 9) +
    padl(row.tolPct, 6) +
    "  " +
    (row.pass ? "PASS" : "FAIL")
  );
}
