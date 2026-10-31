// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A small TeX subset → MathML, for the equations on the validation pages.
// MathML renders natively in every current browser, so the pages stay static,
// script-free and crawlable.
//
// Supported: single-letter identifiers (Latin or Greek, one per letter, so
// "PL" is P times L), numbers, operators, {groups}, ^ and _ (single token or
// group), \frac{a}{b}, \sqrt{a}, \sin \cos \tan \exp \log \ln,
// \text{...} (upright words), \mathrm{...}
// (upright identifiers such as "max"), \left( \right) stretchy delimiters, and
// \, \; spacing. Anything else throws, so a typo cannot render as a silent gap.

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const COMMANDS = new Set(["frac", "sqrt", "text", "mathrm", "left", "right"]);
const FUNCTIONS = new Set(["sin", "cos", "tan", "exp", "log", "ln"]);
const THIN = `<mspace width="0.1667em"/>`;
const TIGHT = `lspace="0" rspace="0"`;

/**
 * An operator with TeX's spacing where MathML Core's defaults differ: plain
 * brackets are not stretchy and take no space, "/", ".", "°" and the prime
 * are ordinary, and a sign that starts an expression or follows an operator is
 * unary (−P, not − P). `prev` is the token before it.
 */
function operator(v, prev) {
  if ("()[]|".includes(v))
    return `<mo stretchy="false" ${TIGHT}>${esc(v)}</mo>`;
  if (v === "/" || v === "°" || v === ".") return `<mo ${TIGHT}>${v}</mo>`;
  if (v === "'") return `<mo ${TIGHT}>′</mo>`;
  if ("−+±".includes(v)) {
    const unary =
      !prev ||
      prev.kind === "{" ||
      prev.kind === "^" ||
      prev.kind === "_" ||
      (prev.kind === "op" && !")]|'".includes(prev.value)) ||
      (prev.kind === "cmd" && ["left", "quad", ",", ";"].includes(prev.value));
    if (unary) return `<mo form="prefix" ${TIGHT}>${v}</mo>`;
  }
  return `<mo>${esc(v)}</mo>`;
}
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
        return operator(t.value, tokens[p - 2]);
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
        if (FUNCTIONS.has(v)) {
          // Upright, with TeX's thin space after it, and before it when it
          // follows an ordinary symbol (2 cos 2θ).
          const prev = tokens[p - 2];
          const ordinary =
            prev &&
            (prev.kind === "id" ||
              prev.kind === "num" ||
              prev.kind === "}" ||
              (prev.kind === "op" && ")]".includes(prev.value)));
          return `${ordinary ? THIN : ""}<mi>${v}</mi>${THIN}`;
        }
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
          return `<mrow><mo stretchy="true" ${TIGHT}>${esc(open.value)}</mo>${inner}<mo stretchy="true" ${TIGHT}>${esc(close.value)}</mo></mrow>`;
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
