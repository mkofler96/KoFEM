# KoFEM — AI Development Guide

KoFEM is a browser-first finite element analysis application. This file is the primary context for Claude Code when working on this codebase.

## Architecture Overview

```
KoFEM/
├── crates/
│   ├── kofem-core/     # no_std Rust solver — runs in WASM and natively
│   ├── kofem-geom/     # geometry engine that handles step parsing etc.
│   ├── kofem-mesh/     # meshing engine that handles mesh generation
│   ├── kofem-py/       # python binding but not relevant yet
│   └── kofem-wasm/     # wasm-bindgen bindings for the browser
├── web/                # React + Three.js frontend (Vite)
├── python/             # Python package (maturin build)
└── docs/               # Project specs, roadmap, ADRs
```

## First-time setup

After cloning, activate the project's git hooks (runs `cargo fmt` and `cargo clippy` before every commit):

```bash
git config core.hooksPath .githooks
```

## Build Commands

```bash
# Check Rust compiles
cargo check

# Build and test Rust
cargo test

# Build WASM (requires wasm-pack)
wasm-pack build crates/kofem-wasm --target web --out-dir web/src/wasm/pkg

# Install and run the web frontend (uses bun, not npm)
cd web && bun install && bun run dev

```

## Code Style

- before commiting, always run rust format and clippy
- TypeScript: strict mode, no `any`
- Comments only for non-obvious physics/math — reference the paper/equation instead of explaining the code
- ALWAYS prefer clear and information rich error messages over silent fall throughs. Avoid defensive try/catch blocks at all cost to make debugging and error spotting easier.

## Pull Request Convention

Always include `closes #<issue-number>` in the PR description body so that merging the PR automatically closes the linked issue on GitHub.
