import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import istanbul from "vite-plugin-istanbul";

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
  plugins: [react(), wasm(), topLevelAwait(), ...coveragePlugins],
  worker: {
    format: "es",
    plugins: () => [wasm(), topLevelAwait(), ...coveragePlugins],
  },
  optimizeDeps: {
    exclude: ["kofem-wasm"],
  },
  build: {
    target: "esnext",
    sourcemap: mode !== "production",
    minify: mode === "production" ? "esbuild" : false,
  },
}));
