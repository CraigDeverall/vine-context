import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("vine cli", () => {
  it("prints the package version", () => {
    // Node itself, not `npx`: on Windows npx is a .cmd shim, which execFile can't run.
    const out = execFileSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  const vine = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], { encoding: "utf8", input: "" });

  it.each([["demo", "--help"], ["demo", "-h"], ["turn", "--help"], ["hook", "--help"]])("prints the command's usage for vine %s %s", (cmd, flag) => {
    const r = vine(cmd, flag);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`  ${cmd} `);
    expect(r.stdout).not.toContain("Commands:");
  });

  it("explains an unknown option without a stack trace", () => {
    const r = vine("demo", "--bogus");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Unknown option '--bogus'");
    expect(r.stderr).toContain("  demo [");
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});
