// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The two WebAssembly modules, loaded the way the node-side tests need them.
// Both come from `bun run wasm:prepare` (`just setup`); a missing file is an
// error that says so, never a skipped test.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withStoredSolves } from "./engine-solves.mjs";

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
 *
 * With `solves: import.meta.url`, the C++ solver entries answer from that
 * test file's stored results (engine-solves.mjs): the C++ solvers left the
 * engine (KOF-309), which keeps CAD import and meshing.
 */
export async function loadEngine(options = {}) {
  const { create, wasmBinary } = await readEngine();
  const { solves, onMemory, ...engineOptions } = options;
  // `onMemory` receives the instance's WebAssembly.Memory once it exists, for
  // tests that watch or limit how the engine's heap grows.
  if (onMemory)
    engineOptions.instantiateWasm = (imports, receiveInstance) => {
      WebAssembly.instantiate(wasmBinary, imports).then(({ instance }) => {
        const memory = Object.values(instance.exports).find(
          (value) => value instanceof WebAssembly.Memory,
        );
        if (!memory)
          throw new Error("The C++ engine exports no WebAssembly.Memory");
        onMemory(memory);
        receiveInstance(instance);
      });
      return {};
    };
  if (!solves)
    return create({
      wasmBinary,
      print: silent,
      printErr: silent,
      ...engineOptions,
    });
  // The C++ solvers' results come from the test file's stored fixtures
  // (engine-solves.mjs); while recording, the lines a solver call prints are
  // captured into them.
  const print = engineOptions.print;
  const capture = { lines: null };
  const engine = await create({
    wasmBinary,
    printErr: silent,
    ...engineOptions,
    print: (line) => {
      capture.lines?.push(line);
      print?.(line);
    },
  });
  return withStoredSolves(engine, solves, { print, capture });
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
