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
//
// Generators with their own figure registry (the Theory Guide,
// web/theory/figures/index.mjs) call renderFigureFiles directly with the
// figure markup and its CSS.

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
 * Only the rules that can match this figure: every compound of a selector
 * names elements and classes the figure uses; an svg.<class> root must be
 * one of the figure's own classes.
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
  const matches = (selector) =>
    selector.split(/\s+/).every((part, index) => {
      if (!/^[a-zA-Z]*(\.[a-z0-9-]+)*$/.test(part))
        throw new Error(`Unsupported figure CSS selector: ${selector}`);
      const [element, ...classes] = part.split(".");
      if (index === 0 && element === "svg" && classes.length)
        return classes.every((name) => roots.has(name));
      return (
        (!element || elements.has(element)) &&
        classes.every((name) => used.has(name))
      );
    });
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

const tableTags = (font) => {
  const count = new DataView(font.buffer, font.byteOffset).getUint16(4);
  return Array.from({ length: count }, (_, i) =>
    String.fromCharCode(...font.subarray(12 + 16 * i, 16 + 16 * i)),
  );
};

const inRanges = (ranges, code) =>
  !ranges || ranges.some(([lo, hi]) => code >= lo && code <= hi);

const pageFamilies = new Set(FIGURE_FONT_FACES.map((face) => face.family));

/**
 * The characters each page font draws in a figure: the font family of every
 * <text> and <tspan> follows from the figure CSS (the last matching rule, as
 * the figures use no competing selectors), its own attributes, and
 * inheritance. Each family is the first page font of its font-family list.
 */
