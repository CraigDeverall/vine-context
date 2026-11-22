#!/usr/bin/env node
// Checks the package as npm would publish it: packs it, installs the tarball
// into an empty folder, and runs the installed `vine` command there.
// Run after a build: `npm run build && node scripts/pack-check.mjs`.
//
// If `npm run pack:embedder` has made this platform's embedder package, it is
// installed beside vine-context and `vine doctor` must find and run it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "vine-pack-"));
// npm and the installed bin are .cmd shims on Windows, which need a shell.
const shell = process.platform === "win32";
const run = (cmd, args, cwd, env = {}) =>
  execFileSync(cmd, args, { cwd, shell, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env } });

try {
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", work], root);
  const tarball = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack made no tarball");

  const { version: packed } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const embedder = join(root, "native", "embedder", "npm", `vine-context-embedder-${process.platform}-${process.arch}-${packed}.tgz`);
  const withEmbedder = existsSync(embedder);

  const app = join(work, "app");
  run("npm", ["install", "--prefix", app, "--no-audit", "--no-fund", join(work, tarball), ...(withEmbedder ? [embedder] : [])], work);

  const vine = join(app, "node_modules", ".bin", "vine");
  const env = { VINE_DATA_DIR: join(work, "data") };
  const version = run(vine, ["--version"], work, env).trim();
  const doctor = run(vine, ["doctor"], work, env);
  process.stdout.write(doctor);
  if (!doctor.includes("All checks passed.")) throw new Error("vine doctor did not pass from the installed package");
  console.log(`\nok    ${tarball} installs and runs (vine ${version})`);

  if (withEmbedder) {
    const semantic = run(vine, ["doctor"], work, { ...env, VINE_EMBEDDER: "bge-small" });
    const line = semantic.split("\n").find((l) => l.includes("search embedder")) ?? "";
    console.log(line);
    if (!line.startsWith("ok") || !line.includes("bge-small-en-v1.5-int8") || !semantic.includes("All checks passed."))
      throw new Error("vine doctor did not run the installed embedder package");
    console.log("ok    the embedder package installs beside it and runs");
  } else {
    console.log("skip  no embedder package built for this platform (npm run pack:embedder)");
  }
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
