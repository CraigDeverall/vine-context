// Builds the optional semantic embedder for this machine: the Rust addon in
// native/embedder, and the model files it reads. Needs a Rust toolchain.
//
//   npm run build:embedder               addon + bge-small
//   npm run build:embedder -- minilm     addon + MiniLM
//   npm run build:embedder -- all        addon + both models
//   npm run build:embedder -- --target x86_64-apple-darwin
//                                        cross-compile the addon for another Rust target
//
// The result goes to native/embedder/dist, where src/core/embed.ts looks.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const crate = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "embedder");
const dist = join(crate, "dist");

// The int8-quantized ONNX exports, pinned by content. A changed file upstream
// fails the build rather than silently changing every vector.
const MODELS = {
  "bge-small": {
    dir: "bge-small-en-v1.5",
    repo: "Xenova/bge-small-en-v1.5",
    files: {
      "tokenizer.json": ["tokenizer.json", "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66"],
      "model_quantized.onnx": ["onnx/model_quantized.onnx", "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4"],
    },
  },
  minilm: {
    dir: "all-MiniLM-L6-v2",
    repo: "Xenova/all-MiniLM-L6-v2",
    files: {
      "tokenizer.json": ["tokenizer.json", "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0"],
      "model_quantized.onnx": ["onnx/model_quantized.onnx", "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1"],
    },
  },
};

const args = process.argv.slice(2);
const t = args.indexOf("--target");
const target = t < 0 ? undefined : args.splice(t, 2)[1];
if (t >= 0 && !target) throw new Error("--target needs a Rust target triple");
const arg = args[0] ?? "bge-small";
const wanted = arg === "all" ? Object.keys(MODELS) : [arg];
for (const name of wanted) if (!MODELS[name]) throw new Error(`Unknown model '${name}'. Available: ${Object.keys(MODELS).join(", ")}, all.`);

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

try {
  execFileSync("cargo", ["build", "--release", ...(target ? ["--target", target] : [])], { cwd: crate, stdio: "inherit" });
} catch (e) {
  if (e.code === "ENOENT") throw new Error("cargo not found. Install Rust (https://rustup.rs) and make sure cargo is on PATH.");
  throw e;
}
const os = !target ? process.platform : target.includes("darwin") ? "darwin" : target.includes("windows") ? "win32" : "linux";
const lib = { darwin: "libvine_embedder.dylib", win32: "vine_embedder.dll" }[os] ?? "libvine_embedder.so";
mkdirSync(dist, { recursive: true });
copyFileSync(join(crate, "target", ...(target ? [target] : []), "release", lib), join(dist, "embedder.node"));
console.log(`addon: ${join(dist, "embedder.node")}`);

for (const name of wanted) {
  const m = MODELS[name];
  const dir = join(dist, "models", m.dir);
  mkdirSync(dir, { recursive: true });
  for (const [file, [path, want]] of Object.entries(m.files)) {
    const dest = join(dir, file);
    if (existsSync(dest) && sha256(dest) === want) continue;
    const url = `https://huggingface.co/${m.repo}/resolve/main/${path}`;
    console.log(`fetching ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const tmp = dest + ".part";
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    const got = sha256(tmp);
    if (got !== want) throw new Error(`${file} for ${name} has sha256 ${got}, expected ${want}. Not installed.`);
    renameSync(tmp, dest);
  }
  console.log(`model: ${dir}`);
}
