#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# Install the two command-line tools the repo needs that no lockfile provides:
#
#   just          the task runner behind `just setup`, `just check`, `just test`
#   wasm-bindgen  the CLI that turns the Rust module into its browser package;
#                 its version must equal the wasm-bindgen pin in Cargo.toml
#
# Both come as release binaries, at a pinned version and checked against a
# pinned SHA-256, so CI, cloud sessions and laptops run the same tools and a
# fresh machine is ready in seconds instead of compiling them. Idempotent: a
# tool that is already at its pinned version is left alone.
#
#   bash scripts/install-tools.sh
#
# `just setup` runs this too. On Linux the binaries go to ~/.cargo/bin when it
# exists (rustup put it on PATH), else ~/.local/bin. Other systems have no
# pinned binary here: install `just` with your package manager, and this
# script builds wasm-bindgen from source with cargo, at the pinned version.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

JUST_VERSION="1.58.0"
WASM_BINDGEN_VERSION="$(sed -n 's/^wasm-bindgen = "=\(.*\)"$/\1/p' "$REPO_ROOT/Cargo.toml")"
if [ -z "$WASM_BINDGEN_VERSION" ]; then
    echo "ERROR: no exact wasm-bindgen pin (wasm-bindgen = \"=x.y.z\") in Cargo.toml." >&2
    exit 1
fi

# SHA-256 of each release archive, as published next to it. A version bump
# needs the new values here: download the archive and run sha256sum on it.
checksum() {
    case "$1" in
        just-1.58.0-x86_64-unknown-linux-musl) echo 4a5cc2f53e6f0f8c59092a6cc38291eb729d46a7dd95d3ae582008881b84931d ;;
        just-1.58.0-aarch64-unknown-linux-musl) echo 748237128c4c40cbdabc65e841d05ceba13cc23a91eaba395495894c1d9764df ;;
        wasm-bindgen-0.2.129-x86_64-unknown-linux-musl) echo 82d12bb940e2d4e72e0d5605387fc1b8ca179044e012b620f0ce4e7440e8320e ;;
        wasm-bindgen-0.2.129-aarch64-unknown-linux-musl) echo 2ed4351c35dd9440308bbb02767d47ea278efe851a52465300f3c94f5b6c2a87 ;;
        *)
            echo "ERROR: no pinned checksum for $1 in scripts/install-tools.sh." >&2
            echo "Download the release archive, verify it, and add its sha256sum to checksum()." >&2
            exit 1
            ;;
    esac
}

installed_version() {
    command -v "$1" >/dev/null 2>&1 || return 0
    "$1" --version 2>/dev/null | awk '{print $2}'
}

# Bun has its own installer (https://bun.sh) and CI action. Its pin is the
# oven/bun tag in web/Dockerfile; a different local version is reported, not
# replaced.
check_bun() {
    local pinned local_version
    pinned="$(sed -n 's|^COPY --from=oven/bun:\([0-9][0-9.]*\)@sha256:.*|\1|p' "$REPO_ROOT/web/Dockerfile")"
    if [ -z "$pinned" ]; then
        echo "ERROR: web/Dockerfile has no 'COPY --from=oven/bun:<version>@sha256:' line to read the Bun pin from." >&2
        exit 1
    fi
    command -v bun >/dev/null 2>&1 || return 0
    local_version="$(bun --version)"
    if [ "$local_version" != "$pinned" ]; then
        echo "WARNING: bun $local_version is installed; the repository pins $pinned (web/Dockerfile)." >&2
        echo "         CI runs $pinned, so results here can differ. Switch with: bun upgrade (or reinstall Bun $pinned)." >&2
    fi
}

TRIPLE=""
if [ "$(uname -s)" = "Linux" ]; then
    case "$(uname -m)" in
        x86_64) TRIPLE="x86_64-unknown-linux-musl" ;;
        aarch64 | arm64) TRIPLE="aarch64-unknown-linux-musl" ;;
    esac
fi

