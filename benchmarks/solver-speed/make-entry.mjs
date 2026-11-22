// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Writes the benchmark entry for one source tree: static imports of that
// tree's app code and Rust module, so `bun build` can bundle it for Node.
//
// Usage: bun make-entry.mjs <tree> <out.mjs> [--with-mfem]

import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [tree, out, flag] = process.argv.slice(2);
if (!tree || !out)
  throw new Error("usage: make-entry.mjs <tree> <out.mjs> [--with-mfem]");
const t = resolve(tree);
const bench = join(dirname(fileURLToPath(import.meta.url)), "bench.mjs");
const mfem = flag === "--with-mfem";
writeFileSync(
  out,
  `import { buildVertexIndexer } from ${JSON.stringify(join(t, "web/src/lib/solveMeshPacking.ts"))};
import { solveSolidInRust } from ${JSON.stringify(join(t, "web/src/lib/solve/amg.ts"))};
${mfem ? `import { buildSolidEngineInputs } from ${JSON.stringify(join(t, "web/src/lib/solve/solid.ts"))};` : "const buildSolidEngineInputs = null;"}
import * as femGlue from ${JSON.stringify(join(t, "web/src/wasm/fem/kofem_wasm.js"))};
import { runBenchmark } from ${JSON.stringify(bench)};
await runBenchmark(
  { buildVertexIndexer, solveSolidInRust, buildSolidEngineInputs, femGlue,
    femWasmPath: ${JSON.stringify(join(t, "web/src/wasm/fem/kofem_wasm_bg.wasm"))} },
  process.argv.slice(2),
);
`,
);
console.log(`wrote ${out}`);
