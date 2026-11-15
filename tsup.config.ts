import { defineConfig } from "tsup";

// One bundled ESM file per entry. Native packages stay external: they ship
// prebuilt binaries that a bundler cannot inline.
export default defineConfig({
  entry: { cli: "src/cli/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  external: ["@relate/relate", "koffi", "node-datachannel"],
});
