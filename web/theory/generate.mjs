// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocsPage } from "../docs-layout.mjs";
import { siteHeader, siteFooter } from "../site-layout.mjs";
import { topics, topicAnchor, articleUrl } from "./content.mjs";
import { figures, figureFiles, figureUrl } from "./figures/index.mjs";
import {
  imageEntries,
  sameFile,
  withImageNamespace,
} from "../figure-assets.mjs";
import { viewerData, viewerIds, viewerUrl } from "./viewers/index.mjs";
import whatIsFem from "./what-is-fem.mjs";
import readingAStudy from "./reading-a-study.mjs";
import axialBar from "./verification/axial-bar.mjs";
import verificationStrategy from "./verification/strategy.mjs";
import consistentUnits from "./consistent-units.mjs";
import notation from "./notation.mjs";
import gradientDivergence from "./operators/gradient-divergence.mjs";
import tensorProducts from "./operators/tensor-products.mjs";
import integrationByParts from "./operators/integration-by-parts.mjs";
import referenceMapping from "./operators/reference-mapping.mjs";
import linearElasticity from "./solid-mechanics/linear-elasticity.mjs";
import equilibriumAndWeakForm from "./solid-mechanics/equilibrium-and-weak-form.mjs";
import elementsAndQuadrature from "./numerical-methods/elements-and-quadrature.mjs";
import assembly from "./numerical-methods/assembly.mjs";
import loadsAndConstraints from "./numerical-methods/loads-and-constraints.mjs";
import linearSolve from "./numerical-methods/linear-solve.mjs";
import displacementAndStress from "./results/displacement-and-stress.mjs";
import interpretationAndConvergence from "./results/interpretation-and-convergence.mjs";
import shellFormulation from "./shells/formulation.mjs";
import solidCoupling from "./shells/solid-coupling.mjs";
import simp from "./optimization/simp.mjs";
import constraintsAndConvergence from "./optimization/constraints-and-convergence.mjs";
import interpretingDesigns from "./optimization/interpreting-designs.mjs";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const articles = [
  whatIsFem,
  consistentUnits,
  readingAStudy,
  notation,
  gradientDivergence,
  tensorProducts,
  integrationByParts,
  referenceMapping,
  linearElasticity,
  equilibriumAndWeakForm,
  elementsAndQuadrature,
  assembly,
  loadsAndConstraints,
  linearSolve,
  displacementAndStress,
  interpretationAndConvergence,
  axialBar,
  verificationStrategy,
  shellFormulation,
  solidCoupling,
  simp,
  constraintsAndConvergence,
  interpretingDesigns,
];
const sections = [...new Set(topics.map((topic) => topic.section))];
const published = (topic) =>
  articles.some((article) => article.slug === topic.slug);
const topicUrl = (topic) =>
  published(topic) ? articleUrl(topic) : `/theory/#${topicAnchor(topic)}`;
// Articles link to a topic's permanent URL even before it is written. Until
// then the link points at the topic's planned entry in the overview, so a
// page never links to a missing article and goes live on regeneration.
// Links to unknown /theory/ paths are typos and fail the build.
function resolveTopicLinks(html) {
  return html.replaceAll(
    /href="\/theory\/([a-z0-9/-]+)\/(#[a-z0-9-]+)?"/g,
    (match, slug) => {
      const topic = topics.find((candidate) => candidate.slug === slug);
      if (!topic) throw new Error(`Link to unknown theory page: ${match}`);
      return published(topic) ? match : `href="${topicUrl(topic)}"`;
    },
  );
}
// Inline MathML is an atomic box, so browsers may wrap between it and the
// punctuation that follows ("(0, 0, 0.1)" then ". They…" on the next line).
// Keep adjacent brackets and punctuation on the same line as the math.
const bindMathPunctuation = (html) =>
  html.replaceAll(
    /([([]?)(<math>(?:(?!<math>)[\s\S])*?<\/math>)([.,;:!?)\]]+)/g,
    '<span class="math-nowrap">$1$2$3</span>',
  );
const escape = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");

function navigation(slug) {
  return `<ul><li><a href="/theory/"${slug === null ? ' aria-current="page"' : ""}>Theory overview</a></li></ul>
    ${sections
      .map(
        (
          section,
        ) => `<details class="docs-group"${slug === null || topics.some((topic) => topic.section === section && topic.slug === slug) ? " open" : ""}>
      <summary>${escape(section)}</summary><ul>${topics
        .filter((topic) => topic.section === section)
        .map(
          (topic) =>
            `<li><a href="${topicUrl(topic)}"${topic.slug === slug ? ' aria-current="page"' : ""}>${escape(topic.title)}${published(topic) ? "" : ' <small class="planned">(planned)</small>'}</a></li>`,
        )
        .join("")}</ul>
    </details>`,
      )
      .join("")}`;
}

