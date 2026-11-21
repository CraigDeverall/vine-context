import { defineConfig } from "tsup";

// One bundled ESM file per entry. Native packages stay external: they ship
// prebuilt binaries that a bundler cannot inline.
export default defineConfig({
  entry: { cli: "src/cli/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  // One file: lazily imported modules are inlined, not split into chunks with
  // hashed names. A long-running MCP server or host then never loads code from
  // dist/ after it starts, so a rebuild can't pull files out from under it.
  splitting: false,
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  external: ["@relate/relate", "koffi", "node-datachannel"],
});
