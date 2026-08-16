/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// The bundle's own version, from package.json. Deliberately *not* the firmware's
// FW_VERSION: the frontend ships on its own cadence over LittleFS, and conflating
// the two would mean a CSS fix needed a firmware flash to be legible in the header.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

// The board is a single-threaded WebServer on a XIAO ESP32S3: every extra file is
// another request it has to serve in its own turn between bus exchanges, and the
// firmware pages already showed what that costs (README, "Polling runs on the board").
// So the build is tuned for *file count* first and bytes second — one document, one
// script, one stylesheet, everything else inlined as a data URI.
export default defineConfig({
  // Relative, because the bundle is served from /w/ on LittleFS and is also opened
  // straight off disk during development of the firmware side.
  base: './',

  define: {
    __WEB_VERSION__: JSON.stringify(version),
  },

  // Preact without @preact/preset-vite: esbuild's automatic JSX runtime does the job
  // and saves a Babel dependency chain we would otherwise be auditing licences for.
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'react-dom/test-utils': 'preact/test-utils',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },

  build: {
    // The ESP32 browser is whatever phone is in the car; es2020 is safe on every
    // mobile Safari/Chrome that can reach a captive AP and keeps the bundle small.
    target: 'es2020',
    // One stylesheet, never per-route chunks.
    cssCodeSplit: false,
    // There is exactly one chunk, so no <link rel="modulepreload"> is ever emitted
    // and Vite's polyfill for it is ~700 bytes of MutationObserver that would run on
    // every page load for nothing.
    modulePreload: false,
    // Inline every asset (fonts, icons, small images) into the JS/CSS rather than
    // emitting a file: an inlined 4 KB data URI is cheaper for the board than a
    // second HTTP round trip.
    assetsInlineLimit: 100 * 1024 * 1024,
    // Vite reports gzip size per chunk; scripts/gzip.mjs writes the real .gz files.
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        // No code splitting at all — dynamic imports are folded into the one chunk.
        inlineDynamicImports: true,
        // Fixed names, not content hashes. Deploying means copying files onto
        // LittleFS by hand; hashed names would leave orphans behind on every
        // upload and the partition is 1.5 MB shared with the trip logs.
        // Cache-busting is the firmware's job, the same way it version-stamps
        // /ui.css (see README, "tab switching").
        entryFileNames: 'app.js',
        chunkFileNames: 'app.js',
        assetFileNames: 'app[extname]',
      },
    },
  },

  test: {
    // The lib is deliberately DOM-free, so the tests need no jsdom dependency.
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
});
