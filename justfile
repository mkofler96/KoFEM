# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# One entry point for setup, checks and tests. `just` lists the recipes.
#
# Each test recipe is one native command (cargo, ctest, bun, playwright), and
# whatever follows the recipe name goes straight to it:
#
#   just test-rust -p kofem-fem shell
#   just test-cpp-native -R shell
#   just test-web tie
#   just test-e2e couplings --repeat-each 20
#
# CI runs these same recipes, so a suite cannot pass here in a different way
# than it does there. Recipes run from the repository root, wherever you call
# them from.

set shell := ["bash", "-euo", "pipefail", "-c"]

# Recipe arguments reach the commands as "$@", so an argument with a space or
# a `|` in it (`-g "pick|click"`) arrives as the one word it was typed as.

set positional-arguments

[private]
default:
    @just --list --unsorted

# The engine comes last: a checkout with unpublished engine changes has none
# to fetch (build it: bash scripts/docker-build-wasm.sh), and everything else
# is ready by then.

# Pinned tools, web dependencies and both WebAssembly modules. Safe to re-run.
setup:
    bash scripts/install-tools.sh
    cd web && bun install --frozen-lockfile
    cd web && bun run wasm:fem
    cd web && bun run wasm:fetch

# Formatters, linters and type checks for Rust and the web app.
check: check-rust check-web

# cargo fmt and clippy, warnings denied.
check-rust:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets -- -D warnings

# tsc, eslint and prettier.
check-web:
    cd web && bun run typecheck
    cd web && bun run lint
    cd web && bun run format:check

# clang-tidy on the C++ engine (needs the Emscripten toolchain).
check-cpp:
    bash scripts/clang-tidy.sh

# Every suite: Rust, C++, node-side and browser.
test: test-rust test-cpp test-web test-e2e

# Without arguments every crate; with them, what they select
# (`just test-rust -p kofem-fem shell`).

# Rust: elements, assembly, solvers, shell idealisation.
test-rust *args:
    cargo test {{ if args == "" { "--workspace" } else { "" } }} "$@"

# C++: the engine units that build on their own, native and with MFEM.
test-cpp: test-cpp-native test-cpp-wasm

# C++ with the host compiler: the units without MFEM.
test-cpp-native *args:
    @{{ just_executable() }} _ctest native "$@"

# The SDK is at /emsdk in the dependency image and after
# scripts/fetch-wasm-deps.sh; set EMSDK when yours is elsewhere.

# C++ through Emscripten and node: the units that link MFEM.
test-cpp-wasm *args:
    @export EMSDK="${EMSDK:-/emsdk}"; \
    if [ ! -x "$EMSDK/upstream/emscripten/emcc" ]; then \
        echo "ERROR: no Emscripten SDK at $EMSDK. Set EMSDK or run: bash scripts/fetch-wasm-deps.sh" >&2; \
        exit 1; \
    fi; \
    {{ just_executable() }} _ctest wasm "$@"

# TypeScript logic and both WebAssembly modules, without a browser.
test-web *args: _wasm
    cd web && bun test --parallel "$@"

# The app in a browser (Playwright builds and serves it).
test-e2e *args:
    cd web && bunx playwright test "$@"

# A failing test does not stop the report: coverage is not a gate.

# Line coverage of the browser suite, from an instrumented build.
coverage:
    cd web && rm -rf .nyc_output coverage
    -cd web && COVERAGE=1 NODE_OPTIONS=--max-old-space-size=6144 bunx playwright test
    cd web && bun run coverage:report

# Configure, build and run one preset of engine/tests.
_ctest preset *args:
    cd engine/tests && cmake --preset "$1" --log-level=WARNING
    cd engine/tests && cmake --build --preset "$1" --parallel {{ num_cpus() }}
    cd engine/tests && ctest --preset "$1" "${@:2}"

# The C++ engine (fetched) and the Rust module (built) under web/src/wasm.
_wasm:
    cd web && bun run wasm:prepare
