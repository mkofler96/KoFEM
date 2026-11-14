// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What the C++ engine's solvers computed, stored for the tests that compare
// the Rust module against them (KOF-309). The solvers left the engine; the
// engine keeps CAD import and meshing. A test file loads the engine with
// `loadEngine({ solves: import.meta.url })`, and its solver entries —
// solve_linear_elastic, solve_shell, solve_coupled and the three
// optimize_topology entries — answer from tests/fixtures/engine-solves/
// <test file>.json.gz instead: the returned value, the log lines the call
// printed, the densities it streamed, or the C++ exception it threw, exactly
// as the engine produced them.
//
// Each call is stored under a hash of its method and inputs. A call whose
// inputs no stored call matches throws: the C++ result for changed inputs no
// longer exists, so the comparison cannot silently drift.
//
// The fixtures were recorded with KOFEM_RECORD_ENGINE_SOLVES=1 against the
// last engine that had the solvers (engine-3397ae8ea1eb).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

export const SOLVER_ENTRIES = [
  "solve_linear_elastic",
  "solve_shell",
  "solve_coupled",
  "optimize_topology",
  "optimize_topology_shell",
  "optimize_topology_coupled",
];

const RECORD = process.env.KOFEM_RECORD_ENGINE_SOLVES === "1";
const FIXTURES = fileURLToPath(
  new URL("../fixtures/engine-solves/", import.meta.url),
);

const TYPED = {
  Float64Array,
  Float32Array,
  Int32Array,
  Uint32Array,
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
};

// A value as plain JSON: typed arrays as base64 of their bytes, functions as a
// marker (callbacks are not inputs), undefined kept apart from null.
function encode(value) {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value !== "object") {
    if (typeof value === "function") return { $function: true };
    if (typeof value === "number" && !Number.isFinite(value))
      return { $number: String(value) };
    return value;
  }
  for (const [name, Type] of Object.entries(TYPED))
    if (value instanceof Type)
      return {
        $typed: name,
        data: Buffer.from(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        ).toString("base64"),
      };
  if (Array.isArray(value)) return value.map(encode);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = encode(value[key]);
  return out;
}

function decode(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  if (value.$undefined) return undefined;
  if (value.$number !== undefined) return Number(value.$number);
  if (value.$typed) {
    const bytes = Buffer.from(value.data, "base64");
    const Type = TYPED[value.$typed];
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Type(copy.buffer);
  }
  const out = {};
  for (const [key, inner] of Object.entries(value)) out[key] = decode(inner);
  return out;
}

const keyOf = (method, args) =>
  createHash("sha256")
    .update(JSON.stringify({ method, args: encode(args) }))
    .digest("hex");

const fixtureFile = (testUrl) =>
  `${FIXTURES}${basename(fileURLToPath(testUrl))}.json.gz`;

const stores = new Map();

// The stored calls of one test file, read once.
function storeOf(testUrl) {
  const file = fixtureFile(testUrl);
  if (!stores.has(file)) {
    const calls = existsSync(file)
      ? JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"))
      : {};
    stores.set(file, { file, calls });
  }
  return stores.get(file);
}

function save(store) {
  mkdirSync(dirname(store.file), { recursive: true });
  const sorted = Object.fromEntries(
    Object.entries(store.calls).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(store.file, gzipSync(JSON.stringify(sorted), { level: 9 }));
}

/**
 * `engine` with its solver entries answered from the test file's stored C++
 * results (or, with KOFEM_RECORD_ENGINE_SOLVES=1, recorded from the engine
 * itself). `print` is the log sink the test passed to loadEngine; replayed
 * calls print what the engine printed.
 *
 * @param {object} engine          a loaded engine instance
 * @param {string} testUrl         the test file's import.meta.url
 * @param {{ print?: (line: string) => void, capture: { lines: string[] | null } }} log
 */
export function withStoredSolves(engine, testUrl, log) {
  const store = storeOf(testUrl);
  // C++ exceptions of replayed calls: a token per thrown call, decoded by
  // getExceptionMessage as the engine decodes its heap pointers.
  const thrown = new Map();
  let nextToken = -1;
  const decodeException = engine.getExceptionMessage?.bind(engine);

  const solvers = Object.fromEntries(
    SOLVER_ENTRIES.map((method) => [
      method,
      (...args) => (RECORD ? record(method, args) : replay(method, args)),
    ]),
  );

  function record(method, args) {
    const real = engine[method];
    if (typeof real !== "function")
      throw new Error(
        `KOFEM_RECORD_ENGINE_SOLVES: this engine has no ${method}; record against an engine that still has the C++ solvers`,
      );
    const streamed = [];
    const callArgs = args.map((arg) =>
      typeof arg === "function"
        ? (...values) => {
            streamed.push(values.map((v) => encode(copyOf(v))));
            return arg(...values);
          }
        : arg,
    );
    log.capture.lines = [];
    const entry = { method, streamed };
    try {
      entry.result = encode(engine[method](...callArgs));
    } catch (error) {
      if (typeof error === "number" && decodeException)
        entry.cppException = decodeException(error);
      else entry.error = String(error?.message ?? error);
    } finally {
      entry.printed = log.capture.lines;
      log.capture.lines = null;
    }
    store.calls[keyOf(method, args)] = entry;
    save(store);
    return deliver(entry, args);
  }

  function replay(method, args) {
    const entry = store.calls[keyOf(method, args)];
    if (!entry)
      throw new Error(
        `${basename(fileURLToPath(testUrl))}: no stored C++ result for this ${method} call. ` +
          "The C++ solvers left the engine (KOF-309), so a result exists only for the inputs " +
          "recorded in tests/fixtures/engine-solves; this call's inputs differ from every one.",
      );
    for (const line of entry.printed) log.print?.(line);
    return deliver(entry, args);
  }

  // Stream the recorded densities to the caller's callback (a recording
  // already did), then return or throw what the engine did.
  function deliver(entry, args) {
    if (!RECORD) {
      const callback = args.find((arg) => typeof arg === "function");
      if (callback)
        for (const values of entry.streamed) callback(...values.map(decode));
    }
    if (entry.cppException) {
      const token = nextToken--;
      thrown.set(token, entry.cppException);
      throw token;
    }
    if (entry.error !== undefined) throw new Error(entry.error);
    return decode(entry.result);
  }

  return new Proxy(engine, {
    get(target, property, receiver) {
      if (property in solvers) return solvers[property];
      if (property === "getExceptionMessage")
        return (pointer) =>
          thrown.has(pointer) ? thrown.get(pointer) : decodeException(pointer);
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// The engine reuses the buffers it streams; keep what it streamed then.
function copyOf(value) {
  for (const Type of Object.values(TYPED))
    if (value instanceof Type) return new Type(value);
  return value;
}
