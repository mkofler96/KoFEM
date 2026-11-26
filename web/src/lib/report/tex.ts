// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The analysis report's symbol markup (KOF-391): text with $…$ spans whose
// content becomes MathML, set in Computer Modern (KoFEM Math) like LaTeX.
// Inside $…$: _ and ^ for sub- and superscripts, {…} to group, \u{mm} for
// upright text (units, labels), ~ for a thin space, - for a minus; a single
// letter is an italic variable, a run of digits a number with thin-space
// groups. Chromium renders MathML itself, so no library is needed.

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ENTITIES[c]);

const THIN_SPACE = " ";

function math(src: string): string {
  let i = 0;
  const atom = (): string => {
    const char = src[i];
    if (char === "{") {
      i++;
      let out = "";
      while (i < src.length && src[i] !== "}") out += item();
      i++;
      return `<mrow>${out}</mrow>`;
    }
    if (src.startsWith("\\u{", i)) {
      const end = src.indexOf("}", i);
      if (end < 0) throw new Error(`report: unclosed \\u{ in "${src}"`);
      const text = escapeHtml(src.slice(i + 3, end));
      i = end + 1;
      return `<mi mathvariant="normal">${text}</mi>`;
    }
    if (/[0-9.]/.test(char)) {
      let j = i;
      while (
        j < src.length &&
        (/[0-9.]/.test(src[j]) ||
          (src[j] === " " && /[0-9]/.test(src[j + 1] ?? "")))
      )
        j++;
      const digits = src.slice(i, j).replace(/ /g, THIN_SPACE);
      i = j;
      return `<mn>${digits}</mn>`;
    }
    i++;
    if (char === " ") return "";
    if (char === "~") return `<mspace width="0.17em"/>`;
    if (char === "-" || char === "−") return "<mo>−</mo>";
    if (char === "Σ") return `<mi mathvariant="normal">Σ</mi>`;
    if (char === "/") return `<mo lspace="0" rspace="0">/</mo>`;
    if (/[A-Za-zα-ωΑ-Ω]/.test(char)) return `<mi>${char}</mi>`;
    return `<mo>${escapeHtml(char)}</mo>`;
  };
  const item = (): string => {
    let base = atom();
    while (src[i] === "_" || src[i] === "^") {
      const tag = src[i] === "_" ? "msub" : "msup";
      i++;
      base = `<${tag}><mrow>${base}</mrow><mrow>${atom()}</mrow></${tag}>`;
    }
    return base;
  };
  let out = "";
  while (i < src.length) out += item();
  return `<math>${out}</math>`;
}

/** HTML for text with $…$ symbol spans: the text escaped, the spans as MathML. */
export function tex(src: string): string {
  return src
    .split(/(\$[^$]*\$)/)
    .map((part) =>
      part.length > 1 && part.startsWith("$") && part.endsWith("$")
        ? math(part.slice(1, -1))
        : escapeHtml(part),
    )
    .join("");
}