function contents(sectionList) {
  return `<ul>${sectionList.map(([id, title]) => `<li><a href="#${id}">${escape(title)}</a></li>`).join("")}</ul>`;
}

function frame(slug, sectionList, body) {
  const list = navigation(slug);
  const currentTopic = topics.find((topic) => topic.slug === slug);
  return `<a class="skip-link" href="#main-content">Skip to content</a>
    ${siteHeader("theory", { themeSwitch: true })}
    <div class="docs theory-docs">
      <nav class="docs-nav" aria-label="Theory topics">${list}</nav>
      <main id="main-content" tabindex="-1">
        <details class="docs-menu"><summary>Theory contents</summary><div>
          <nav aria-label="Theory topics (mobile)">${list}</nav>
          <button type="button" class="theme-toggle" hidden>Dark theme</button>
        </div></details>
        <nav class="crumbs" aria-label="Breadcrumb"><a href="/">KoFEM</a> / ${slug === null ? "Theory" : `<a href="/theory/">Theory</a> / ${escape(currentTopic.section)} / ${escape(currentTopic.title)}`}</nav>
        ${body}
      </main>
      <nav class="docs-toc" aria-label="On this page"><p>On this page</p>${contents(sectionList)}</nav>
    </div>${siteFooter()}`;
}

// Pages with an interactive result viewer load three.js from /vendor/three/
// (see vite.config.ts) through an import map, then public/theory/viewer.js.
const viewerHead = `<script type="importmap">{"imports":{"three":"/vendor/three/three.module.min.js","three/addons/controls/OrbitControls.js":"/vendor/three/OrbitControls.js"}}</script>
    <script type="module" src="/theory/viewer.js"></script>`;

function page({ title, description, path, body, article = false }) {
  const head = `<link href="/theory.css" rel="stylesheet" />${body.includes('class="result-viewer"') ? `\n    ${viewerHead}` : ""}`;
  return renderDocsPage({
    title: `${title} | KoFEM Theory Guide`,
    description,
    path,
    generatedBy: "web/theory/generate.mjs (cd web && bun run theory:generate)",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": article ? "TechArticle" : "CollectionPage",
      headline: title,
      description,
      url: `https://kofem.org${path}`,
      isPartOf: { "@type": "CollectionPage", url: "https://kofem.org/theory/" },
    },
    body,
  })
    .replace("</head>", `${head}\n  </head>`)
    .replace(/[ \t]+$/gm, "");
}

