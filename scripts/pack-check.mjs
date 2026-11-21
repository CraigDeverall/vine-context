#!/usr/bin/env node
// Checks the package as npm would publish it: packs it, installs the tarball
// into an empty folder, and runs the installed `vine` command there.
// Run after a build: `npm run build && node scripts/pack-check.mjs`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

  const app = join(work, "app");
  run("npm", ["install", "--prefix", app, "--no-audit", "--no-fund", join(work, tarball)], work);

  const vine = join(app, "node_modules", ".bin", "vine");
  const env = { VINE_DATA_DIR: join(work, "data") };
  const version = run(vine, ["--version"], work, env).trim();
  const doctor = run(vine, ["doctor"], work, env);
  process.stdout.write(doctor);
  if (!doctor.includes("All checks passed.")) throw new Error("vine doctor did not pass from the installed package");
  console.log(`\nok    ${tarball} installs and runs (vine ${version})`);
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
