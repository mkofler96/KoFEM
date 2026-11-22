// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The compiled C++ engine is published to a container registry (GHCR) as an
// OCI artifact `kofem-engine:engine-<hash>`, not as a GitHub Release: the
// repository is archived by Zenodo, which turns every GitHub Release into a
// new version of the software record (KOF-450).
//
// scripts/publish-wasm-engine.sh pushes it (CI, on main and develop) and
// scripts/fetch-wasm-engine.sh downloads it, both with plain curl. Each test
// runs the real scripts in a scratch folder with a fake `curl` on PATH that
// serves a small OCI registry kept in a folder and logs every request.

import { spawnSync } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
const HOST = "registry.test";
const NAME = "example/kofem-engine";
const IMAGE = `${HOST}/${NAME}`;
const ENGINE_ID = "engine-0123456789ab";
const PUSH_SECRET = "push-secret";
const ASSETS = ["kofem_wasm_emcc.js", "kofem_wasm_emcc.wasm"];

// A registry in a folder: blobs/<hex> and manifests/<reference>. It knows only
// the repository NAME; any other repository is denied, as GHCR denies a
// package that does not exist or is not public. Push needs the user:password
// `ci:${PUSH_SECRET}` at the token endpoint.
const FAKE_CURL = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const env = process.env;
const die = (msg) => { process.stderr.write("fake curl: " + msg + "\\n"); process.exit(2); };
const opt = { headers: [], method: null, head: false, fail: false, out: null, dump: null, write: null, user: null, data: null, url: null };
const WITH_ARG = { o: "out", w: "write", H: "header", u: "user", X: "method", D: "dump" };
const set = (key, value) => { if (key === "header") opt.headers.push(value); else opt[key] = value; };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    if (a === "--retry" || a === "--retry-delay") i++;
    else if (a === "--data-binary") opt.data = args[++i];
    else if (a === "--progress-bar") {}
    else die("unexpected " + a);
  } else if (a.startsWith("-") && a.length > 1) {
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      if (c in WITH_ARG) { set(WITH_ARG[c], j < a.length - 1 ? a.slice(j + 1) : args[++i]); break; }
      if (c === "f") opt.fail = true;
      else if (c === "I") opt.head = true;
      else if (!"sSL".includes(c)) die("unexpected -" + c);
    }
  } else {
    if (opt.url) die("two URLs: " + opt.url + " and " + a);
    opt.url = a;
  }
}
if (!opt.url) die("no URL");
const method = opt.head ? "HEAD" : opt.method ?? (opt.data ? "POST" : "GET");
appendFileSync(env.FAKE_LOG, method + " " + opt.url + "\\n");

const reg = env.FAKE_REGISTRY;
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const header = (name) => {
  const h = opt.headers.find((x) => x.toLowerCase().startsWith(name.toLowerCase() + ":"));
  return h ? h.slice(h.indexOf(":") + 1).trim() : null;
};
const error = (status, code) => ({ status, headers: {}, body: JSON.stringify({ errors: [{ code, message: code }] }) });

