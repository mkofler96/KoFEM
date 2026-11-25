// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";
import ts from "typescript";
import type { Plugin } from "vite";

// The app downloads only the visitor's language (KOF-471). A catalog in
// src/i18n/messages/ holds every message in all languages side by side, as
// they are written and checked (src/i18n/README.md). This plugin splits it
// where Vite reads it:
//
// - `messages/<part>.ts` keeps each message's English only. English is the
//   app's default language and the text analytics sorts errors by.
// - `messages/<part>.ts?locale=<xx>` holds that language's text and adds it to
//   the catalogs <part>.ts exports (addTranslations). src/i18n/locales/<xx>.ts
//   gathers them into one chunk, which src/i18n/loadLocale.ts fetches when
//   the app needs the language.
//
// Anything but `export const name = defineMessages({ key: { en, de, … } })`
// fails the build, so a catalog never ships with a language silently missing.

const CATALOG = /\/src\/i18n\/messages\/[^/]+\.ts$/;
const LOCALE_QUERY = /^locale=([a-z]{2})$/;

interface MessageText {
  key: string;
  byLocale: Map<string, string>;
  object: ts.ObjectLiteralExpression;
}

interface CatalogCall {
  name: string;
  statement: ts.VariableStatement;
  messages: MessageText[];
}

function propertyName(name: ts.PropertyName, file: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  throw new Error(`${file}: a message key must be a plain name`);
}

// The `name = defineMessages({ … })` of a catalog statement, or an error.
function catalogDeclaration(
  statement: ts.Statement,
  source: ts.SourceFile,
  file: string,
): {
  statement: ts.VariableStatement;
  name: string;
  messages: ts.ObjectLiteralExpression;
} {
  const fail = (): never => {
    throw new Error(
      `${file}: write a catalog as \`export const name = defineMessages({ … })\``,
    );
  };
  if (!ts.isVariableStatement(statement)) return fail();
  const exported = statement.modifiers?.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );
  const declarations = statement.declarationList.declarations;
  if (!exported || declarations.length !== 1) return fail();
  const [declaration] = declarations;
  const call = declaration.initializer;
  if (
    !ts.isIdentifier(declaration.name) ||
    call === undefined ||
    !ts.isCallExpression(call) ||
    call.expression.getText(source) !== "defineMessages" ||
    call.arguments.length !== 1
  )
    return fail();
  const [messages] = call.arguments;
  if (!ts.isObjectLiteralExpression(messages)) return fail();
  return { statement, name: declaration.name.text, messages };
}

function catalogCalls(source: ts.SourceFile, file: string): CatalogCall[] {
  return source.statements
    .filter((statement) =>
      statement.getText(source).includes("defineMessages("),
    )
    .map((candidate) => {
      const { statement, name, messages } = catalogDeclaration(
        candidate,
        source,
        file,
      );
      return {
        name,
        statement,
        messages: messages.properties.map((property) => {
          if (
            !ts.isPropertyAssignment(property) ||
            !ts.isObjectLiteralExpression(property.initializer)
          )
            throw new Error(
              `${file}: ${name} must list each message as \`key: { en, de, … }\``,
            );
          const key = propertyName(property.name, file);
          const byLocale = new Map<string, string>();
          for (const translation of property.initializer.properties) {
            if (!ts.isPropertyAssignment(translation))
              throw new Error(
                `${file}: ${key} must give each language as \`xx: …\``,
              );
            byLocale.set(
              propertyName(translation.name, file),
              translation.initializer.getText(source),
            );
          }
          return { key, byLocale, object: property.initializer };
        }),
      };
    });
}

function textIn(message: MessageText, locale: string, file: string): string {
  const text = message.byLocale.get(locale);
  if (text === undefined)
    throw new Error(`${file}: ${message.key} has no "${locale}" text`);
  return text;
}

// Replaces source ranges from last to first, so earlier offsets stay valid.
function replaceRanges(
  code: string,
  edits: { start: number; end: number; text: string }[],
): string {
  let out = code;
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

export function englishOnly(code: string, file: string): string {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const edits = catalogCalls(source, file).flatMap((catalog) =>
    catalog.messages.map((message) => ({
      start: message.object.getStart(source),
      end: message.object.getEnd(),
      text: `{ en: ${textIn(message, "en", file)} }`,
    })),
  );
  return replaceRanges(code, edits);
}

// The catalog's module with each `export const x = defineMessages(…)` turned
// into the language's texts added to the x the plain module exports. What
// else the module declares stays, for messages that call it.
export function oneLocale(code: string, file: string, locale: string): string {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const catalogs = catalogCalls(source, file);
  const base = JSON.stringify(file);
  const imports = [
    'import { addTranslations as __addTranslations } from "../messages";',
    `import { ${catalogs.map((c) => `${c.name} as __${c.name}`).join(", ")} } from ${base};`,
  ];
  const edits = catalogs.map((catalog) => ({
    start: catalog.statement.getStart(source),
    end: catalog.statement.getEnd(),
    text: `__addTranslations(__${catalog.name}, ${JSON.stringify(locale)}, {\n${catalog.messages
      .map((m) => `  ${JSON.stringify(m.key)}: ${textIn(m, locale, file)},`)
      .join("\n")}\n});`,
  }));
  return `${imports.join("\n")}\n${replaceRanges(code, edits)}`;
}

export function localeChunks(): Plugin {
  return {
    name: "kofem-locale-chunks",
    enforce: "pre",
    async load(id) {
      const [file, query] = id.split("?");
      const locale = query === undefined ? null : LOCALE_QUERY.exec(query)?.[1];
      if (!locale || !CATALOG.test(file)) return null;
      this.addWatchFile(file);
      return oneLocale(await readFile(file, "utf8"), file, locale);
    },
    transform(code, id) {
      if (!CATALOG.test(id)) return null;
      return { code: englishOnly(code, id), map: null };
    },
  };
}
