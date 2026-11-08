// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocsPage } from "../docs-layout.mjs";
import { siteHeader, siteFooter } from "../site-layout.mjs";
import { posts } from "./posts.mjs";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = "https://kofem.org";
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const postPath = (post) => `/blog/${post.slug}/`;
const readingMinutes = (post) =>
  Math.max(
    1,
    Math.ceil(
      post.body
        .replace(/<[^>]*>/g, " ")
        .trim()
        .split(/\s+/).length / 200,
    ),
  );
const dateLabel = (date) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));

function postSchema(post) {
  return {
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    url: `${site}${postPath(post)}`,
    datePublished: post.date,
    author: { "@type": "Person", name: post.author },
    isPartOf: { "@type": "Blog", url: `${site}/blog/`, name: "KoFEM Blog" },
  };
}

function page({ title, description, path, body, schema }) {
  return renderDocsPage({
    title: `${title} | KoFEM Blog`,
    description,
    path,
    generatedBy: "web/blog/generate.mjs (cd web && bun run blog:generate)",
    jsonLd: { "@context": "https://schema.org", ...schema },
    body: `<a class="skip-link" href="#main-content">Skip to content</a>
    ${siteHeader("blog", { themeSwitch: true })}
    <main class="blog-main" id="main-content" tabindex="-1">${body}</main>
    ${siteFooter()}`,
  })
    .replace(
      "</head>",
      '    <link href="/blog.css" rel="stylesheet" />\n  </head>',
    )
    .replace(
      'property="og:type" content="article"',
      `property="og:type" content="${path === "/blog/" ? "website" : "article"}"`,
    )
    .replace(/[ \t]+$/gm, "");
}

export function renderBlogPages() {
  const slugs = new Set();
  for (const post of posts) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug) || slugs.has(post.slug))
      throw new Error(`Invalid or duplicate blog slug: ${post.slug}`);
    slugs.add(post.slug);
    const date = new Date(`${post.date}T12:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(post.date) ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== post.date
    )
      throw new Error(`Invalid blog date: ${post.date}`);
    for (const field of ["title", "description", "author", "body"])
      if (typeof post[field] !== "string" || !post[field].trim())
        throw new Error(`Blog post ${post.slug} is missing ${field}`);
  }
  const ordered = [...posts].sort((left, right) =>
    right.date.localeCompare(left.date),
  );
  const description =
    "Development notes on KoFEM’s solver, numerical methods, and implementation.";
  const pages = [
    [
      "blog/index.html",
      page({
        title: "Blog",
        description,
        path: "/blog/",
        schema: {
          "@type": "Blog",
          name: "KoFEM Blog",
          description,
          url: `${site}/blog/`,
          blogPost: ordered.map(postSchema),
        },
        body: `<header class="blog-heading"><h1>Blog</h1>
      <p class="lede">${description}</p></header>
      <section class="blog-posts" aria-label="Posts">${ordered
        .map(
          (post) => `
        <article class="blog-entry">
          <p class="blog-meta"><time datetime="${post.date}">${dateLabel(post.date)}</time><span aria-hidden="true"> · </span>${readingMinutes(post)} min read</p>
          <h2><a href="${postPath(post)}">${escape(post.title)}</a></h2>
          <p>${escape(post.description)}</p>
          <a class="blog-read" href="${postPath(post)}" aria-label="Read ${escape(post.title)}">Read article <span aria-hidden="true">→</span></a>
        </article>`,
        )
        .join("")}
      </section>`,
      }),
    ],
  ];
  for (const post of ordered) {
    pages.push([
      `blog/${post.slug}/index.html`,
      page({
        title: post.title,
        description: post.description,
        path: postPath(post),
        schema: postSchema(post),
        body: `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">KoFEM</a> / <a href="/blog/">Blog</a></nav>
        <article>
          <header class="blog-heading"><h1>${escape(post.title)}</h1>
            <p class="blog-meta">${escape(post.author)}<span aria-hidden="true"> · </span><time datetime="${post.date}">${dateLabel(post.date)}</time><span aria-hidden="true"> · </span>${readingMinutes(post)} min read</p>
          </header>
          ${post.body}
        </article>
        <nav class="blog-back" aria-label="Blog"><a href="/blog/">← All posts</a></nav>`,
      }),
    ]);
  }
  return pages;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const pages = renderBlogPages();
  const sitemapPath = resolve(web, "public/sitemap.xml");
  const sitemap = readFileSync(sitemapPath, "utf8");
  const block = `<!-- blog:start -->\n${pages.map(([path]) => `  <url><loc>${site}/${path.replace(/index.html$/, "")}</loc></url>`).join("\n")}\n  <!-- blog:end -->`;
  const nextSitemap = sitemap.includes("<!-- blog:start -->")
    ? sitemap.replace(/<!-- blog:start -->[\s\S]*?<!-- blog:end -->/, block)
    : sitemap.replace("</urlset>", `  ${block}\n</urlset>`);
  for (const [path, output] of [
    ...pages.map(([path, html]) => [resolve(web, path), html]),
    [sitemapPath, nextSitemap],
  ]) {
    if (process.argv.includes("--check")) {
      if (readFileSync(path, "utf8") !== output)
        throw new Error(
          `Stale blog output: ${path}; run bun run blog:generate`,
        );
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, output);
    }
  }
  console.log(
    `${process.argv.includes("--check") ? "Checked" : "Generated"} ${pages.length} blog pages and sitemap.`,
  );
}
