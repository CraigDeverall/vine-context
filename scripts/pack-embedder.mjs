// Assembles the npm package that carries the prebuilt embedder for one
// platform: the addon from native/embedder/dist and the bge-small model.
// Run after `npm run build:embedder`.
//
//   node scripts/pack-embedder.mjs            assemble native/embedder/npm/<os>-<arch>/
//   node scripts/pack-embedder.mjs --pack     and write its .tgz beside it
//
// The package is named for the Node that runs this script, so run it with a
// Node of the platform the addon was built for.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "native", "embedder", "dist");
const model = "bge-small-en-v1.5";
const key = `${process.platform}-${process.arch}`;
const name = `vine-context-embedder-${key}`;
const { version, license, repository } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Exactly these files: dist may hold other models and exports.
const files = ["embedder.node", join("models", model, "model_quantized.onnx"), join("models", model, "tokenizer.json")];
for (const f of files) if (!existsSync(join(dist, f))) throw new Error(`${join(dist, f)} is missing. Run \`npm run build:embedder\` first.`);

const out = join(root, "native", "embedder", "npm", key);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "models", model), { recursive: true });
for (const f of files) cpSync(join(dist, f), join(out, f));

writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name,
      version,
      description: `The semantic search embedder for vine-context, prebuilt for ${key}`,
      license,
      repository,
      os: [process.platform],
      cpu: [process.arch],
      // Built against glibc; on musl (Alpine) npm skips it and vine keeps the built-in embedder.
      ...(process.platform === "linux" ? { libc: ["glibc"] } : {}),
      files: ["embedder.node", "models"],
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(out, "README.md"),
  `# ${name}

The optional semantic search embedder for [vine-context](https://www.npmjs.com/package/vine-context), prebuilt for ${key}.
Install it beside vine-context and start vine with \`VINE_EMBEDDER=bge-small\`.

- \`embedder.node\`: a Node addon built from \`native/embedder\` in the vine-context repository (Apache-2.0). It runs the model on the CPU with tract and tokenizers.
- \`models/${model}/\`: the int8 ONNX export of BAAI's bge-small-en-v1.5 (MIT), from \`Xenova/bge-small-en-v1.5\` on Hugging Face.
`,
);

const mb = (f) => (statSync(f).size / 1e6).toFixed(1);
console.log(`${name}@${version}: ${out}`);
console.log(`  addon ${mb(join(out, "embedder.node"))} MB, model ${mb(join(out, "models", model, "model_quantized.onnx"))} MB`);

if (process.argv.includes("--pack")) {
  const dest = join(root, "native", "embedder", "npm");
  // npm is a .cmd shim on Windows, which needs a shell.
  execFileSync("npm", ["pack", "--pack-destination", dest], { cwd: out, shell: process.platform === "win32", stdio: ["ignore", "ignore", "inherit"] });
  const tgz = join(dest, `${name}-${version}.tgz`);
  console.log(`  ${tgz} (${mb(tgz)} MB)`);
}
