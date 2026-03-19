#!/usr/bin/env node
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/bundle.js",
  // Only externalize actual Node built-ins; bundle all npm deps.
  external: ["node:*"],
  // CJS interop: some transitive deps (mqtt, ws) use dynamic require() internally.
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});

console.log("Bundle written to dist/bundle.js");
