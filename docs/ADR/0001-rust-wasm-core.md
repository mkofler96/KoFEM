# ADR 0001: Rust + WebAssembly Solver Core

**Status:** Accepted  
**Date:** 2026-05-12

## Context
We need a high-performance FEM solver that runs in the browser without a server, while also supporting a Python scripting interface.

## Decision
Use Rust for the solver core, compiled to WebAssembly for browser deployment and to a native library for Python bindings via PyO3.

The core crate (`kofem-core`) is kept `no_std`-compatible so it can target both WASM (no OS) and native (via the `std` feature flag).

## Consequences
- **+** Near-native performance in browser via WASM
- **+** Single solver codebase serves both web and Python
- **+** Memory safety by construction; no C++ UB pitfalls
- **-** Rust learning curve; no_std adds constraints (no `HashMap` without `hashbrown`, no `format!` without `alloc`)
- **-** WASM file size (~500kB–2MB) must be streamed; initial load adds latency
- **Mitigation:** wasm-opt with `-Oz`, lazy-load WASM only when solver is triggered
