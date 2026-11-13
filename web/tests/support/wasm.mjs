// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The two WebAssembly modules, loaded the way the node-side tests need them.
// Both come from `bun run wasm:prepare` (`just setup`); a missing file is an
// error that says so, never a skipped test.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENGINE_JS = new URL(
  "../../src/wasm/pkg/kofem_wasm_emcc.js",
  import.meta.url,
);
const ENGINE_WASM = new URL(
  "../../src/wasm/pkg/kofem_wasm_emcc.wasm",
  import.meta.url,
);
const FEM_JS = new URL("../../src/wasm/fem/kofem_wasm.js", import.meta.url);
const FEM_WASM = new URL(
  "../../src/wasm/fem/kofem_wasm_bg.wasm",
  import.meta.url,
);

function requireBuilt(url, what) {
  const file = fileURLToPath(url);
  if (!existsSync(file))
    throw new Error(
      `${what} is not built: ${file} is missing. Run \`just setup\` (or \`bun run wasm:prepare\` in web/).`,
    );
  return file;
}

const silent = () => {};
let engineBinary;
let createEngine;

/**
 * A fresh instance of the C++ engine (OCCT, Netgen, the C++ solvers). Each
 * call returns a new instance with its own memory and geometry cache, so
 * tests that must not see each other's state call it once each. The engine's
 * log is dropped unless `print` / `printErr` are passed.
 */
export async function loadEngine(options = {}) {
  if (!createEngine) {
    engineBinary = readFileSync(
      requireBuilt(ENGINE_WASM, "The C++ engine"),
    ).buffer;
    ({ default: createEngine } = await import(
      requireBuilt(ENGINE_JS, "The C++ engine")
    ));
  }
  return createEngine({
    wasmBinary: engineBinary,
    print: silent,
    printErr: silent,
    ...options,
  });
}

let fem;

/**
 * The Rust finite-element module, initialised. It is stateless between
 * calls, so one instance serves a whole test file; later calls return the
 * same module. Its classes can also be imported by name from
 * src/wasm/fem/kofem_wasm.js once this has resolved.
 */
export async function loadFem() {
  if (!fem) {
    const bytes = readFileSync(
      requireBuilt(FEM_WASM, "The Rust finite-element module"),
    );
    const module = await import(
      requireBuilt(FEM_JS, "The Rust finite-element module")
    );
    await module.default({ module_or_path: bytes });
    fem = module;
  }
  return fem;
}
