#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# scripts/engine-version.sh
#
# Print the engine build ID for the current working tree, e.g. `engine-4f1c2a9b3d70`.
#
# The compiled engine is no longer committed (KOF-186): it is published as a
# GitHub Release named after this ID and pulled down by scripts/fetch-wasm-engine.sh.
# The ID is a content hash rather than a version number, which is what makes that
# safe — the same sources always resolve to the same published binary, and changed
# sources can never resolve to a stale one.
#
# Hashed inputs — everything that determines the compiled output:
#
#   engine/                      C++ sources, headers and CMakeLists
#   scripts/build-wasm.sh        compiler/link flags and the copy step
#   scripts/fetch-wasm-deps.sh   pins the dependency image tag, and therefore the
#                                Emscripten/OCCT/Netgen/MFEM baked into the binary
#
# Deliberately over-inclusive: a comment-only edit to any of these yields a new ID
# and one extra build. Under-inclusion is the dangerous direction — it would map
# changed sources onto a stale published binary — so err towards rebuilding.
#
# Requires a git checkout. Consumers that may run without one (CI containers built
# from a source tarball) should pass the ID down via KOFEM_ENGINE_ID instead.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256
    else
        echo "ERROR: neither sha256sum nor shasum found" >&2
        exit 1
    fi
}

# --cached --others lists tracked *and* untracked-but-not-ignored files, so an
# uncommitted engine edit or a brand-new source file gets its own ID instead of
# masquerading as the committed one. git hash-object reads the worktree, so the
# hash follows the files you are about to build, not the index.
#
# LC_ALL=C sort keeps the ordering locale-independent; without it the same tree
# can hash differently on two machines.
FILES="$(git ls-files --cached --others --exclude-standard -- \
    engine scripts/build-wasm.sh scripts/fetch-wasm-deps.sh | LC_ALL=C sort -u)"

[ -n "$FILES" ] || {
    echo "ERROR: no engine sources found under ${REPO_ROOT} — wrong directory, or a checkout without git metadata?" >&2
    exit 1
}

digest_tree() {
    while IFS= read -r f; do
        if [ -f "$f" ]; then
            printf '%s %s\n' "$(git hash-object -- "$f")" "$f"
        else
            # Staged deletion: still in the index, gone from the worktree.
            # Recorded so that removing a source changes the ID.
            printf 'deleted %s\n' "$f"
        fi
    done <<<"$FILES"
}

echo "engine-$(digest_tree | sha256 | cut -c1-12)"
