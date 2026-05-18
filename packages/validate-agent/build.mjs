/**
 * Bundles src/cli.mjs + all dependencies into a single dist/cli.mjs
 * that works standalone with just Node.js — no install required.
 *
 * Run: node build.mjs
 */

import { build } from "esbuild";
import { writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(__dirname, "src/cli.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: resolve(__dirname, "dist/cli.mjs"),
  // Bundle ALL dependencies inline (jszip, validateManifest, etc.)
  // so the output is a single fully self-contained file
  packages: "bundle",
  // Tree-shake unused exports
  treeShaking: true,
  // Minify whitespace but keep identifiers readable for debuggability
  minifyWhitespace: true,
  minifyIdentifiers: false,
  minifySyntax: true,
  // Node.js built-ins stay external (they are provided by the runtime)
  external: [
    "node:fs", "node:path", "node:url", "node:crypto",
    "fs", "path", "url", "crypto",
  ],
  logLevel: "info",
});

// Make the output executable on Unix
try {
  const { chmodSync } = await import("node:fs");
  chmodSync(resolve(__dirname, "dist/cli.mjs"), 0o755);
} catch {
  // Windows — chmod not needed
}

console.log("✓ dist/cli.mjs built successfully");
