// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// scripts/tag-release-image.sh gives each published release vX.Y.Z a plain
// `kofem-web:vX.Y.Z` image tag on the digest main already built and tested
// for the release commit (`kofem-web:vX.Y.Z-<sha7>`). It never rebuilds,
// never falls back to `latest`, and never moves a release tag that exists.
//
// Each test runs the real script in a scratch repository whose origin holds
// the release tags, with a fake `docker` on PATH that keeps a registry of
// tag -> digest in a folder and logs every call.

import { spawnSync } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const IMAGE = "ghcr.io/example/kofem-web";

// The registry is a folder: one file per tag, holding that tag's digest.
// FAKE_CREATE_DIGEST makes `imagetools create` store another digest than it
// was given, as a registry that rewrote the manifest would.
const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$FAKE_LOG"
[ "$1 $2" = "buildx imagetools" ] || { echo "fake docker: unexpected $*" >&2; exit 2; }
key() { printf '%s' "\${1##*/}" | tr ':@' '__'; }
case "$3" in
  inspect)
    file="$FAKE_REGISTRY/$(key "$4")"
    [ -f "$file" ] || { echo "ERROR: $4: not found" >&2; exit 1; }
    printf '{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"%s","size":1}\\n' "$(cat "$file")"
    ;;
  create)
    [ "$4" = "--tag" ] || { echo "fake docker: expected --tag" >&2; exit 2; }
    src="$6"; digest="\${src##*@}"
    [ -n "\${FAKE_CREATE_DIGEST:-}" ] && digest="$FAKE_CREATE_DIGEST"
    printf '%s' "$digest" > "$FAKE_REGISTRY/$(key "$5")"
    ;;
  *) echo "fake docker: unexpected $*" >&2; exit 2 ;;
esac
`;

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_LATEST = `sha256:${"f".repeat(64)}`;

let dir;
let work;
let registry;
let log;
let bin;

function run(cmd, cwd, env = {}) {
  const result = spawnSync(cmd, { cwd, env: { ...process.env, ...env } });
  return {
    code: result.exitCode,
    out: result.stdout.toString() + result.stderr.toString(),
  };
}

function git(...args) {
  const result = run(["git", ...args], work);
  if (result.code !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.out}`);
  return result.out.trim();
}

// A checkout at `version` whose CHANGELOG.md lists every version in `versions`.
function commitVersion(version, versions) {
  writeFileSync(
    join(work, "web/package.json"),
    JSON.stringify({ version }, null, 2),
  );
  writeFileSync(
    join(work, "Cargo.toml"),
    `[workspace.package]\nversion = "${version}"\n`,
  );
  const sections = [...versions]
    .reverse()
    .map((v) => `## [${v}] - 2026-11-01\n\n- Release ${v}.\n`)
    .join("\n");
  writeFileSync(join(work, "CHANGELOG.md"), `# Changelog\n\n${sections}`);
  git("add", "-A");
  git("commit", "-q", "-m", `Release v${version}`);
  return git("rev-parse", "HEAD");
}

function tagRelease(version, sha) {
  git("tag", `v${version}`, sha);
  git("push", "-q", "origin", `v${version}`);
}

function setImage(tag, digest) {
  writeFileSync(join(registry, `kofem-web_${tag}`), digest);
}

