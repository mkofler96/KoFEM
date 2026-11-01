// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig, loadEnv, type Connect, type PluginOption } from "vite";
import { fileURLToPath } from "node:url";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import istanbul from "vite-plugin-istanbul";
import { injectSiteLayout } from "./site-layout.mjs";
import {
  analyticsPlugin,
  analyticsSnippet,
  injectAnalytics,
} from "./vite-analytics";

const htmlEntry = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The static pages (index.html, privacy/index.html, and examples/index.html
// plus one examples/<id>/index.html per example, which
// examples/validation/run.mjs --report generates) are fully static — Vite
// emits them byte-for-byte, they import no hashed assets. Feeding them as extra
// MPA rollup inputs is flaky (in some environments rollup crosses the
// landing/app chunk names and drops the landing HTML entirely, leaving "/" on
// nginx's default page). So the build has a single entry (the app) and we copy
// the static pages into dist/ deterministically. The analytics consent block is
// injected here because these pages bypass Vite's HTML pipeline
// (transformIndexHtml only runs on the app entry at build time). Dev is
// unaffected: rollupOptions is build-only, the dev server serves the pages from
// the filesystem, and transformIndexHtml injects analytics there instead.
const STATIC_PAGES = [
  "index.html",
  "privacy/index.html",
  "examples/index.html",
  ...readdirSync(htmlEntry("./examples/"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `examples/${entry.name}/index.html`),
];

// The files each example is opened and drawn from live outside web/, with
// everything else example-related (examples/gallery/site/): the <id>.vtu (and
// optional <id>.step) the app's `?example=` loader fetches and the <id>.png
// figure of its page. They are served at /examples/, next to the pages. The
// Docker build receives the folder as the named build context "gallery"
// (web/Dockerfile).
const GALLERY_SITE = htmlEntry("../examples/gallery/site/");

const copyStaticPages = (snippet: string): PluginOption => ({
  name: "copy-static-pages",
  apply: "build",
  closeBundle() {
    cpSync(GALLERY_SITE, htmlEntry("./dist/examples/"), { recursive: true });
    for (const page of STATIC_PAGES) {
      const html = injectAnalytics(
        injectSiteLayout(
          readFileSync(htmlEntry(`./${page}`), "utf8"),
          `/${page}`,
        ),
        snippet,
      );
      mkdirSync(htmlEntry(`./dist/${page}/..`), { recursive: true });
      writeFileSync(htmlEntry(`./dist/${page}`), html);
    }
  },
});

const GALLERY_TYPES: Record<string, string> = {
  ".vtu": "application/xml",
  ".step": "application/octet-stream",
  ".png": "image/png",
};

// Where an address of the retired /validation/ pages now lives, or null for
// any other path. The surface-traction case became the axial bar's page.
// nginx.conf.template redirects the same way in production.
function validationRedirect(path: string): string | null {
  const m = /^\/validation(\/.*)?$/.exec(path);
  if (!m) return null;
  const rest = m[1] ?? "/";
  if (rest.startsWith("/surface-traction")) return "/examples/axial-bar/";
  return `/examples${rest}`;
}

// A folder under /examples/ requested without its trailing slash gets one, as
// nginx answers it in production.
const slashRedirect = (path: string): string | null =>
  path === "/examples" || /^\/examples\/[\w-]+$/.test(path) ? `${path}/` : null;

// Permanent redirects shared by the dev and preview servers.
const redirects: Connect.NextHandleFunction = (req, res, next) => {
  const [path, query] = (req.originalUrl ?? "").split("?");
  const target = validationRedirect(path) ?? slashRedirect(path);
  if (!target) {
    next();
    return;
  }
  res.statusCode = 301;
  res.setHeader("Location", `${target}${query ? `?${query}` : ""}`);
  res.end();
};

// Dev server: the example files from examples/gallery/site/; the pages
// themselves are under web/examples/ and served by Vite, which expands the
// site layout placeholders through transformIndexHtml. `vite preview` serves
// dist/, which copyStaticPages fills, and only needs the redirects.
const serveGallery = (): PluginOption => ({
  name: "serve-gallery",
  configureServer(server) {
    server.middlewares.use(redirects);
    server.middlewares.use("/examples", (req, res, next) => {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
      const type = GALLERY_TYPES[extname(path)];
      if (!type) return next();
      const file = join(GALLERY_SITE, path.slice(1));
      if (!file.startsWith(GALLERY_SITE) || !existsSync(file)) return next();
      if (!statSync(file).isFile()) return next();
      res.setHeader("Content-Type", type);
      res.end(readFileSync(file));
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use(redirects);
  },
});

// Uncompressed size of the engine binary, compiled into the adapter
// (src/wasm/pkg/kofem_wasm.js) as the total its download progress counts
// toward: the wasm is served gzipped, so Content-Length (when sent at all)
// counts compressed bytes while the stream yields decompressed ones.
function engineBytes(): number {
  const engine = htmlEntry("./src/wasm/pkg/kofem_wasm_emcc.wasm");
  if (!existsSync(engine))
    throw new Error(
      `${engine} is missing — install the engine with scripts/fetch-wasm-engine.sh (the bun pre-hooks run it) or build it with scripts/build-wasm.sh.`,
    );
  return statSync(engine).size;
}

// COVERAGE=1 instruments all src/ modules with Istanbul counters so Playwright
// can collect runtime coverage (see tests/coverage.ts).  Off by default: the
// instrumented bundle is bigger and slower.
const coveragePlugins: PluginOption[] = process.env.COVERAGE
  ? [
      istanbul({
        include: "src/*",
        extension: [".ts", ".tsx"],
        exclude: ["node_modules", "src/wasm/pkg/**"],
        forceBuildInstrument: true,
      }),
    ]
  : [];

export default defineConfig(({ mode }) => {
  // VITE_GA_ID (empty prefix loads it from .env files and the process env). When
  // set at build time it is baked in; when unset the snippet ships a placeholder
  // for runtime substitution by the Docker entrypoint (or stays inert on other
  // static hosts). See vite-analytics.ts.
  const gaSnippet = analyticsSnippet(
    loadEnv(mode, process.cwd(), "").VITE_GA_ID,
  );

  return {
    // Multi-page: "/" serves the static marketing landing (index.html); the
    // React solver app lives at "/app/" (app/index.html). MPA mode disables the
    // SPA history fallback so the two entries are served independently.
    appType: "mpa",
    define: { __KOFEM_ENGINE_BYTES__: JSON.stringify(engineBytes()) },
    plugins: [
      {
        name: "site-layout",
        transformIndexHtml: {
          order: "pre",
          handler: (html, context) => injectSiteLayout(html, context.path),
        },
      },
      react(),
      wasm(),
      topLevelAwait(),
      copyStaticPages(gaSnippet),
      serveGallery(),
      analyticsPlugin(gaSnippet),
      ...coveragePlugins,
    ],
    worker: {
      format: "es",
      plugins: () => [wasm(), topLevelAwait(), ...coveragePlugins],
    },
    build: {
      target: "esnext",
      // Fail closed: source maps and unminified output are an explicit
      // `--mode development` opt-in (see the build:dev script). Every other
      // invocation — the default production build, CI, or any custom/empty mode
      // a deploy host might pass — ships minified and map-free. Keying these off
      // `mode === "production"` instead leaks readable, mapped source whenever
      // the mode is anything but that exact string.
      sourcemap: mode === "development",
      minify: mode === "development" ? false : "esbuild",
      rollupOptions: {
        input: {
          app: htmlEntry("./app/index.html"),
        },
      },
    },
  };
});