function respond() {
  const url = new URL(opt.url);
  if (url.protocol !== "https:" || url.host !== "${HOST}") return { transport: 6 };
  if (url.pathname === "/token") {
    const scope = url.searchParams.get("scope") ?? "";
    const m = scope.match(/^repository:(.+):([a-z,]+)$/);
    if (!m || url.searchParams.get("service") !== "${HOST}") return error(400, "BAD_SCOPE");
    if (m[1] !== "${NAME}") return error(403, "DENIED");
    if (m[2].split(",").includes("push")) {
      if (opt.user !== "ci:${PUSH_SECRET}") return error(401, "UNAUTHORIZED");
      return { status: 200, headers: {}, body: '{"token":"push-token"}' };
    }
    return { status: 200, headers: {}, body: '{"token":"pull-token"}' };
  }
  const prefix = "/v2/${NAME}/";
  if (!url.pathname.startsWith(prefix)) return error(404, "NAME_UNKNOWN");
  const token = (header("Authorization") ?? "").replace(/^Bearer /, "");
  if (token !== "pull-token" && token !== "push-token") return error(401, "UNAUTHORIZED");
  const writing = method === "POST" || method === "PUT";
  if (writing && token !== "push-token") return error(403, "DENIED");
  const rest = url.pathname.slice(prefix.length);
  const data = opt.data ? readFileSync(opt.data.replace(/^@/, "")) : null;
  let m;
  if ((m = rest.match(/^manifests\\/([^/]+)$/))) {
    const file = join(reg, "manifests", m[1]);
    if (method === "PUT") {
      if (header("Content-Type") !== "application/vnd.oci.image.manifest.v1+json") return error(400, "MANIFEST_INVALID");
      JSON.parse(data.toString());
      mkdirSync(join(reg, "manifests"), { recursive: true });
      writeFileSync(file, data);
      return { status: 201, headers: { "docker-content-digest": "sha256:" + sha(data) }, body: "" };
    }
    if (!existsSync(file)) return error(404, "MANIFEST_UNKNOWN");
    const body = readFileSync(file);
    return { status: 200, headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" }, body };
  }
  if ((m = rest.match(/^blobs\\/sha256:([0-9a-f]{64})$/))) {
    const file = join(reg, "blobs", m[1]);
    if (!existsSync(file)) return error(404, "BLOB_UNKNOWN");
    return { status: 200, headers: {}, body: readFileSync(file) };
  }
  if (rest === "blobs/uploads/" && method === "POST")
    return { status: 202, headers: { location: "/v2/${NAME}/blobs/uploads/" + randomUUID() + "?_state=s" }, body: "" };
  if (/^blobs\\/uploads\\/[0-9a-f-]+$/.test(rest) && method === "PUT") {
    const digest = url.searchParams.get("digest") ?? "";
    if (!data || digest !== "sha256:" + sha(data)) return error(400, "DIGEST_INVALID");
    mkdirSync(join(reg, "blobs"), { recursive: true });
    writeFileSync(join(reg, "blobs", sha(data)), data);
    return { status: 201, headers: { "docker-content-digest": digest }, body: "" };
  }
  return error(405, "UNSUPPORTED");
}

const res = respond();
if (res.transport) { process.stderr.write("curl: (6) Could not resolve host\\n"); process.exit(res.transport); }
const headText = "HTTP/2 " + res.status + "\\r\\n" + Object.entries(res.headers).map(([k, v]) => k + ": " + v + "\\r\\n").join("") + "\\r\\n";
if (opt.dump) writeFileSync(opt.dump, headText);
if (opt.fail && res.status >= 400) {
  process.stderr.write("curl: (22) The requested URL returned error: " + res.status + "\\n");
  process.exit(22);
}
const body = opt.head ? headText : res.body;
if (opt.out) writeFileSync(opt.out, body); else process.stdout.write(body);
if (opt.write) process.stdout.write(opt.write.replaceAll("%{http_code}", String(res.status)));
`;

// Set by beforeEach for each test.
let dir = "";
let work = "";
let registry = "";
let log = "";
let bin = "";
let dist = "";

function run(cmd, env = {}) {
  const result = spawnSync(cmd, {
    cwd: work,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_REGISTRY: registry,
      FAKE_LOG: log,
      KOFEM_ENGINE_IMAGE: IMAGE,
      KOFEM_ENGINE_ID: ENGINE_ID,
      KOFEM_WASM_SKIP_FETCH: "",
      ...env,
    },
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString() + result.stderr.toString(),
  };
}

const fetchEngine = (...args) =>
  run(["bash", "scripts/fetch-wasm-engine.sh", ...args]);

const publishEngine = (env = {}) =>
  run(["bash", "scripts/publish-wasm-engine.sh", dist], {
    REGISTRY_USER: "ci",
    REGISTRY_TOKEN: PUSH_SECRET,
    GITHUB_SHA: "f".repeat(40),
    GITHUB_REPOSITORY: "example/KoFEM",
    ...env,
  });

const requests = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
const hex = (buf) => createHash("sha256").update(buf).digest("hex");
const pkg = (file) => join(work, "web/src/wasm/pkg", file);

function storeBlob(content) {
  mkdirSync(join(registry, "blobs"), { recursive: true });
  writeFileSync(join(registry, "blobs", hex(content)), content);
  return { digest: `sha256:${hex(content)}`, size: Buffer.byteLength(content) };
}

// A manifest as another OCI client might write it: pretty-printed, and with
// the annotations ahead of the digest in each layer. The fetch must find each
// file by its title, not by where it sits in the text.
function seedEngine(tag, files) {
  const config = storeBlob("{}");
  const layers = Object.entries(files).map(([title, content]) => {
    const { digest, size } = storeBlob(content);
    return {
      annotations: { "org.opencontainers.image.title": title },
      mediaType: "application/octet-stream",
      size,
      digest,
    };
  });
  mkdirSync(join(registry, "manifests"), { recursive: true });
  writeFileSync(
    join(registry, "manifests", tag),
    JSON.stringify(
      {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: { mediaType: "application/vnd.oci.empty.v1+json", ...config },
        layers,
      },
      null,
      2,
    ),
  );
}

const ENGINE = {
  "kofem_wasm_emcc.js": "export default function engine() {}\n",
  "kofem_wasm_emcc.wasm": "\0asm wasm bytes",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kofem-engine-registry-"));
  work = join(dir, "work");
  registry = join(dir, "registry");
  log = join(dir, "curl.log");
  bin = join(dir, "bin");
  dist = join(dir, "dist");
  for (const d of [registry, bin, dist, join(work, "scripts")])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "curl"), FAKE_CURL);
  chmodSync(join(bin, "curl"), 0o755);
  for (const script of ["fetch-wasm-engine.sh", "publish-wasm-engine.sh"])
    copyFileSync(join(REPO, "scripts", script), join(work, "scripts", script));
  for (const [file, content] of Object.entries(ENGINE))
    writeFileSync(join(dist, file), content);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fetch-wasm-engine.sh installs the engine from the registry", () => {
  test("the published files for these sources, with their stamp", () => {
    seedEngine(ENGINE_ID, ENGINE);

    const result = fetchEngine();

    expect(result.code, result.out).toBe(0);
    for (const [file, content] of Object.entries(ENGINE))
      expect(readFileSync(pkg(file), "utf8")).toBe(content);
    expect(readFileSync(pkg(".engine-id"), "utf8").trim()).toBe(ENGINE_ID);
  });

  test("asks only the registry, never GitHub Releases", () => {
    seedEngine(ENGINE_ID, ENGINE);

    const result = fetchEngine();

    expect(result.code, result.out).toBe(0);
    const urls = requests().trim().split("\n");
    expect(urls.length).toBeGreaterThan(0);
    for (const line of urls) expect(line).toContain(`https://${HOST}/`);
  });

  test("makes no request when the stamp already matches", () => {
    mkdirSync(join(work, "web/src/wasm/pkg"), { recursive: true });
    for (const [file, content] of Object.entries(ENGINE))
      writeFileSync(pkg(file), content);
    writeFileSync(pkg(".engine-id"), `${ENGINE_ID}\n`);

    const result = fetchEngine();

    expect(result.code, result.out).toBe(0);
    expect(requests()).toBe("");
  });
});

