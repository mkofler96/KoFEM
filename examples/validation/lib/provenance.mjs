// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which builds a published number came from. The pages and records stamp both:
//
//   engine  the C++ engine (OCCT, Netgen, MFEM): the `.engine-id` stamp that
//           scripts/fetch-wasm-engine.sh and scripts/build-wasm.sh write next
//           to the binary — a hash of the engine's sources
//           (scripts/engine-version.sh);
//   fem     the Rust finite-element module (crates/kofem-wasm, built by
//           scripts/build-fem-wasm.sh), which solves every model built from a
//           recipe (the app's AMG path). It has no version id of its own, so
//           this is a hash of the compiled module: it names the exact binary,
//           and changes with the sources or the Rust toolchain.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const ENGINE_STAMP = join(repo, "web/src/wasm/pkg/.engine-id");
const FEM_MODULE = join(repo, "web/src/wasm/fem/kofem_wasm_bg.wasm");

/** `engine-<hash>`: the C++ engine build. */
export function engineId() {
  if (!existsSync(ENGINE_STAMP))
    throw new Error(
      `${relative(repo, ENGINE_STAMP)} is missing, so the engine build behind these numbers is unknown. Install the engine with scripts/fetch-wasm-engine.sh (or build it).`,
    );
  return readFileSync(ENGINE_STAMP, "utf8").trim();
}

/** `fem-<hash>`: the Rust finite-element module, by its content. */
export function femModuleId() {
  if (!existsSync(FEM_MODULE))
    throw new Error(
      `${relative(repo, FEM_MODULE)} is missing, so the Rust module behind these numbers is unknown. Build it with bash scripts/build-fem-wasm.sh.`,
    );
  const hash = createHash("sha256")
    .update(readFileSync(FEM_MODULE))
    .digest("hex");
  return `fem-${hash.slice(0, 12)}`;
}