function charactersByFamily(body, css) {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(
    ([, selectors, declarations]) => {
      const family = declarations.match(/font-family:\s*([^;]+)/)?.[1];
      return family
        ? selectors.split(",").map((selector) => {
            const [element, ...classes] = selector
              .trim()
              .split(/\s+/)
              .at(-1)
              .split(".");
            return { element, classes, family };
          })
        : [];
    },
  );
  const familyOf = (tag, attributes, inherited) => {
    const classes = new Set(
      attributes.match(/\sclass="([^"]*)"/)?.[1].split(/\s+/),
    );
    let stack =
      attributes.match(/\sfont-family="([^"]*)"/)?.[1] ??
      attributes.match(/font-family:\s*([^;"]+)/)?.[1];
    if (!stack)
      for (const rule of rules)
        if (
          (!rule.element || rule.element === tag) &&
          rule.classes.every((name) => classes.has(name))
        )
          stack = rule.family;
    if (!stack) return inherited;
    const family = stack
      .split(",")
      .map((name) => name.trim().replace(/^["']|["']$/g, ""))
      .find((name) => pageFamilies.has(name));
    if (!family)
      throw new Error(`Figure text uses no page font (font-family: ${stack})`);
    return family;
  };
  const out = new Map();
  const add = (family, value) => {
    const characters = decodeEntities(value).replace(/\s/g, "");
    if (!characters) return;
    if (!family) throw new Error(`Figure text has no font family: ${value}`);
    const set = out.get(family) ?? new Set([" "]);
    for (const c of characters) set.add(c);
    out.set(family, set);
  };
  for (const [, attributes, content] of body.matchAll(
    /<text\b([^>]*)>([\s\S]*?)<\/text>/g,
  )) {
    const family = familyOf("text", attributes, null);
    for (const [, spanAttributes, spanText, plain] of content.matchAll(
      /<tspan\b([^>]*)>([^<]*)<\/tspan>|([^<]+)/g,
    ))
      if (plain !== undefined) add(family, plain);
      else add(familyOf("tspan", spanAttributes, family), spanText);
  }
  return out;
}

/**
 * Subsets of the page fonts for one figure: each family's faces subset to
 * the characters that family draws (charactersByFamily), deduplicated by
 * file. Returns the CSS @font-face rules (WOFF2 data URIs) and the TrueType
 * subsets for resvg. Subsetting by family also matters to resvg: given a
 * font that holds a whole line, it would draw the line in it.
 */
async function embeddedFonts(byFamily, css, body) {
  const weights = new Set([
    400,
    ...[...`${css}${body}`.matchAll(/font-weight[:=]\s*"?(\d+)/g)].map(
      (match) => Number(match[1]),
    ),
  ]);
  // Faces of one family with the same bytes (a variable font listed under
  // several weights) are embedded once, for all of those weights.
  // A face serves the used weights nearest to its own, as a browser picks.
  const nearest = (family, weight) =>
    FIGURE_FONT_FACES.filter((face) => face.family === family).reduce(
      (best, face) =>
        Math.abs(face.weight - weight) < Math.abs(best - weight)
          ? face.weight
          : best,
      Infinity,
    );
  const byFile = new Map();
  for (const face of FIGURE_FONT_FACES) {
    const characters = byFamily.get(face.family);
    if (
      !characters ||
      ![...weights].some(
        (weight) => nearest(face.family, weight) === face.weight,
      )
    )
      continue;
    const wanted = [...characters]
      .map((c) => c.codePointAt(0))
      .filter((code) => inRanges(face.ranges, code));
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
  const covered = new Map();
  for (const face of [...byFile.values()].sort((a, b) =>
    `${a.family}${a.file}`.localeCompare(`${b.family}${b.file}`),
  )) {
    const source = face.bytes;
    const text = String.fromCodePoint(...face.codes);
    const ttf = await subsetFont(source, text, { targetFormat: "truetype" });
    const familyCovered = covered.get(face.family) ?? new Set();
    for (const code of cmapCodePoints(ttf)) familyCovered.add(code);
    covered.set(face.family, familyCovered);
    const woff2 = await subsetFont(source, text, { targetFormat: "woff2" });
    const faceWeights = [...face.weights].sort((a, b) => a - b);
    rules.push(
      `@font-face{font-family:"${face.family}";font-weight:${faceWeights.length > 1 ? `${faceWeights[0]} ${faceWeights.at(-1)}` : faceWeights[0]};src:url(data:font/woff2;base64,${woff2.toString("base64")}) format("woff2")}`,
    );
    // resvg does not apply variation axes: give it one static instance per
    // weight this variable font serves, as the browser would draw them.
    if (tableTags(ttf).includes("fvar"))
      for (const weight of faceWeights)
        truetype.push(
          await subsetFont(source, text, {
            targetFormat: "truetype",
            variationAxes: { wght: weight },
          }),
        );
    else truetype.push(ttf);
  }
  for (const [family, characters] of byFamily) {
    const missing = [...characters].filter(
      (c) => !covered.get(family)?.has(c.codePointAt(0)),
    );
    if (missing.length)
      throw new Error(
        `${family} has no glyph for the figure characters ${JSON.stringify(missing.join(""))}; set them in another page font or change the label`,
      );
  }
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

/**
 * The files of one figure. `figure`: { body, width, height, alt, className }
 * (the inner SVG markup and its size); `styles`: { light, dark? }, the CSS
 * for each theme (custom properties resolved); `background`: the PNG's
 * background colour. Returns { light, dark?, png }: the standalone SVG of
 * each theme and the light one rasterised at 2×.
 */
export async function renderFigureFiles(figure, { styles, background }) {
  if (!styles.light) throw new Error("A figure needs at least a light style");
  const themed = {};
  let fonts = null;
  for (const [theme, style] of Object.entries(styles)) {
    const css = relevantCss(style, figure);
    fonts ??= await embeddedFonts(
      charactersByFamily(figure.body, css),
      css,
      figure.body,
    );
    themed[theme] = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" class="${figure.className}" viewBox="0 0 ${figure.width} ${figure.height}" width="${figure.width}" height="${figure.height}">
<title>${escapeAttr(figure.title ?? figure.alt)}</title>${figure.title ? `\n<desc>${escapeAttr(figure.alt)}</desc>` : ""}
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
      background,
      font: { loadSystemFonts: false, fontFiles },
      logLevel: "off",
    })
      .render()
      .asPng();
    return { ...themed, png };
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
        const { light, dark, png } = await renderFigureFiles(figure, {
          styles: Object.fromEntries(
            THEMES.map((theme) => [
              theme,
              resolveVariables(figureSvgStyle(theme), themeVariables(theme)),
            ]),
          ),
          background: themeVariables("light").get("bg"),
        });
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