function imageDigest(tag) {
  const file = join(registry, `kofem-web_${tag}`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function tagImages(env = {}) {
  return run(["bash", "scripts/tag-release-image.sh"], work, {
    IMAGE,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_REGISTRY: registry,
    FAKE_LOG: log,
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...env,
  });
}

function dockerCalls() {
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kofem-release-image-"));
  work = join(dir, "work");
  registry = join(dir, "registry");
  log = join(dir, "docker.log");
  bin = join(dir, "bin");
  for (const d of [registry, bin, join(work, "scripts"), join(work, "web")])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  for (const script of ["tag-release-image.sh", "release-version.sh"])
    copyFileSync(join(REPO, "scripts", script), join(work, "scripts", script));
  writeFileSync(join(work, "Cargo.lock"), "");
  run(["git", "init", "-q", "--bare", join(dir, "origin.git")], dir);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("remote", "add", "origin", join(dir, "origin.git"));
  setImage("latest", DIGEST_LATEST);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a published release gets its version tag", () => {
  test("on the digest of the commit-qualified image main built", () => {
    const sha = commitVersion("0.7.0", ["0.7.0"]);
    tagRelease("0.7.0", sha);
    setImage(`v0.7.0-${sha.slice(0, 7)}`, DIGEST_A);

    const result = tagImages();

    expect(result.code, result.out).toBe(0);
    expect(imageDigest("v0.7.0")).toBe(DIGEST_A);
    expect(dockerCalls()).toContain(
      `create --tag ${IMAGE}:v0.7.0 ${IMAGE}@${DIGEST_A}`,
    );
    expect(result.out).toContain(`${IMAGE}:v0.7.0 -> ${DIGEST_A}`);
  });

  test("a rerun with the same digest changes nothing", () => {
    const sha = commitVersion("0.7.0", ["0.7.0"]);
    tagRelease("0.7.0", sha);
    setImage(`v0.7.0-${sha.slice(0, 7)}`, DIGEST_A);
    setImage("v0.7.0", DIGEST_A);

    const result = tagImages();

    expect(result.code, result.out).toBe(0);
    expect(dockerCalls()).not.toContain("create");
    expect(imageDigest("v0.7.0")).toBe(DIGEST_A);
  });

  test("a version without a release tag yet is left alone", () => {
    const sha = commitVersion("0.7.0", ["0.7.0"]);
    setImage(`v0.7.0-${sha.slice(0, 7)}`, DIGEST_A);

    const result = tagImages();

    expect(result.code, result.out).toBe(0);
    expect(imageDigest("v0.7.0")).toBeNull();
    expect(dockerCalls()).not.toContain("create");
  });
});

describe("a release tag is never moved or guessed", () => {
  test("an existing tag on another digest fails and stays put", () => {
    const sha = commitVersion("0.7.0", ["0.7.0"]);
    tagRelease("0.7.0", sha);
    setImage(`v0.7.0-${sha.slice(0, 7)}`, DIGEST_A);
    setImage("v0.7.0", DIGEST_B);

    const result = tagImages();

    expect(result.code).not.toBe(0);
    expect(result.out).toContain(`${IMAGE}:v0.7.0 points to ${DIGEST_B}`);
    expect(imageDigest("v0.7.0")).toBe(DIGEST_B);
    expect(dockerCalls()).not.toContain("create");
  });

  test("the current release without its commit image fails, never using latest", () => {
    const sha = commitVersion("0.7.0", ["0.7.0"]);
    tagRelease("0.7.0", sha);

    const result = tagImages();

    expect(result.code).not.toBe(0);
    expect(result.out).toContain(`${IMAGE}:v0.7.0-${sha.slice(0, 7)}`);
    expect(imageDigest("v0.7.0")).toBeNull();
    expect(dockerCalls()).not.toContain(":latest");
  });

  test("a tag the registry stores on another digest fails", () => {
    const sha = commitVersion("0.7.0", ["0.7.0"]);
    tagRelease("0.7.0", sha);
    setImage(`v0.7.0-${sha.slice(0, 7)}`, DIGEST_A);

    const result = tagImages({ FAKE_CREATE_DIGEST: DIGEST_B });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain(`expected ${DIGEST_A}`);
  });
});

describe("older releases are backfilled where their image exists", () => {
  test("each gets the image of its own release commit", () => {
    const old = commitVersion("0.6.0", ["0.6.0"]);
    tagRelease("0.6.0", old);
    const current = commitVersion("0.7.0", ["0.6.0", "0.7.0"]);
    tagRelease("0.7.0", current);
    setImage(`v0.6.0-${old.slice(0, 7)}`, DIGEST_B);
    setImage(`v0.7.0-${current.slice(0, 7)}`, DIGEST_A);

    const result = tagImages();

    expect(result.code, result.out).toBe(0);
    expect(imageDigest("v0.6.0")).toBe(DIGEST_B);
    expect(imageDigest("v0.7.0")).toBe(DIGEST_A);
  });

  test("an older release without its image is reported and skipped", () => {
    const old = commitVersion("0.6.0", ["0.6.0"]);
    tagRelease("0.6.0", old);
    const current = commitVersion("0.7.0", ["0.6.0", "0.7.0"]);
    tagRelease("0.7.0", current);
    setImage(`v0.7.0-${current.slice(0, 7)}`, DIGEST_A);

    const result = tagImages();

    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("::warning");
    expect(result.out).toContain(`${IMAGE}:v0.6.0-${old.slice(0, 7)}`);
    expect(imageDigest("v0.6.0")).toBeNull();
    expect(imageDigest("v0.7.0")).toBe(DIGEST_A);
  });

  test("an annotated release tag resolves to its commit", () => {
    const sha = commitVersion("0.7.0", ["0.7.0"]);
    git("tag", "-a", "-m", "KoFEM v0.7.0", "v0.7.0", sha);
    git("push", "-q", "origin", "v0.7.0");
    setImage(`v0.7.0-${sha.slice(0, 7)}`, DIGEST_A);

    const result = tagImages();

    expect(result.code, result.out).toBe(0);
    expect(imageDigest("v0.7.0")).toBe(DIGEST_A);
  });
});
