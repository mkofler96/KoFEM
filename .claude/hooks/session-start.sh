#!/bin/bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# SessionStart hook: make the WASM build toolchain available in Claude Code on the
# web. Locally and in CI the Docker image (scripts/docker-build-wasm.sh) is used,
# so this only runs in the remote sandbox where Docker's vfs storage driver can't
# unpack the dependency image.
set -euo pipefail

# Only run in the remote (web) sandbox.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
    exit 0
fi

REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

# The container clones fresh, so the first-time setup from AGENTS.md never ran
# here — without it the .githooks/pre-commit checks (fmt + clippy) are
# silently skipped on every commit made in a remote session.
git -C "$REPO" config core.hooksPath .githooks

bash "$REPO/scripts/fetch-wasm-deps.sh"

# Everything a test run needs, so the first `just test-…` works without manual
# steps: the pinned command-line tools (just, wasm-bindgen), the web
# dependencies, the published engine (it is not committed, KOF-186) and the
# Rust module. A session branched off an unmerged engine change has no engine
# release to fetch and must build one (bash scripts/build-wasm.sh); that is
# not a reason to fail startup, so a setup that does not finish is reported
# and the session starts anyway.
# The tools install into ~/.cargo/bin (or ~/.local/bin without rustup); both
# are on a session's PATH, but not necessarily on this hook's.
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
if ! { bash "$REPO/scripts/install-tools.sh" && (cd "$REPO" && just setup); }; then
    echo "[setup] \`just setup\` did not finish — see the error above, fix it and run \`just setup\` again." >&2
fi

# clang-tidy >= 20 for scripts/clang-tidy.sh (the C++ engine linter, mirroring
# the DeepSource rules — see .clang-tidy). The sandbox's default clang-tidy-18
# cannot parse the emsdk clang-22-era headers.
if ! command -v clang-tidy-20 >/dev/null 2>&1; then
    echo "[clang-tidy] installing clang-tidy-20…"
    apt-get update -qq && apt-get install -y -qq clang-tidy-20
fi

# Persist the build environment for the whole session so `bash scripts/build-wasm.sh`
# works without re-exporting anything. The node bin dir is globbed so it survives
# emsdk version bumps in the dependency image.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    NODE_BIN="$(echo /emsdk/node/*/bin)"
    {
        echo 'export EMSDK=/emsdk'
        echo "export PATH=\"/emsdk:/emsdk/upstream/emscripten:${NODE_BIN}:\$PATH\""
        echo 'export OCCT_WASM_ROOT=/opt/kofem-deps/occt'
        echo 'export NETGEN_WASM_ROOT=/opt/kofem-deps/netgen'
        echo 'export MFEM_WASM_ROOT=/opt/kofem-deps/mfem'
    } >>"$CLAUDE_ENV_FILE"
fi

# ── Docker Auto-Setup for Constrained Environments ──
# Makes `docker` usable for general purposes. NOTE: this does NOT enable
# scripts/docker-build-wasm.sh here — the vfs storage driver can't unpack the
# dependency image under the sandbox disk quota, which is why the Docker-free
# fetch above exists. This block only ensures a daemon is running if one isn't.
if ! command -v docker &>/dev/null || ! docker info &>/dev/null 2>&1; then
    echo "[docker-setup] Docker not available, attempting setup..."

    # Clean stale docker0 interface (prevents daemon startup failure)
    if ip link show docker0 &>/dev/null 2>&1; then
        ip link delete docker0 2>/dev/null || true
    fi

    # Start dockerd with constrained-environment flags:
    #   --storage-driver=vfs    : works on kernel 4.4.0 (overlay2 needs newer kernel)
    #   --iptables=false        : kernel doesn't support iptables in containers
    #   --ip6tables=false       : same for IPv6
    dockerd \
        --iptables=false \
        --ip6tables=false \
        --storage-driver=vfs \
        &>/tmp/dockerd.log &

    # Wait for Docker to be ready (up to 30s)
    for i in $(seq 1 30); do
        if docker info &>/dev/null 2>&1; then
            echo "[docker-setup] Docker ready after ${i}s"
            break
        fi
        sleep 1
    done

    if ! docker info &>/dev/null 2>&1; then
        echo "[docker-setup] Docker failed to start. Check /tmp/dockerd.log"
    fi
fi
