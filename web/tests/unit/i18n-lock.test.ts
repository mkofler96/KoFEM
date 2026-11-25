// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Stale translations (KOF-468). src/i18n/translations.lock.json records a
// fingerprint of every message in every language, as last confirmed. An
// English message that changes while a translation of it stays the same is a
// translation that no longer says what the English says: the check fails
// until the translation is updated, or the change is confirmed as one that
// needs none (`bun run i18n:lock --confirm <message>`).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  LOCK_FILE,
  catalogFingerprints,
  fingerprint,
  lockProblems,
  updateLock,
  type Lock,
} from "../../scripts/i18n-lock";

const confirmed: Lock = {
  "mesh.ts:meshMessages.nodes": {
    en: "e1",
    de: "d1",
    fr: "f1",
    it: "i1",
    es: "s1",
    pt: "p1",
  },
};

function withChanges(
  changes: Partial<Lock["mesh.ts:meshMessages.nodes"]>,
): Lock {
  return {
    "mesh.ts:meshMessages.nodes": {
      ...confirmed["mesh.ts:meshMessages.nodes"],
      ...changes,
    },
  };
}

describe("lockProblems", () => {
  test("nothing to report when the catalogs match the lock", () => {
    expect(lockProblems(confirmed, confirmed)).toEqual([]);
  });

  test("English changed and translations did not: they are stale", () => {
    const problems = lockProblems(
      confirmed,
      withChanges({ en: "e2", de: "d2" }),
    );
    expect(problems).toEqual([
      "mesh.ts:meshMessages.nodes: the English changed, but not fr, it, es, pt. Update them, or confirm they still fit: bun run i18n:lock --confirm mesh.ts:meshMessages.nodes",
    ]);
  });

  test("English and every translation changed: only the lock is behind", () => {
    const problems = lockProblems(
      confirmed,
      withChanges({
        en: "e2",
        de: "d2",
        fr: "f2",
        it: "i2",
        es: "s2",
        pt: "p2",
      }),
    );
    expect(problems).toEqual([
      "mesh.ts:meshMessages.nodes: changed since the lock. Run: bun run i18n:lock",
    ]);
  });

  test("a new message and a removed one leave the lock behind", () => {
    const added: Lock = {
      ...confirmed,
      "mesh.ts:meshMessages.elements": confirmed["mesh.ts:meshMessages.nodes"],
    };
    expect(lockProblems(confirmed, added)).toEqual([
      "mesh.ts:meshMessages.elements: not in the lock. Run: bun run i18n:lock",
    ]);
    expect(lockProblems(added, confirmed)).toEqual([
      "mesh.ts:meshMessages.elements: in the lock, but no longer a message. Run: bun run i18n:lock",
    ]);
  });
});

describe("updateLock", () => {
  test("refuses English changes whose translations stayed the same", () => {
    const current = withChanges({ en: "e2" });
    expect(updateLock(confirmed, current, new Set())).toEqual({
      refused: ["mesh.ts:meshMessages.nodes"],
    });
  });

  test("accepts them when confirmed", () => {
    const current = withChanges({ en: "e2" });
    expect(
      updateLock(confirmed, current, new Set(["mesh.ts:meshMessages.nodes"])),
    ).toEqual({ lock: current });
  });

  test("accepts translated changes, new and removed messages", () => {
    const current: Lock = {
      "mesh.ts:meshMessages.elements": confirmed["mesh.ts:meshMessages.nodes"],
    };
    expect(updateLock(confirmed, current, new Set())).toEqual({
      lock: current,
    });
  });
});

describe("fingerprint", () => {
  test("a message function's fingerprint ignores line breaks and indentation", () => {
    const oneLine = (n: number) => `${n} nodes`;
    // prettier-ignore
    const wrapped = (n: number) =>
        `${n} nodes`;
    expect(fingerprint(oneLine)).toBe(fingerprint(wrapped));
  });

  test("a change to the text changes it", () => {
    expect(fingerprint("Nodes")).not.toBe(fingerprint("Node"));
    expect(fingerprint((n: number) => `${n} nodes`)).not.toBe(
      fingerprint((n: number) => `${n} elements`),
    );
  });
});

test("every message's translations are confirmed in the lock", async () => {
  const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as Lock;
  expect(lockProblems(lock, await catalogFingerprints())).toEqual([]);
});
