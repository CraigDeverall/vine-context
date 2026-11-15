import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("p2pcg cli", () => {
  it("prints the package version", () => {
    const out = execFileSync("npx", ["tsx", "src/cli/index.ts", "--version"], { encoding: "utf8" });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
