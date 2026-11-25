// Builds the MCP App views into self-contained HTML files:
// dist/apps/views.html (every view; the server fills in which one), and
// dist/apps/shell.html (the localhost host page for `vine ui`).
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "apps");
mkdirSync(out, { recursive: true });
const template = readFileSync(join(root, "apps", "index.html"), "utf8");
const production = process.env.NODE_ENV !== "development";
// The tab icon, for the localhost page only: the embedded views must not carry a <link>.
const favicon = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${readFileSync(join(root, "apps", "favicon.svg")).toString("base64")}">`;

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

async function bundle(entry, file, icon = "") {
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
    // The views are built on @squonk/ui (React 19); its Latin fonts are embedded.
    loader: { ".woff2": "dataurl" },
  });
  const js = r.outputFiles.find((f) => f.path.endsWith(".js")).text.replaceAll("</script", "<\\/script");
  const css = (r.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "").replaceAll("</style", "<\\/style");
  // Function replacements: the bundle contains `$` sequences that string replacements would expand.
  const html = template.replace("<!--VINE_ICON-->\n", () => (icon ? `${icon}\n` : "")).replace("/*VINE_CSS*/", () => css).replace("/*VINE_JS*/", () => js);
  writeFileSync(join(out, file), html);
  console.log(`apps: ${file} ${(html.length / 1024).toFixed(0)} KB`);
}

await bundle("main.tsx", "views.html");
await bundle("shell.tsx", "shell.html", favicon);
