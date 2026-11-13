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

// Drops a line of the engine's log.
const silent = () => undefined;

// The engine's factory and binary are read once. The promise is stored before
// anything is awaited, so tests that load at the same time share one read.
let engineSource = null;

function readEngine() {
  if (!engineSource) {
    const wasmBinary = readFileSync(
      requireBuilt(ENGINE_WASM, "The C++ engine"),
    ).buffer;
    engineSource = import(requireBuilt(ENGINE_JS, "The C++ engine")).then(
      (module) => ({ create: module.default, wasmBinary }),
    );
  }
  return engineSource;
}

/**
 * A fresh instance of the C++ engine (OCCT, Netgen, the C++ solvers). Each
 * call returns a new instance with its own memory and geometry cache, so
 * tests that must not see each other's state call it once each. The engine's
 * log is dropped unless `print` / `printErr` are passed.
 */
export async function loadEngine(options = {}) {
  const { create, wasmBinary } = await readEngine();
  return create({
    wasmBinary,
    print: silent,
    printErr: silent,
    ...options,
  });
}

let femModule = null;

/**
 * The Rust finite-element module, initialised. It is stateless between
 * calls, so one instance serves a whole test file; later calls return the
 * same module. Its classes can also be imported by name from
 * src/wasm/fem/kofem_wasm.js once this has resolved.
 *
 * @returns {Promise<object>} the initialised module
 */
export function loadFem() {
  if (!femModule) {
    const bytes = readFileSync(
      requireBuilt(FEM_WASM, "The Rust finite-element module"),
    );
    femModule = import(
      requireBuilt(FEM_JS, "The Rust finite-element module")
    ).then(async (module) => {
      await module.default({ module_or_path: bytes });
      return module;
    });
  }
  return femModule;
}
