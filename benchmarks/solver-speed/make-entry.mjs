// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Writes the benchmark entry for one source tree: static imports of that
// tree's app code and Rust module, so `bun build` can bundle it for Node.
//
// Usage: bun make-entry.mjs <tree> <out.mjs> [--with-mfem] [--alt <name>=<dir>]
//   --alt  a second build of the Rust module (a wasm-bindgen output directory),
//          timed as rust-gs@<name> and rust-amg@<name>

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [tree, out, ...flags] = process.argv.slice(2);
if (!tree || !out)
  throw new Error(
    "usage: make-entry.mjs <tree> <out.mjs> [--with-mfem] [--alt <name>=<dir>]",
  );
const t = resolve(tree);
const bench = join(dirname(fileURLToPath(import.meta.url)), "bench.mjs");
const mfem = flags.includes("--with-mfem");
const altArg = flags.includes("--alt")
  ? flags[flags.indexOf("--alt") + 1]
  : null;
const alt = altArg ? /^([a-z0-9-]+)=(.+)$/i.exec(altArg) : null;
if (altArg && !alt) throw new Error("--alt takes <name>=<dir>");
writeFileSync(
  out,
  `import { buildVertexIndexer } from ${JSON.stringify(join(t, "web/src/lib/solveMeshPacking.ts"))};
import { solveSolidInRust } from ${JSON.stringify(join(t, "web/src/lib/solve/amg.ts"))};
${mfem ? `import { buildSolidEngineInputs } from ${JSON.stringify(join(t, "web/src/lib/solve/solid.ts"))};` : "const buildSolidEngineInputs = null;"}
import * as femGlue from ${JSON.stringify(join(t, "web/src/wasm/fem/kofem_wasm.js"))};
${alt ? `import * as femAltGlue from ${JSON.stringify(join(resolve(alt[2]), "kofem_wasm.js"))};` : ""}
import { runBenchmark } from ${JSON.stringify(bench)};
await runBenchmark(
  { buildVertexIndexer, solveSolidInRust, buildSolidEngineInputs, femGlue,
    femWasmPath: ${JSON.stringify(join(t, "web/src/wasm/fem/kofem_wasm_bg.wasm"))},
    femAlt: ${alt ? `{ name: ${JSON.stringify(alt[1])}, glue: femAltGlue, wasmPath: ${JSON.stringify(join(resolve(alt[2]), "kofem_wasm_bg.wasm"))} }` : "null"} },
  process.argv.slice(2),
);
`,
);
console.log(`wrote ${out}`);
