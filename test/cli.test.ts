import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("vine cli", () => {
  it("prints the package version", () => {
    // Node itself, not `npx`: on Windows npx is a .cmd shim, which execFile can't run.
    const out = execFileSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
