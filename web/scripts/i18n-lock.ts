// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Keeps translations from going stale (KOF-468). src/i18n/translations.lock.json
// holds a fingerprint of every message in every language, as last confirmed.
// tests/unit/i18n-lock.test.ts fails when the catalogs and the lock differ;
// this script brings the lock up to date, and refuses where the English of a
// message changed but a translation of it did not, unless that change is
// confirmed as one that needs no new translation (a typo in the English).
//
//   bun run i18n:lock
//   bun run i18n:lock --confirm mesh.ts:meshMessages.nodes

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LOCALES, type Locale } from "../src/i18n/locale";
import {
  writtenMessages,
  type AnyCatalog,
  type Message,
} from "../src/i18n/messages";

export type Lock = Record<string, Record<Locale, string>>;

const MESSAGES_DIR = new URL("../src/i18n/messages/", import.meta.url);
export const LOCK_FILE = fileURLToPath(
  new URL("../src/i18n/translations.lock.json", import.meta.url),
);

// A message function's source with its whitespace collapsed, so a formatter
// re-wrapping it is no change to the text.
export function fingerprint(message: Message): string {
  const source =
    typeof message === "string"
      ? `text:${message}`
      : `function:${message.toString().replace(/\s+/g, " ")}`;
  return createHash("sha256").update(source).digest("hex").slice(0, 12);
}

function isCatalog(value: unknown): value is AnyCatalog {
  return (
    typeof value === "object" &&
    value !== null &&
    LOCALES.every((locale) => locale in value)
  );
}

// Every message of every catalog in src/i18n/messages/, keyed
// "<file>:<catalog>.<message>".
export async function catalogFingerprints(): Promise<Lock> {
  const lock: Lock = {};
  const files = readdirSync(MESSAGES_DIR).filter((f) => f.endsWith(".ts"));
  for (const file of files.sort()) {
    const exports = (await import(new URL(file, MESSAGES_DIR).href)) as Record<
      string,
      unknown
    >;
    for (const [name, catalog] of Object.entries(exports)) {
      if (!isCatalog(catalog)) continue;
      const messages = writtenMessages(catalog);
      for (const key of Object.keys(messages).sort()) {
        const prints = {} as Record<Locale, string>;
        for (const locale of LOCALES)
          prints[locale] = fingerprint(messages[key][locale]);
        lock[`${file}:${name}.${key}`] = prints;
      }
    }
  }
  return lock;
}

// The translations of a message that stayed the same while its English
// changed.
function staleLocales(
  locked: Record<Locale, string>,
  current: Record<Locale, string>,
): Locale[] {
  if (locked.en === current.en) return [];
  return LOCALES.filter(
    (locale) => locale !== "en" && locked[locale] === current[locale],
  );
}

export function lockProblems(locked: Lock, current: Lock): string[] {
  const problems: string[] = [];
  for (const [key, prints] of Object.entries(current)) {
    const before = locked[key];
    if (!before) {
      problems.push(`${key}: not in the lock. Run: bun run i18n:lock`);
      continue;
    }
    const stale = staleLocales(before, prints);
    if (stale.length > 0)
      problems.push(
        `${key}: the English changed, but not ${stale.join(", ")}. Update them, or confirm they still fit: bun run i18n:lock --confirm ${key}`,
      );
    else if (LOCALES.some((locale) => before[locale] !== prints[locale]))
      problems.push(`${key}: changed since the lock. Run: bun run i18n:lock`);
  }
  for (const key of Object.keys(locked))
    if (!(key in current))
      problems.push(
        `${key}: in the lock, but no longer a message. Run: bun run i18n:lock`,
      );
  return problems;
}

export function updateLock(
  locked: Lock,
  current: Lock,
  confirmed: ReadonlySet<string>,
): { lock: Lock } | { refused: string[] } {
  const refused = Object.entries(current)
    .filter(([key, prints]) => {
      const before = locked[key];
      return (
        before !== undefined &&
        !confirmed.has(key) &&
        staleLocales(before, prints).length > 0
      );
    })
    .map(([key]) => key);
  return refused.length > 0 ? { refused } : { lock: current };
}

function confirmedKeys(args: readonly string[]): Set<string> {
  const keys = new Set<string>();
  args.forEach((arg, i) => {
    if (arg !== "--confirm") return;
    const key = args[i + 1];
    if (key === undefined || key.startsWith("--"))
      throw new Error(
        "--confirm needs a message, e.g. mesh.ts:meshMessages.nodes",
      );
    keys.add(key);
  });
  return keys;
}

if (import.meta.main) {
  // The first run, before any translation was confirmed, starts from none.
  const locked = existsSync(LOCK_FILE)
    ? (JSON.parse(readFileSync(LOCK_FILE, "utf8")) as Lock)
    : {};
  const current = await catalogFingerprints();
  const result = updateLock(
    locked,
    current,
    confirmedKeys(process.argv.slice(2)),
  );
  if ("refused" in result) {
    for (const problem of lockProblems(locked, current))
      if (result.refused.some((key) => problem.startsWith(`${key}:`)))
        console.error(problem);
    process.exit(1);
  }
  writeFileSync(LOCK_FILE, `${JSON.stringify(result.lock, null, 2)}\n`);
  console.log(`${Object.keys(result.lock).length} messages confirmed.`);
}
