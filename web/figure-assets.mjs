// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Diagrams and charts as image files, for the static documentation pages.
//
// A page generator renders its figures as inline SVG, styled by the page's
// CSS. `figureAssets` turns every content SVG of a page (an <svg> with
// role="img" and an aria-label) into image files and a <picture>:
//
//   <name>.svg       light theme, fonts embedded, for the browser
//   <name>-dark.svg  dark theme
//   <name>.png       light theme at 2× display size, the crawlable fallback
//
// Each SVG carries the figure CSS of docs-layout.mjs with the theme's colours
// resolved and subsets of the page fonts embedded, so it renders as the
// inline figure did. The PNG is rasterised from the light SVG by resvg with
// those same font subsets, so the same inputs always give the same bytes and
// a generator can check the committed files.
//
//   const assets = figureAssets({ dir, url });
//   html = assets.extract(html, { page: "axial-bar" });   // per page
//   for (const [file, content] of await assets.files()) …  // write or compare
//   assets.images("axial-bar")                              // PNG URLs, sitemap
//
// A figure's file name is <page>-<name>, where <name> is the SVG's
// data-name attribute, or "diagram"/"chart" from its class (numbered when a
// page has several).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIGURE_FONT_FACES,
  figureSvgStyle,
  themeVariables,
} from "./docs-layout.mjs";

const require = createRequire(import.meta.url);
const { Resvg } = require("@resvg/resvg-js");
const subsetFont = require("subset-font");

const web = new URL("./", import.meta.url);
const PNG_SCALE = 2;
const THEMES = ["light", "dark"];

const escapeAttr = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
const decodeEntities = (value) =>
  value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

// ── CSS with the theme's custom properties resolved ─────────────────────────

/** Replace every var(--name) with the theme's value (resvg has no var()). */
function resolveVariables(css, variables) {
  let out = css;
  for (let depth = 0; out.includes("var(--"); depth++) {
    if (depth > 8) throw new Error("Figure CSS variables nest too deeply");
    out = out.replace(/var\(--([a-z0-9-]+)\)/g, (match, name) => {
      const value = variables.get(name);
      if (value === undefined)
        throw new Error(`Figure CSS uses undefined variable --${name}`);
      return value;
    });
  }
  return out;
}

/**
 * Only the rules that can match this figure: selectors whose root class
 * (svg.fig, svg.conv) the figure has and whose other classes and elements
 * it uses.
 */
