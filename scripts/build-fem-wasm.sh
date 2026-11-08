#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# Build the Rust finite-element module (crates/kofem-wasm) for the browser:
# cargo → wasm32-unknown-unknown, then wasm-bindgen generates the ES module
# glue and TypeScript types into web/src/wasm/fem/ (generated, not committed).
#
# The wasm-bindgen CLI must be exactly the version Cargo.toml pins for the
# crate — the generated glue and the compiled module speak a private protocol.
#
# Usage:  bash scripts/build-fem-wasm.sh
# Needs:  rustup target add wasm32-unknown-unknown
#         cargo install wasm-bindgen-cli --version <pinned> --locked

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/web/src/wasm/fem"

PINNED="$(sed -n 's/^wasm-bindgen = "=\(.*\)"$/\1/p' "$REPO_ROOT/Cargo.toml")"
if [ -z "$PINNED" ]; then
    echo "ERROR: no exact wasm-bindgen pin (wasm-bindgen = \"=x.y.z\") in Cargo.toml." >&2
    exit 1
fi
if ! command -v wasm-bindgen >/dev/null; then
    echo "ERROR: wasm-bindgen CLI not found." >&2
    echo "Install it with: cargo install wasm-bindgen-cli --version $PINNED --locked" >&2
    exit 1
fi
INSTALLED="$(wasm-bindgen --version | awk '{print $2}')"
if [ "$INSTALLED" != "$PINNED" ]; then
    echo "ERROR: wasm-bindgen CLI is $INSTALLED, but Cargo.toml pins $PINNED." >&2
    echo "Install it with: cargo install wasm-bindgen-cli --version $PINNED --locked --force" >&2
    exit 1
fi

cargo build --manifest-path "$REPO_ROOT/Cargo.toml" --locked --release \
    --package kofem-wasm --target wasm32-unknown-unknown

rm -rf "$OUT_DIR"
wasm-bindgen --target web --out-dir "$OUT_DIR" \
    "$REPO_ROOT/target/wasm32-unknown-unknown/release/kofem_wasm.wasm"

echo "Done: $OUT_DIR ($(du -h "$OUT_DIR/kofem_wasm_bg.wasm" | cut -f1) wasm)"
