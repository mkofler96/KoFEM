# KoFEM Blog

The website's blog lives at `/blog/`. Articles use the same navigation,
typography, and remembered light/dark theme as Examples and Theory.

Add an article module in `web/blog/posts/`, then register it in
`web/blog/posts.mjs`. Each post has a permanent slug, title, description,
publication date (`YYYY-MM-DD`), author, and HTML body. Use permanent IDs on
section headings, explain numerical claims, and credit upstream work beside
the relevant discussion. Apply the repository's `plain-writing` skill and its
maintainer-supplied academic style reference.

Run `cd web && bun run blog:generate` and commit the generated HTML and
sitemap. `bun run test:blog` verifies that they match their sources, and the
blog and shared-site Playwright tests cover navigation, static content,
metadata, themes, redirects, and narrow screens. Blog pages are copied into
the production bundle by Vite and served as static pages by nginx.

The first post describes PR #534 at source snapshot `f14481b`, with MFEM
notices added in `3a94800`. Its timings come from that PR's benchmark report;
they were not remeasured for the article.
