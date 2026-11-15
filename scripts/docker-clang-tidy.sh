#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

# scripts/docker-clang-tidy.sh
#
# Run scripts/clang-tidy.sh inside the kofem-dependencies image, for machines
# that build the engine through Docker (scripts/docker-build-wasm.sh) and have
# no local Emscripten SDK or clang-tidy >= 20. The pre-commit hook falls back
# to this script when the local toolchain is missing.
#
# The dependency image is Ubuntu 22.04, whose apt has no clang-tidy-20, so the
# first run builds a small local image on top of it with clang-tidy from PyPI
# (pinned below). Later runs reuse that image and the compile database kept in
# a named Docker volume. The repository is mounted read-only.
#
# Usage:
#   scripts/docker-clang-tidy.sh [file.cpp ...]   # default: all of engine/cpp/*.cpp
#   (file paths are relative to the repository root or absolute inside it)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Same image and platform as scripts/docker-build-wasm.sh and CI.
BASE_IMAGE="ghcr.io/mkofler96/kofem-dependencies:0.0.2"
PLATFORM="linux/amd64"
CLANG_TIDY_VERSION="20.1.0"
TIDY_IMAGE="kofem-clang-tidy:0.0.2-clang-tidy-${CLANG_TIDY_VERSION}"
BUILD_VOLUME="kofem-clang-tidy-build"

if ! command -v docker &>/dev/null; then
    echo "ERROR: docker not found." >&2
    echo "Install Docker, or install the local toolchain for scripts/clang-tidy.sh" >&2
    echo "(bash scripts/fetch-wasm-deps.sh and clang-tidy >= 20)." >&2
    exit 1
fi
if ! docker info &>/dev/null; then
    echo "ERROR: Docker daemon is not running. Start Docker and try again." >&2
    exit 1
fi

if ! docker image inspect "$TIDY_IMAGE" &>/dev/null; then
    echo "▶ building ${TIDY_IMAGE} (one-time)…"
    docker build --platform "$PLATFORM" -t "$TIDY_IMAGE" - <<EOF
FROM ${BASE_IMAGE}
RUN apt-get update \\
    && apt-get install -y --no-install-recommends ninja-build python3-pip \\
    && rm -rf /var/lib/apt/lists/* \\
    && python3 -m pip install --no-cache-dir clang-tidy==${CLANG_TIDY_VERSION}
EOF
fi

# Map file arguments to their path inside the container. The ${FILES[@]+…}
# expansion below keeps an empty array legal under `set -u` in macOS bash 3.2.
FILES=()
for file in "$@"; do
    case "$file" in
    "$REPO_ROOT"/*) FILES+=("/repo/${file#"$REPO_ROOT"/}") ;;
    /*)
        echo "ERROR: ${file} is outside the repository (${REPO_ROOT})." >&2
        exit 1
        ;;
    *) FILES+=("/repo/${file}") ;;
    esac
done

# The compile database lives in a volume, not in target/wasm-build: the repo
# mount is read-only, and a host build's database records host paths.
docker run --rm \
    --platform "$PLATFORM" \
    -v "${REPO_ROOT}:/repo:ro" \
    -v "${BUILD_VOLUME}:/build" \
    -w /repo \
    -e KOFEM_TIDY_BUILD_DIR=/build \
    "$TIDY_IMAGE" \
    bash scripts/clang-tidy.sh ${FILES[@]+"${FILES[@]}"}