describe("fetch-wasm-engine.sh refuses what it cannot install", () => {
  test("an unpublished engine fails and says how to build it", () => {
    const result = fetchEngine();

    expect(result.code).not.toBe(0);
    expect(result.out).toContain(ENGINE_ID);
    expect(result.out).toContain("docker-build-wasm.sh");
    expect(existsSync(pkg("kofem_wasm_emcc.wasm"))).toBe(false);
  });

  test("with --optional an unpublished engine installs nothing and is no error", () => {
    const result = fetchEngine("--optional");

    expect(result.code, result.out).toBe(0);
    expect(existsSync(pkg("kofem_wasm_emcc.wasm"))).toBe(false);
  });

  test("a package that is missing or not public is named as such", () => {
    const result = run(["bash", "scripts/fetch-wasm-engine.sh"], {
      KOFEM_ENGINE_IMAGE: `${HOST}/someone/private-engine`,
    });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("not public");
  });

  test("a file whose bytes do not match its digest is refused, and nothing is installed", () => {
    seedEngine(ENGINE_ID, ENGINE);
    const wasm = hex(ENGINE["kofem_wasm_emcc.wasm"]);
    writeFileSync(join(registry, "blobs", wasm), "tampered");

    const result = fetchEngine();

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("digest");
    for (const file of ASSETS) expect(existsSync(pkg(file))).toBe(false);
  });

  test("a manifest without one of the files is refused", () => {
    seedEngine(ENGINE_ID, {
      "kofem_wasm_emcc.js": ENGINE["kofem_wasm_emcc.js"],
    });

    const result = fetchEngine();

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("kofem_wasm_emcc.wasm");
    for (const file of ASSETS) expect(existsSync(pkg(file))).toBe(false);
  });
});

