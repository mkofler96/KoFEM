// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The app's languages (KOF-468): which one opens, and that every message
// catalog says everything in every language. The browser path (the Settings
// menu, the choice surviving a reload) is tests/language.spec.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { LOCALES, pickLocale, type Locale } from "../../src/i18n/locale";
import {
  writtenMessages,
  type AnyCatalog,
  type Message,
} from "../../src/i18n/messages";

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

function isCatalog(value: unknown): value is AnyCatalog {
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
    test(`${file}: every message in every language, none empty`, async () => {
      const module = (await import(new URL(file, MESSAGES_DIR).href)) as Record<
        string,
        unknown
      >;
      const catalogs = Object.entries(module).filter(([, v]) => isCatalog(v));
      expect(catalogs.length).toBeGreaterThan(0);
      for (const [name, catalog] of catalogs) {
        if (!isCatalog(catalog)) continue;
        for (const [key, translations] of Object.entries(
          writtenMessages(catalog),
        )) {
          const english = translations.en;
          for (const locale of LOCALES as readonly Locale[]) {
            const message = translations[locale];
            const where = { name, key, locale };
            expect({ ...where, kind: typeof message }).toEqual({
              ...where,
              kind: typeof english,
            });
            if (typeof message === "function" && typeof english === "function")
              expect({ ...where, arity: message.length }).toEqual({
                ...where,
                arity: english.length,
              });
            expect(render(message).trim().length).toBeGreaterThan(0);
            expect(render(catalog[locale][key])).toBe(render(message));
          }
        }
      }
    });
  }
});