export function renderTheoryPages() {
  const sectionId = (section) =>
    // Preserve overview bookmarks from when these extensions were planned.
    section === "Shells"
      ? "shells-later"
      : section === "Optimization"
        ? "optimization-later"
        : section
            .toLowerCase()
            .replaceAll(/[^a-z]+/g, "-")
            .replace(/-$/, "");
  const overview = `
    <h1>Theory Guide</h1>
    <p class="lede">The mathematics and numerical choices behind a KoFEM study.</p>
    <p>Start with modelling assumptions and consistent units, then follow the
      mathematics from displacement and strain to the linear system and its
      results. Worked examples make each concept concrete.</p>
    <p class="note">Follow the axial-bar path through the published articles below.
      Planned topics remain visible in the contents. Shell formulations and coupling follow the solid path, then SIMP topology optimization.</p>
    <p><a class="button" href="/theory/foundations/what-is-fem/">Start reading: What is FEM? →</a></p>
    <p><a href="/theory/foundations/reading-a-study/">Follow one complete study</a> from assumptions to <a href="/theory/verification/axial-bar/">executed displacement and stress checks</a>.</p>
    ${sections
      .map(
        (section) => `<section aria-labelledby="${sectionId(section)}">
      <h2 id="${sectionId(section)}">${escape(section)}</h2>
      <ul class="theory-topics">${topics
        .filter((topic) => topic.section === section)
        .map(
          (topic) =>
            `<li id="${topicAnchor(topic)}">${published(topic) ? `<a href="${articleUrl(topic)}">${escape(topic.title)}</a>` : `<span>${escape(topic.title)}</span> <small class="planned">Planned</small>`}</li>`,
        )
        .join("")}</ul>
    </section>`,
      )
      .join("")}
    <nav class="pager" aria-label="Reading order"><a class="next" rel="next" href="/theory/foundations/what-is-fem/"><small>Next</small>What is FEM? →</a></nav>`;
  const pages = [
    [
      "theory/index.html",
      page({
        title: "Theory Guide",
        description:
          "Connected articles explaining KoFEM’s physical assumptions, mathematics and numerical methods, from coherent units to verification of a static solid study.",
        path: "/theory/",
        body: frame(
          null,
          sections.map((section) => [sectionId(section), section]),
          overview,
        ),
      }),
    ],
  ];
  for (const article of articles) {
    const index = topics.findIndex((topic) => topic.slug === article.slug);
    if (index < 0) throw new Error(`Unknown theory article: ${article.slug}`);
    // A TeX "\;" written with one backslash in a JS string loses it and
    // renders a literal semicolon operator instead of a space.
    if (article.body.includes("<mo>;</mo>"))
      throw new Error(
        `${article.slug}: a TeX \\; spacing command lost its backslash; write "\\\\;" in the source`,
      );
    const topic = topics[index];
    // Keep the reading path continuous while planned topics remain in the contents.
    const previous = topics.slice(0, index).findLast(published);
    const next = topics.slice(index + 1).find(published);
    const pager = `<nav class="pager" aria-label="Reading order">
      <a class="prev" rel="prev" href="${previous ? topicUrl(previous) : "/theory/"}"><small>Previous</small>← ${previous ? escape(previous.title) : "Theory overview"}</a>
      ${next ? `<a class="next" rel="next" href="${topicUrl(next)}"><small>Next${published(next) ? "" : " · planned"}</small>${escape(next.title)} →</a>` : ""}</nav>`;
    pages.push([
      `theory/${topic.slug}/index.html`,
      page({
        title: topic.title,
        description: article.description,
        path: articleUrl(topic),
        article: true,
        body: frame(
          topic.slug,
          article.sections,
          `<h1>${escape(topic.title)}</h1>
        <details class="article-contents"><summary>On this page</summary>${contents(article.sections)}</details>
        ${bindMathPunctuation(resolveTopicLinks(article.body))}${pager}`,
        ),
      }),
    ]);
  }
  return pages;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Check the URL order against the agreed map without importing planning files
  // into the Docker build, whose context contains only web/ and gallery assets.
  const map = readFileSync(
    resolve(web, "../docs/theory/content-map.md"),
    "utf8",
  );
  const plannedUrls = [...map.matchAll(/\|\s*`(\/theory\/[^`]+)`\s*\|/g)].map(
    (match) => match[1],
  );
  if (JSON.stringify(plannedUrls) !== JSON.stringify(topics.map(articleUrl)))
    throw new Error(
      "Theory navigation differs from docs/theory/content-map.md",
    );
  const pages = renderTheoryPages();
  // Every figure must appear on a page; an unused one is dead weight.
  const used = new Set(
    pages.flatMap(([, html]) =>
      [...html.matchAll(/src="\/theory\/figures\/([a-z0-9-]+)\.png"/g)].map(
        (match) => match[1],
      ),
    ),
  );
  for (const id of figures.keys())
    if (!used.has(id)) throw new Error(`Theory figure ${id} is not used`);
  const sitemapPath = resolve(web, "public/sitemap.xml");
  const sitemap = withImageNamespace(readFileSync(sitemapPath, "utf8"));
  // Each article lists its figures' PNGs as images, for image search.
  const pageImages = (html) => [
    ...new Set(
      [...html.matchAll(/src="(\/theory\/figures\/[a-z0-9-]+\.png)"/g)].map(
        (match) => `https://kofem.org${match[1]}`,
      ),
    ),
  ];
  const block = `<!-- theory:start -->\n${pages.map(([path, html]) => `  <url><loc>https://kofem.org/${path.replace(/index.html$/, "")}</loc>${imageEntries(pageImages(html))}</url>`).join("\n")}\n  <!-- theory:end -->`;
  const nextSitemap = sitemap.includes("<!-- theory:start -->")
    ? sitemap.replace(/<!-- theory:start -->[\s\S]*?<!-- theory:end -->/, block)
    : sitemap.replace("</urlset>", `  ${block}\n</urlset>`);
  const outputs = [
    ...pages.map(([path, html]) => [resolve(web, path), html]),
    ...(
      await Promise.all(
        [...figures.keys()].map(async (id) => {
          const { svg, png } = await figureFiles(id);
          return [
            [resolve(web, `public${figureUrl(id)}`), svg],
            [resolve(web, `public${figureUrl(id, "png")}`), png],
          ];
        }),
      )
    ).flat(),
    ...viewerIds().map((id) => [
      resolve(web, `public${viewerUrl(id)}`),
      `${JSON.stringify(viewerData(id))}\n`,
    ]),
    [sitemapPath, nextSitemap],
  ];
  for (const [path, output] of outputs) {
    if (process.argv.includes("--check")) {
      if (!sameFile(path, output))
        throw new Error(
          `Stale generated page: ${path}; run bun run theory:generate`,
        );
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, output);
    }
  }
  console.log(
    `${process.argv.includes("--check") ? "Checked" : "Generated"} ${pages.length} theory pages, ${figures.size} figures, ${viewerIds().length} viewers and sitemap.`,
  );
}
