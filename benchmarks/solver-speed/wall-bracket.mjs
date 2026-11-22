// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The real-world case of the solver-speed study: how long each solver takes
// to bring the wall bracket's largest displacement within a given error, a
// work–precision diagram. Plain JavaScript, like analyse.mjs: an offline
// analysis of benchmark records, not app numerics.
//
// Error. The bracket has no closed-form answer, so each mesh's largest nodal
// displacement is compared with that of the finest quadratic mesh (an
// overkill solution of the same model), which is therefore not plotted.
// Netgen refines the bracket non-uniformly (fillets and holes set the element
// size on coarse meshes), so no convergence rate is fitted; the figure shows
// error against cost only.
//
// Time. Medians of the timed rounds of the scaling runs: the shipped C++
// engine (v0.6) and Rust AMG (v0.7). The read-out is the same for every
// solver (they agree to 10⁻⁸), so it is taken from one run.
//
// Usage: bun wall-bracket.mjs <out-dir> <readouts.jsonl> <timings.jsonl> …

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [outDir, readoutFile, ...timingFiles] = process.argv.slice(2);
if (!outDir || !readoutFile || timingFiles.length === 0)
  throw new Error(
    "usage: wall-bracket.mjs <out-dir> <readouts.jsonl> <timings.jsonl> …",
  );
const read = (f) =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const key = (r) => `P${r.order} h=${r.h}`;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const readouts = new Map();
for (const r of read(readoutFile).filter((r) => r.model === "wall-bracket")) {
  if (typeof r.maxDisplacement !== "number")
    throw new Error(`${readoutFile}: ${key(r)} has no maxDisplacement`);
  readouts.set(key(r), r);
}
if (readouts.size === 0)
  throw new Error(`${readoutFile}: no wall-bracket rows`);

const reference = [...readouts.values()]
  .filter((r) => r.order === 2)
  .reduce((a, b) => (b.dofs > a.dofs ? b : a));

// Which solver each timing configuration stands for.
const solvers = {
  "mfem:A-shipped": {
    name: "C++/MFEM, Gauss–Seidel (v0.6)",
    colour: "#c2410c",
  },
  "rust-amg": { name: "Rust, AMG (v0.7)", colour: "#0f766e" },
};
// Median time per mesh for each solver, from the last timing file that ran
// it: the scaling run of the old tree times the C++ engine, the develop run
// the current Rust AMG.
const chosen = Object.entries(solvers).map(([config, solver]) => {
  let byMesh = null;
  for (const f of timingFiles) {
    const rows = read(f).filter(
      (r) => r.model === "wall-bracket" && !r.warmup && r.config === config,
    );
    if (rows.length === 0) continue;
    byMesh = {};
    for (const r of rows) (byMesh[key(r)] ??= []).push(r.totalMs);
  }
  if (!byMesh) throw new Error(`no wall-bracket timings for ${config}`);
  const ms = Object.fromEntries(
    Object.entries(byMesh).map(([k, v]) => [k, median(v)]),
  );
  const points = Object.keys(ms)
    .filter((k) => k !== key(reference))
    .map((k) => {
      const r = readouts.get(k);
      if (!r) throw new Error(`no read-out for wall bracket ${k}`);
      return {
        mesh: k,
        order: r.order,
        dofs: r.dofs,
        ms: ms[k],
        error: Math.abs(r.maxDisplacement / reference.maxDisplacement - 1),
      };
    })
    .sort((a, b) => a.ms - b.ms);
  return { config, ...solver, ms, points };
});

const out = [
  "# Wall bracket: error against solve time",
  "",
  `Reference: the finest quadratic mesh (${key(reference)}, ${reference.dofs} DOF), largest displacement ${reference.maxDisplacement.toPrecision(6)} mm. ` +
    "The refinement is not uniform, so no rate is fitted. Times are medians of the timed rounds. " +
    'An error against a reference that is only a little finer is an underestimate: read the quadratic meshes closest to the reference as "below about 1 %", not as their figure.',
  "",
  `| Mesh | DOF | Largest displacement (mm) | Error | ${chosen.map((s) => s.name).join(" | ")} |`,
  `| --- | ---: | ---: | ---: | ${chosen.map(() => "---:").join(" | ")} |`,
];
for (const r of [...readouts.values()].sort(
  (a, b) => a.order - b.order || a.dofs - b.dofs,
)) {
  const cells = chosen.map((c) =>
    c.ms[key(r)] === undefined ? "—" : `${(c.ms[key(r)] / 1000).toFixed(2)} s`,
  );
  const error =
    r === reference
      ? "reference"
      : `${(100 * Math.abs(r.maxDisplacement / reference.maxDisplacement - 1)).toFixed(1)} %`;
  out.push(
    `| ${key(r)} | ${r.dofs} | ${r.maxDisplacement.toPrecision(6)} | ${error} | ${cells.join(" | ")} |`,
  );
}
writeFileSync(join(outDir, "wall-bracket.md"), out.join("\n") + "\n");
writeFileSync(join(outDir, "wall-bracket.svg"), figure(chosen));
console.log(`wrote ${join(outDir, "wall-bracket.md")} and wall-bracket.svg`);

