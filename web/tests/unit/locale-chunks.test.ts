// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { englishOnly, oneLocale } from "../../vite-locales";
import { LOCALES } from "../../src/i18n/locale";
import {
  addTranslations,
  catalogsHave,
  defineMessages,
  inLocale,
  type AnyCatalog,
} from "../../src/i18n/messages";

// The app's build splits each catalog by language (KOF-471): the plain
// module keeps the English, one module per language adds the rest.

const DIR = join(import.meta.dir, "../../src/i18n/messages");
const CATALOGS = readdirSync(DIR).filter((name) => name.endsWith(".ts"));

// Every `key: { … }` inside a defineMessages call, with its language names.
function messageLanguages(code: string): Map<string, string[]> {
  const source = ts.createSourceFile(
    "x.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
  );
  const found = new Map<string, string[]>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "defineMessages"
    ) {
      const messages = node.arguments[0];
      if (!ts.isObjectLiteralExpression(messages)) throw new Error("no object");
      for (const property of messages.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          !ts.isObjectLiteralExpression(property.initializer)
        )
          throw new Error("not a message");
        found.set(
          ts.isStringLiteral(property.name)
            ? property.name.text
            : property.name.getText(source),
          property.initializer.properties.map((p) => {
            if (!p.name) throw new Error("a language without a name");
            return p.name.getText(source);
          }),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("each catalog splits by language", () => {
  for (const name of CATALOGS) {
    const file = join(DIR, name);
    const code = readFileSync(file, "utf8");
    const written = messageLanguages(code);

    test(`${name}: the plain module keeps English only`, () => {
      const split = messageLanguages(englishOnly(code, file));
      expect([...split.keys()]).toEqual([...written.keys()]);
      for (const languages of split.values()) expect(languages).toEqual(["en"]);
    });

    test(`${name}: each language's module adds every message`, () => {
      for (const locale of LOCALES.filter((l) => l !== "en")) {
        const module = oneLocale(code, file, locale);
        expect(module).not.toContain("defineMessages({");
        for (const key of written.keys())
          expect(module).toContain(`${JSON.stringify(key)}: `);
      }
    });
  }
});

describe("a catalog the split cannot read fails the build", () => {
  test("a catalog that is not exported", () => {
    const code = 'const m = defineMessages({ a: { en: "A", de: "A" } });';
    expect(() => englishOnly(code, "m.ts")).toThrow("export const name");
  });

  test("a message without the language", () => {
    const code = 'export const m = defineMessages({ a: { en: "A" } });';
    expect(() => oneLocale(code, "m.ts", "de")).toThrow('a has no "de" text');
  });
});

describe("a catalog without a language's text", () => {
  // What the app's build defines: English only, until the language arrives.
  const catalog = defineMessages({
    greeting: { en: "Hello" },
  } as unknown as Parameters<typeof defineMessages>[0]) as AnyCatalog;

  test("names the language instead of showing English", () => {
    expect(() => inLocale(catalog, "fr")).toThrow(
      "The Français text is not loaded",
    );
    expect(catalogsHave("fr")).toBe(false);
  });

  test("speaks it once its text is added", () => {
    addTranslations(catalog, "it", { greeting: "Ciao" });
    expect(inLocale(catalog, "it").greeting).toBe("Ciao");
  });

  test("refuses a language's text with a message missing", () => {
    expect(() => addTranslations(catalog, "es", {})).toThrow(
      "es.greeting is missing",
    );
  });
});