function relevantCss(css, figure) {
  const roots = new Set(figure.className.split(/\s+/).filter(Boolean));
  const used = new Set(
    [...figure.body.matchAll(/\sclass="([^"]*)"/g)].flatMap((match) =>
      match[1].split(/\s+/),
    ),
  );
  const elements = new Set(
    [...figure.body.matchAll(/<([a-zA-Z]+)[\s>/]/g)].map((match) => match[1]),
  );
  const matches = (selector) => {
    const [root, ...rest] = selector.split(/\s+/);
    const rootClass = root.match(/^svg\.([a-z0-9-]+)$/)?.[1];
    if (!rootClass)
      throw new Error(`Figure CSS selector without an svg root: ${selector}`);
    return (
      roots.has(rootClass) &&
      rest.every((part) => {
        const [element, ...classes] = part.split(".");
        return (
          (!element || elements.has(element)) &&
          classes.every((name) => used.has(name))
        );
      })
    );
  };
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selectors, declarations]) => {
      const kept = selectors
        .split(",")
        .map((selector) => selector.trim())
        .filter(matches);
      return kept.length ? `${kept.join(",")}{${declarations.trim()}}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

// ── Fonts ─────────────────────────────────────────────────────────────────────

// Unicode code points a TrueType/OpenType font maps (cmap formats 4 and 12).
function cmapCodePoints(font) {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tables = view.getUint16(4);
  let cmap = -1;
  for (let i = 0; i < tables; i++) {
    const record = 12 + 16 * i;
    if (String.fromCharCode(...font.subarray(record, record + 4)) === "cmap")
      cmap = view.getUint32(record + 8);
  }
  if (cmap < 0) throw new Error("Font subset has no cmap table");
  const points = new Set();
  const subtables = view.getUint16(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const offset = cmap + view.getUint32(cmap + 4 + 8 * i + 4);
    const format = view.getUint16(offset);
    if (format === 4) {
      const segments = view.getUint16(offset + 6) / 2;
      const ends = offset + 14;
      const starts = ends + 2 * segments + 2;
      for (let s = 0; s < segments; s++) {
        const end = view.getUint16(ends + 2 * s);
        const start = view.getUint16(starts + 2 * s);
        if (start === 0xffff) continue;
        for (let c = start; c <= end; c++) points.add(c);
      }
    } else if (format === 12) {
      const groups = view.getUint32(offset + 12);
      for (let g = 0; g < groups; g++) {
        const group = offset + 16 + 12 * g;
        const start = view.getUint32(group);
        const end = view.getUint32(group + 4);
        for (let c = start; c <= end; c++) points.add(c);
      }
    }
  }
  return points;
}

const inRanges = (ranges, code) =>
  !ranges || ranges.some(([lo, hi]) => code >= lo && code <= hi);

/**
 * Subsets of the page fonts for the characters of one figure: the faces of
 * every family its CSS names, deduplicated by file. Returns the CSS
 * @font-face rules (WOFF2 data URIs) and the TrueType subsets for resvg.
 */
async function embeddedFonts(characters, css) {
  const families = new Set(
    [...css.matchAll(/font-family:\s*([^;}]+)/g)].flatMap((match) =>
      match[1]
        .split(",")
        .map((name) => name.trim().replace(/^["']|["']$/g, "")),
    ),
  );
  const weights = new Set([
    400,
    ...[...css.matchAll(/font-weight:\s*(\d+)/g)].map((match) =>
      Number(match[1]),
    ),
  ]);
  const codes = [...characters].map((c) => c.codePointAt(0));
  // Faces of one family with the same bytes (a variable font listed under
  // several weights) are embedded once, for all of those weights.
  const byFile = new Map();
  for (const face of FIGURE_FONT_FACES) {
    if (!families.has(face.family) || !weights.has(face.weight)) continue;
    const wanted = codes.filter((code) => inRanges(face.ranges, code));
    if (!wanted.length) continue;
    const bytes = readFileSync(new URL(face.file, web));
    const key = `${face.family}|${bytes.toString("base64")}`;
    const entry = byFile.get(key) ?? {
      ...face,
      bytes,
      weights: new Set(),
      codes: wanted,
    };
    entry.weights.add(face.weight);
    byFile.set(key, entry);
  }
  const rules = [];
  const truetype = [];
  const covered = new Set();
  for (const face of [...byFile.values()].sort((a, b) =>
    `${a.family}${a.file}`.localeCompare(`${b.family}${b.file}`),
  )) {
    const source = face.bytes;
    const text = String.fromCodePoint(...face.codes);
    const ttf = await subsetFont(source, text, { targetFormat: "truetype" });
    for (const code of cmapCodePoints(ttf)) covered.add(code);
    const woff2 = await subsetFont(source, text, { targetFormat: "woff2" });
    const weights = [...face.weights].sort((a, b) => a - b);
    rules.push(
      `@font-face{font-family:"${face.family}";font-weight:${weights.length > 1 ? `${weights[0]} ${weights.at(-1)}` : weights[0]};src:url(data:font/woff2;base64,${woff2.toString("base64")}) format("woff2")}`,
    );
    truetype.push(ttf);
  }
  const missing = codes.filter((code) => !covered.has(code));
  if (missing.length)
    throw new Error(
      `No page font has the figure characters ${JSON.stringify(String.fromCodePoint(...missing))}; add a font face or change the label`,
    );
  return { rules: rules.join(""), truetype };
}

// ── One figure ────────────────────────────────────────────────────────────────

// resvg ignores orient="auto-start-reverse": give each such marker a mirrored
// start twin with orient="auto". Browsers draw both forms identically.
function normaliseMarkers(svg) {
  const reversed = [];
  let out = svg.replace(
    /<marker id="([^"]+)" viewBox="0 0 10 10" refX="([\d.]+)"([^>]*?)orient="auto-start-reverse"([^>]*)>([\s\S]*?)<\/marker>/g,
    (match, id, refX, before, after, body) => {
      reversed.push(id);
      return `<marker id="${id}" viewBox="0 0 10 10" refX="${refX}"${before}orient="auto"${after}>${body}</marker><marker id="${id}-start" viewBox="0 0 10 10" refX="${10 - Number(refX)}"${before}orient="auto"${after}><g transform="rotate(180 5 5)">${body}</g></marker>`;
    },
  );
  for (const id of reversed)
    out = out.replaceAll(
      `marker-start="url(#${id})"`,
      `marker-start="url(#${id}-start)"`,
    );
  if (out.includes("auto-start-reverse"))
    throw new Error(
      'A figure marker uses orient="auto-start-reverse" in a form the asset builder cannot mirror',
    );
  return out;
}

function parseFigure(svg) {
  const open = svg.match(/^<svg\b([^>]*)>/);
  if (!open) throw new Error("Figure markup does not start with <svg>");
  const attribute = (name) =>
    open[1].match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  const viewBox = attribute("viewBox")?.split(/\s+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || viewBox[0] || viewBox[1])
    throw new Error(`Figure needs a viewBox "0 0 w h": ${open[0]}`);
  const label = attribute("aria-label");
  if (!label?.trim()) throw new Error(`Figure has no aria-label: ${open[0]}`);
  return {
    className: attribute("class") ?? "",
    name: attribute("data-name"),
    width: viewBox[2],
    height: viewBox[3],
    alt: decodeEntities(label),
    body: svg.slice(open[0].length, svg.lastIndexOf("</svg>")),
  };
}

async function renderFigure(figure) {
  const characters = new Set(
    decodeEntities(
      figure.body
        .replace(/<title>[\s\S]*?<\/title>/g, "")
        .replace(/<[^>]+>/g, ""),
    ).replace(/\s/g, ""),
  );
  const themed = {};
  let fonts = null;
  for (const theme of THEMES) {
    const css = resolveVariables(
      relevantCss(figureSvgStyle(theme), figure),
      themeVariables(theme),
    );
    fonts ??= await embeddedFonts(characters, css);
    themed[theme] = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" class="${figure.className}" viewBox="0 0 ${figure.width} ${figure.height}" width="${figure.width}" height="${figure.height}">
<title>${escapeAttr(figure.alt)}</title>
<style>${fonts.rules}${css.replace(/\s+/g, " ").trim()}</style>
${normaliseMarkers(figure.body).trim()}
</svg>
`;
  }
  // resvg reads fonts from files: hand it the subsets through a scratch dir.
  const scratch = mkdtempSync(join(tmpdir(), "kofem-figure-"));
  try {
    const fontFiles = fonts.truetype.map((ttf, i) => {
      const file = join(scratch, `${i}.ttf`);
      writeFileSync(file, ttf);
      return file;
    });
    const png = new Resvg(themed.light, {
      fitTo: { mode: "zoom", value: PNG_SCALE },
      background: themeVariables("light").get("bg"),
      font: { loadSystemFonts: false, fontFiles },
      logLevel: "off",
    })
      .render()
      .asPng();
    return { light: themed.light, dark: themed.dark, png };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── A site's collection of figures ───────────────────────────────────────────

/**
 * `dir`: the folder (URL or path) the files are written to; `url`: the
 * public URL of that folder, e.g. "/examples/". Files go to <page>/ below it.
 */
export function figureAssets({ dir, url }) {
  const root = typeof dir === "string" ? dir : dir.pathname;
  const figures = new Map();
  const slug = (value) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  return {
    /** Replace the page's content SVGs with <picture>s; record their files. */
    extract(html, { page }) {
      const counts = new Map();
      return html.replace(
        /<svg\b(?=[^>]*\srole="img")(?=[^>]*\saria-label=)[^>]*>[\s\S]*?<\/svg>/g,
        (svg) => {
          const figure = parseFigure(svg);
          const role =
            figure.name ??
            (/\bconv\b/.test(figure.className) ? "chart" : "diagram");
          const count = (counts.get(role) ?? 0) + 1;
          counts.set(role, count);
          const base = `${slug(page)}/${slug(page)}-${slug(role)}${count > 1 ? `-${count}` : ""}`;
          const known = figures.get(base);
          if (known && known.svg !== svg)
            throw new Error(
              `Two different figures would be written to ${base}`,
            );
          figures.set(base, { svg, page, figure });
          const classes = slug(figure.className) ? ` ${figure.className}` : "";
          // Both themes fall back to the one light PNG, so crawlers see a
          // single image URL per figure. The hidden theme's <picture> is
          // display: none, so its lazy image is never fetched.
          const img = `<img src="${url}${base}.png" width="${figure.width}" height="${figure.height}" alt="${escapeAttr(figure.alt)}" loading="lazy" decoding="async" />`;
          return `<picture class="figure-image theme-light${classes}"><source srcset="${url}${base}.svg" type="image/svg+xml" />${img}</picture><picture class="figure-image theme-dark${classes}"><source srcset="${url}${base}-dark.svg" type="image/svg+xml" />${img}</picture>`;
        },
      );
    },

    /** Every file to publish, as [absolute path, content]. */
    async files() {
      const out = [];
      for (const [base, { figure }] of [...figures].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const { light, dark, png } = await renderFigure(figure);
        out.push(
          [join(root, `${base}.svg`), light],
          [join(root, `${base}-dark.svg`), dark],
          [join(root, `${base}.png`), png],
        );
      }
      return out;
    },

    /** The crawlable PNG URLs of one page's figures, for an image sitemap. */
    images(page) {
      return [...figures]
        .filter(([, entry]) => entry.page === page)
        .map(([base]) => `${url}${base}.png`);
    },
  };
}

/** True when `content` equals the file on disk (text or binary). */
export function sameFile(file, content) {
  try {
    const current = readFileSync(file);
    return Buffer.isBuffer(content)
      ? current.equals(content)
      : current.toString("utf8") === content;
  } catch {
    return false;
  }
}

/** The image-sitemap namespace on a sitemap's <urlset>. */
export const withImageNamespace = (xml) =>
  xml.includes("xmlns:image=")
    ? xml
    : xml.replace(
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
      );

/** <image:image> entries for absolute image URLs. */
export const imageEntries = (urls) =>
  urls
    .map((loc) => `<image:image><image:loc>${loc}</image:loc></image:image>`)
    .join("");
