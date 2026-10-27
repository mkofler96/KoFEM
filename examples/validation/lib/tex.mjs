// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A small TeX subset → MathML, for the equations on the validation pages.
// MathML renders natively in every current browser, so the pages stay static,
// script-free and crawlable.
//
// Supported: single-letter identifiers (Latin or Greek, one per letter, so
// "PL" is P times L), numbers, operators, {groups}, ^ and _ (single token or
// group), \frac{a}{b}, \sqrt{a}, \text{...} (upright words), \mathrm{...}
// (upright identifiers such as "max"), \left( \right) stretchy delimiters, and
// \, \; spacing. Anything else throws, so a typo cannot render as a silent gap.

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const COMMANDS = new Set(["frac", "sqrt", "text", "mathrm", "left", "right"]);
const SYMBOLS = {
  cdot: "·",
  times: "×",
  approx: "≈",
  le: "≤",
  ge: "≥",
  pm: "±",
  int: "∫",
  sum: "∑",
  partial: "∂",
  nabla: "∇",
  infty: "∞",
  to: "→",
  quad: null,
};

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\n" || c === "\t") {
      i++;
    } else if (c === "\\") {
      const m = /^\\([A-Za-z]+|[,;!{}|])/.exec(src.slice(i));
      if (!m) throw new Error(`tex: bad command at "${src.slice(i)}"`);
      out.push({ kind: "cmd", value: m[1] });
      i += m[0].length;
    } else if (
      /[0-9]/.test(c) ||
      (c === "." && /[0-9]/.test(src[i + 1] ?? ""))
    ) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
      if (!m) throw new Error(`tex: bad number at "${src.slice(i)}"`);
      out.push({ kind: "num", value: m[0] });
      i += m[0].length;
    } else if (/[A-Za-zΑ-Ωα-ωϑϕ]/.test(c)) {
      out.push({ kind: "id", value: c });
      i++;
    } else if ("{}^_".includes(c)) {
      out.push({ kind: c });
      i++;
    } else {
      out.push({ kind: "op", value: c === "-" ? "−" : c });
      i++;
    }
  }
  return out;
}

function parser(tokens, src) {
  let p = 0;
  const peek = () => tokens[p];
  const fail = (msg) => {
    throw new Error(`tex: ${msg} in "${src}"`);
  };
  const expect = (kind) => {
    const t = tokens[p++];
    if (!t || t.kind !== kind) fail(`expected "${kind}"`);
    return t;
  };

  // Raw text up to the matching brace (for \text and \mathrm).
  function rawGroup() {
    expect("{");
    let depth = 1,
      s = "";
    while (p < tokens.length) {
      const t = tokens[p++];
      if (t.kind === "{") depth++;
      if (t.kind === "}" && --depth === 0) return s;
      s += t.kind === "cmd" ? `\\${t.value}` : (t.value ?? t.kind);
    }
    return fail("unclosed group");
  }

  function atom() {
    const t = tokens[p++];
    if (!t) return fail("unexpected end");
    switch (t.kind) {
      case "id":
        return `<mi>${esc(t.value)}</mi>`;
      case "num":
        return `<mn>${t.value}</mn>`;
      case "op":
        return `<mo>${esc(t.value)}</mo>`;
      case "{": {
        const inner = sequence("}");
        expect("}");
        return `<mrow>${inner}</mrow>`;
      }
      case "cmd": {
        const v = t.value;
        if (v === ",") return `<mspace width="0.17em"/>`;
        if (v === ";") return `<mspace width="0.28em"/>`;
        if (v === "!") return "";
        if (v === "|" || v === "{" || v === "}") return `<mo>${esc(v)}</mo>`;
        if (v === "quad") return `<mspace width="1em"/>`;
        if (v in SYMBOLS) {
          const s = SYMBOLS[v];
          return v === "int" || v === "sum"
            ? `<mo largeop="true">${s}</mo>`
            : `<mo>${s}</mo>`;
        }
        if (!COMMANDS.has(v)) return fail(`unknown command \\${v}`);
        if (v === "frac") {
          const a = atom(),
            b = atom();
          return `<mfrac>${a}${b}</mfrac>`;
        }
        if (v === "sqrt") return `<msqrt>${atom()}</msqrt>`;
        if (v === "text") return `<mtext>${esc(rawGroup())}</mtext>`;
        if (v === "mathrm")
          return `<mi mathvariant="normal">${esc(rawGroup())}</mi>`;
        if (v === "left") {
          const open = tokens[p++];
          const inner = sequence("right");
          expect("cmd");
          const close = tokens[p++];
          return `<mrow><mo stretchy="true">${esc(open.value)}</mo>${inner}<mo stretchy="true">${esc(close.value)}</mo></mrow>`;
        }
        return fail(`stray \\${v}`);
      }
      default:
        return fail(`unexpected "${t.kind}"`);
    }
  }

  function withScripts() {
    let base = atom();
    let sub = null,
      sup = null;
    while (peek() && (peek().kind === "^" || peek().kind === "_")) {
      const k = tokens[p++].kind;
      const arg = atom();
      if (k === "^") sup = arg;
      else sub = arg;
    }
    if (sub && sup) return `<msubsup>${base}${sub}${sup}</msubsup>`;
    if (sub) return `<msub>${base}${sub}</msub>`;
    if (sup) return `<msup>${base}${sup}</msup>`;
    return base;
  }

  function sequence(stop) {
    let s = "";
    while (p < tokens.length) {
      const t = peek();
      if (stop === "}" && t.kind === "}") break;
      if (stop === "right" && t.kind === "cmd" && t.value === "right") break;
      s += withScripts();
    }
    return s;
  }

  return { sequence, done: () => p >= tokens.length };
}

// \text{...} keeps its spaces: they become no-break spaces, which tokenize()
// passes through as ordinary characters.
function protectText(src) {
  return src.replace(/\\(text|mathrm)\{([^{}]*)\}/g, (_, cmd, body) => {
    const words = body.replace(/ /g, " ");
    return `\\${cmd}{${words}}`;
  });
}

function toMathML(src) {
  const tokens = tokenize(protectText(src));
  const { sequence, done } = parser(tokens, src);
  const body = sequence(null);
  if (!done()) throw new Error(`tex: trailing input in "${src}"`);
  return body;
}

/** Inline math. */
export const tex = (src) => `<math>${toMathML(src)}</math>`;

/** Display math, one equation per call. */
export const texBlock = (src) =>
  `<math display="block">${toMathML(src)}</math>`;
