// Builds the MCP App views into self-contained HTML files:
// dist/apps/views.html (every view; the server fills in which one), and
// dist/apps/shell.html (the localhost host page for `p2pcg ui`).
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "apps");
mkdirSync(out, { recursive: true });
const template = readFileSync(join(root, "apps", "index.html"), "utf8");
const production = process.env.NODE_ENV !== "development";

// Zod re-exports every locale as a namespace, which defeats tree-shaking. The
// views only need English messages, so the locale index becomes English only.
const englishOnly = {
  name: "zod-english-only",
  setup(b) {
    b.onResolve({ filter: /locales\/index\.js$/ }, (args) =>
      /[\\/]zod[\\/]/.test(args.importer) ? { path: "zod-locales", namespace: "stub", pluginData: args.resolveDir } : undefined,
    );
    b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: `export { default as en } from "./en.js";`,
      resolveDir: join(args.pluginData, "..", "locales"),
      loader: "js",
    }));
  },
};

async function bundle(entry, file) {
  const r = await build({
    entryPoints: [join(root, "apps", "src", entry)],
    bundle: true,
    write: false,
    minify: production,
    format: "iife",
    target: "es2022",
    platform: "browser",
    jsx: "automatic",
    outdir: out,
    define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
    logLevel: "warning",
    legalComments: "none",
    plugins: [englishOnly],
    // The views are written against React's API and run on Preact: a tenth of the size.
    alias: { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime", "react-dom/client": "preact/compat/client" },
  });
  const js = r.outputFiles.find((f) => f.path.endsWith(".js")).text.replaceAll("</script", "<\\/script");
  const css = (r.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "").replaceAll("</style", "<\\/style");
  // Function replacements: the bundle contains `$` sequences that string replacements would expand.
  const html = template.replace("/*P2PCG_CSS*/", () => css).replace("/*P2PCG_JS*/", () => js);
  writeFileSync(join(out, file), html);
  console.log(`apps: ${file} ${(html.length / 1024).toFixed(0)} KB`);
}

await bundle("main.tsx", "views.html");
await bundle("shell.tsx", "shell.html");