describe("publish-wasm-engine.sh pushes the engine to the registry", () => {
  test("both files under the engine ID, which the fetch installs back", () => {
    const published = publishEngine();
    expect(published.code, published.out).toBe(0);

    const manifest = JSON.parse(
      readFileSync(join(registry, "manifests", ENGINE_ID), "utf8"),
    );
    expect(manifest.artifactType).toBe("application/vnd.kofem.engine.v1");
    expect(
      manifest.layers.map(
        (layer) => layer.annotations["org.opencontainers.image.title"],
      ),
    ).toEqual(ASSETS);
    expect(manifest.annotations["org.opencontainers.image.source"]).toBe(
      "https://github.com/example/KoFEM",
    );

    const fetched = fetchEngine();
    expect(fetched.code, fetched.out).toBe(0);
    for (const [file, content] of Object.entries(ENGINE))
      expect(readFileSync(pkg(file), "utf8")).toBe(content);
  });

  test("an engine already published is left as it is", () => {
    seedEngine(ENGINE_ID, ENGINE);
    const before = readFileSync(join(registry, "manifests", ENGINE_ID));

    const result = publishEngine();

    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("already published");
    expect(requests()).not.toMatch(/^(PUT|POST) /m);
    expect(readFileSync(join(registry, "manifests", ENGINE_ID))).toEqual(
      before,
    );
  });

  test("a blob the registry already holds is not uploaded again", () => {
    const { digest } = storeBlob(ENGINE["kofem_wasm_emcc.wasm"]);

    const result = publishEngine();

    expect(result.code, result.out).toBe(0);
    expect(requests()).not.toContain(`digest=${digest}`);
    expect(requests().match(/^POST /gm)).toHaveLength(2);
  });

  test("a wrong token is refused before anything is uploaded", () => {
    const result = publishEngine({ REGISTRY_TOKEN: "wrong" });

    expect(result.code).not.toBe(0);
    expect(requests()).not.toMatch(/^(PUT|POST) /m);
  });

  test("no token is an error before any request", () => {
    const result = publishEngine({ REGISTRY_TOKEN: "" });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("REGISTRY_TOKEN");
    expect(requests()).toBe("");
  });

  test("an ID that is not engine-<12 hex digits> is an error before any request", () => {
    const result = publishEngine({ KOFEM_ENGINE_ID: "latest" });

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("latest");
    expect(requests()).toBe("");
  });

  test("a missing file is an error before any request", () => {
    rmSync(join(dist, "kofem_wasm_emcc.wasm"));

    const result = publishEngine();

    expect(result.code).not.toBe(0);
    expect(result.out).toContain("kofem_wasm_emcc.wasm");
    expect(requests()).toBe("");
  });
});