function figure(chosen) {
  const W = 640,
    H = 340,
    P = { l: 60, r: 230, t: 32, b: 46 };
  const all = chosen.flatMap((s) => s.points);
  const lx = Math.log10;
  const [x0, x1] = [
    Math.floor(lx(Math.min(...all.map((p) => p.ms)) / 1000)),
    Math.ceil(lx(Math.max(...all.map((p) => p.ms)) / 1000)),
  ];
  const [y0, y1] = [
    Math.floor(lx(Math.min(...all.map((p) => p.error)))),
    Math.ceil(lx(Math.max(...all.map((p) => p.error)))),
  ];
  const X = (s) => P.l + ((lx(s) - x0) / (x1 - x0)) * (W - P.l - P.r);
  const Y = (e) => P.t + ((y1 - lx(e)) / (y1 - y0)) * (H - P.t - P.b);
  let s = "";
  for (let e = x0; e <= x1; e++)
    s += `<line x1="${X(10 ** e)}" x2="${X(10 ** e)}" y1="${P.t}" y2="${H - P.b}" stroke="#e5e7eb"/><text x="${X(10 ** e)}" y="${H - P.b + 16}" font-size="11" text-anchor="middle" fill="#6b7280">${10 ** e} s</text>`;
  for (let e = y0; e <= y1; e++)
    s += `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(10 ** e)}" y2="${Y(10 ** e)}" stroke="#e5e7eb"/><text x="${P.l - 6}" y="${Y(10 ** e) + 4}" font-size="11" text-anchor="end" fill="#6b7280">${+(100 * 10 ** e).toPrecision(1)} %</text>`;
  for (const c of chosen)
    for (const order of [1, 2]) {
      const ps = c.points.filter((p) => p.order === order);
      if (ps.length > 1)
        s += `<polyline fill="none" stroke="${c.colour}" stroke-width="1.5" ${order === 2 ? 'stroke-dasharray="5 3"' : ""} points="${ps.map((p) => `${X(p.ms / 1000).toFixed(1)},${Y(p.error).toFixed(1)}`).join(" ")}"/>`;
      for (const p of ps)
        s +=
          order === 1
            ? `<circle cx="${X(p.ms / 1000).toFixed(1)}" cy="${Y(p.error).toFixed(1)}" r="4" fill="${c.colour}"><title>${p.mesh}, ${p.dofs} DOF: ${(p.ms / 1000).toFixed(2)} s, ${(100 * p.error).toFixed(1)} %</title></circle>`
            : `<rect x="${(X(p.ms / 1000) - 4).toFixed(1)}" y="${(Y(p.error) - 4).toFixed(1)}" width="8" height="8" fill="${c.colour}"><title>${p.mesh}, ${p.dofs} DOF: ${(p.ms / 1000).toFixed(2)} s, ${(100 * p.error).toFixed(1)} %</title></rect>`;
    }
  chosen.forEach((c, i) => {
    s += `<line x1="${W - P.r + 10}" x2="${W - P.r + 26}" y1="${P.t + 10 + 18 * i}" y2="${P.t + 10 + 18 * i}" stroke="${c.colour}" stroke-width="3"/><text x="${W - P.r + 32}" y="${P.t + 14 + 18 * i}" font-size="11" fill="#374151">${c.name}</text>`;
  });
  const ly = P.t + 10 + 18 * chosen.length + 8;
  s += `<circle cx="${W - P.r + 18}" cy="${ly}" r="4" fill="#6b7280"/><text x="${W - P.r + 32}" y="${ly + 4}" font-size="11" fill="#374151">linear tetrahedra</text>`;
  s += `<rect x="${W - P.r + 14}" y="${ly + 14}" width="8" height="8" fill="#6b7280"/><text x="${W - P.r + 32}" y="${ly + 22}" font-size="11" fill="#374151">quadratic tetrahedra</text>`;
  s += `<text x="${P.l}" y="${P.t - 12}" font-size="12" fill="#374151">Wall bracket: error in the largest displacement against solve time</text><text x="${W - P.r}" y="${H - 6}" font-size="11" text-anchor="end" fill="#6b7280">solve time (median)</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif"><rect width="${W}" height="${H}" fill="#fff"/>${s}</svg>\n`;
}
