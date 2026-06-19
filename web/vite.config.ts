import { defineConfig, type PluginOption } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import istanbul from "vite-plugin-istanbul";

const htmlEntry = (p: string) => fileURLToPath(new URL(p, import.meta.url));

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

export default defineConfig(({ mode }) => ({
  // Multi-page: "/" serves the static marketing landing (index.html); the React
  // solver app lives at "/app/" (app/index.html). MPA mode disables the SPA
  // history fallback so the two entries are served independently.
  appType: "mpa",
  plugins: [react(), wasm(), topLevelAwait(), ...coveragePlugins],
  worker: {
    format: "es",
    plugins: () => [wasm(), topLevelAwait(), ...coveragePlugins],
  },
  build: {
    target: "esnext",
    sourcemap: mode !== "production",
    minify: mode === "production" ? "esbuild" : false,
    rollupOptions: {
      input: {
        landing: htmlEntry("./index.html"),
        app: htmlEntry("./app/index.html"),
      },
    },
  },
}));
