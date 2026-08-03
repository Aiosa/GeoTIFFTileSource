import path from "path";
import { defineConfig } from "vite";
import license from "rollup-plugin-license";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig(({ mode }) => {
  const lite = mode === "lite";

  return {
    server: {
      open: "/demo/demo.html",
      watch: {
        usePolling: true,
      },
    },
    build: {
      sourcemap: !lite,

      lib: {
        entry: path.resolve(__dirname, "src/main.js"),
        name: "GeoTIFFTileSource",

        // lite: single ESM file (best chance of “few files”)
        // normal: keep your es + umd outputs
        formats: lite ? ["es"] : ["es", "umd"],

        fileName: (format) => {
          if (lite) return "geotiff-tilesource.lite.mjs";
          return format === "es"
            ? "geotiff-tilesource.mjs"
            : "geotiff-tilesource.min.js";
        },
      },

      rollupOptions: lite
        ? {
          output: {
            inlineDynamicImports: true,
            manualChunks: undefined,
          },
        }
        : undefined,
    },

    worker: {
      format: "es",
    },

    plugins: [
      license({
        sourcemap: !lite,
        thirdParty: {
          output: path.join(__dirname, "dist", "bundled-licenses.txt"),
          includePrivate: false,
          includeSelf: true,
        },
      })
    ],

    test: {
      projects: [
        {
          test: {
            name: "layout-jsdom",
            environment: "jsdom",
            setupFiles: ["test/polyfills/worker.js"],
            browser: { enabled: false },
            include: ["test/pyramid-layout.test.js"],
          },
        },
        {
          test: {
            name: "browser",
            environment: "jsdom",
            // No worker polyfill here: Chromium has a real Worker, and the polyfill's
            // node:worker_threads import fails to load in the browser.
            browser: {
              enabled: true,
              provider: playwright(),
              instances: [{ browser: "chromium" }],
            },
            // Everything except the jsdom-only layout suite, so a new test file is not
            // silently skipped by an out-of-date list.
            include: ["test/**/*.test.js"],
            exclude: ["test/pyramid-layout.test.js"],
          },
        },
      ],
    },
  };
});
