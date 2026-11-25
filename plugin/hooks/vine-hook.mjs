#!/usr/bin/env node
// Runs `vine hook <event>` for an agent's lifecycle hook (Claude Code, Codex),
// passing the hook's stdin through, and makes sure nothing but a real answer
// reaches the agent: the plugin can be newer than the installed `vine`, and an
// older one prints its usage and exits 2, which would block the person's
// prompt. So: only a JSON answer from a clean exit is passed on, and this
// script always exits 0.
import { spawnSync } from "node:child_process";

try {
  const r = spawnSync("vine", ["hook", process.argv[2] ?? ""], {
    stdio: ["inherit", "pipe", "ignore"],
    encoding: "utf8",
    timeout: 4000,
    shell: process.platform === "win32", // vine is a .cmd shim there
  });
  const out = (r.stdout ?? "").trim();
  if (r.status === 0 && out.startsWith("{")) {
    JSON.parse(out);
    process.stdout.write(out + "\n");
  }
} catch {
  // say nothing
}
process.exit(0);