if [ -z "$TRIPLE" ]; then
    if [ "$(installed_version just)" = "" ]; then
        echo "ERROR: \`just\` is not installed, and there is no pinned binary for $(uname -s) $(uname -m)." >&2
        echo "Install it with your package manager (e.g. brew install just), then run this again." >&2
        exit 1
    fi
    if [ "$(installed_version wasm-bindgen)" != "$WASM_BINDGEN_VERSION" ]; then
        echo "▶ building wasm-bindgen $WASM_BINDGEN_VERSION from source (no pinned binary for this system)…"
        cargo install wasm-bindgen-cli --version "$WASM_BINDGEN_VERSION" --locked --force
    fi
    check_bun
    echo "✓ just $(installed_version just), wasm-bindgen $(installed_version wasm-bindgen)"
    exit 0
fi

if [ -d "$HOME/.cargo/bin" ]; then
    BIN_DIR="$HOME/.cargo/bin"
else
    BIN_DIR="$HOME/.local/bin"
fi
mkdir -p "$BIN_DIR"
CALLER_PATH="$PATH"
export PATH="$BIN_DIR:$PATH"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# fetch <archive name> <url> <path of the binary inside the archive>
fetch() {
    local name="$1" url="$2" member="$3"
    local expected actual
    expected="$(checksum "$name")"
    echo "▶ installing $name…"
    mkdir -p "$TMP_DIR/$name"
    curl -fsSL --retry 3 --retry-delay 2 --max-time 120 -o "$TMP_DIR/$name.tar.gz" "$url"
    actual="$(sha256sum "$TMP_DIR/$name.tar.gz" | cut -d' ' -f1)"
    if [ "$actual" != "$expected" ]; then
        echo "ERROR: checksum mismatch for $url" >&2
        echo "  expected $expected" >&2
        echo "  got      $actual" >&2
        exit 1
    fi
    tar -xzf "$TMP_DIR/$name.tar.gz" -C "$TMP_DIR/$name" "$member"
    install -m 0755 "$TMP_DIR/$name/$member" "$BIN_DIR/$(basename "$member")"
}

if [ "$(installed_version just)" != "$JUST_VERSION" ]; then
    name="just-$JUST_VERSION-$TRIPLE"
    fetch "$name" "https://github.com/casey/just/releases/download/$JUST_VERSION/$name.tar.gz" just
fi

if [ "$(installed_version wasm-bindgen)" != "$WASM_BINDGEN_VERSION" ]; then
    name="wasm-bindgen-$WASM_BINDGEN_VERSION-$TRIPLE"
    fetch "$name" "https://github.com/rustwasm/wasm-bindgen/releases/download/$WASM_BINDGEN_VERSION/$name.tar.gz" "$name/wasm-bindgen"
fi

# Later steps of a GitHub Actions job get the directory on PATH.
if [ -n "${GITHUB_PATH:-}" ]; then
    echo "$BIN_DIR" >>"$GITHUB_PATH"
    CALLER_PATH="$BIN_DIR:$CALLER_PATH"
fi

# What the caller's shell will run must be the pinned version: a missing PATH
# entry or another copy earlier on PATH would otherwise go unnoticed.
check_resolves() {
    local tool="$1" pinned="$2" found
    found="$(PATH="$CALLER_PATH" command -v "$tool" || true)"
    if [ -z "$found" ]; then
        echo "ERROR: $tool is installed in $BIN_DIR, which is not on your PATH." >&2
        echo "Add it: export PATH=\"$BIN_DIR:\$PATH\"" >&2
        exit 1
    fi
    if [ "$("$found" --version | awk '{print $2}')" != "$pinned" ]; then
        echo "ERROR: \`$tool\` resolves to $found, which is not the pinned $pinned." >&2
        echo "Remove that copy, or put $BIN_DIR before it on PATH." >&2
        exit 1
    fi
}
check_resolves just "$JUST_VERSION"
check_resolves wasm-bindgen "$WASM_BINDGEN_VERSION"
check_bun

echo "✓ just $(installed_version just), wasm-bindgen $(installed_version wasm-bindgen) in $BIN_DIR"
