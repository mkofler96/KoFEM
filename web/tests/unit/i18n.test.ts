// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The app's languages (KOF-468): which one opens, and that every message
// catalog says everything in every language. The browser path (the Settings
// menu, the choice surviving a reload) is tests/language.spec.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { LOCALES, pickLocale, type Locale } from "../../src/i18n/locale";
import type { Catalog, Message } from "../../src/i18n/messages";

describe("pickLocale", () => {
  test("a language chosen in the app wins over the browser's", () => {
    expect(pickLocale("fr", ["de-DE", "en"])).toBe("fr");
  });

  test("without a choice, the first browser language KoFEM speaks", () => {
    expect(pickLocale(null, ["ja-JP", "pt-BR", "de"])).toBe("pt");
  });

  test("region and case do not matter", () => {
    expect(pickLocale(null, ["IT-ch"])).toBe("it");
  });

  test("a stored value that is not a language KoFEM speaks is ignored", () => {
    expect(pickLocale("xx", ["es-MX"])).toBe("es");
  });

  test("English when no browser language is one KoFEM speaks", () => {
    expect(pickLocale(null, ["ja-JP", "zh"])).toBe("en");
    expect(pickLocale(null, [])).toBe("en");
  });
});

const MESSAGES_DIR = new URL("../../src/i18n/messages/", import.meta.url);

function isCatalog(value: unknown): value is Catalog<Record<string, Message>> {
  return (
    typeof value === "object" &&
    value !== null &&
    LOCALES.every((locale) => locale in value)
  );
}

// A message function interpolates counts and names into text; numbers stand
// in for both. One that comes back empty is broken.
function render(message: Message): string {
  if (typeof message === "string") return message;
  return (message as (...args: unknown[]) => string)(2, 3, 4, 5);
}

const files = readdirSync(MESSAGES_DIR).filter((f) => f.endsWith(".ts"));

describe("message catalogs", () => {
  test("there are catalogs to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file}: every language has every message, none empty`, async () => {
      const module = (await import(new URL(file, MESSAGES_DIR).href)) as Record<
        string,
        unknown
      >;
      const catalogs = Object.entries(module).filter(([, v]) => isCatalog(v));
      expect(catalogs.length).toBeGreaterThan(0);
      for (const [name, catalog] of catalogs) {
        if (!isCatalog(catalog)) continue;
        const keys = Object.keys(catalog.en).sort();
        for (const locale of LOCALES as readonly Locale[]) {
          const messages = catalog[locale];
          expect({ name, locale, keys: Object.keys(messages).sort() }).toEqual({
            name,
            locale,
            keys,
          });
          for (const key of keys) {
            const message = messages[key];
            const english = catalog.en[key];
            expect({ name, locale, key, kind: typeof message }).toEqual({
              name,
              locale,
              key,
              kind: typeof english,
            });
            if (typeof message === "function" && typeof english === "function")
              expect({ name, locale, key, arity: message.length }).toEqual({
                name,
                locale,
                key,
                arity: english.length,
              });
            expect(render(message).trim().length).toBeGreaterThan(0);
          }
        }
      }
    });
  }
});
