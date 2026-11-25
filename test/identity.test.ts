// The name others see: found from the strongest source there is, and never
// missing. The key is the identity; the name is a label.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NAME_RE, generatedName, isGuessedName, loadIdentity, resolveName, setName, type NameProbes } from "../src/core/identity.js";
import { tempDir } from "./helpers.js";

const probes = (p: Partial<Record<keyof NameProbes, string>>): NameProbes => ({ git: () => p.git, os: () => p.os, login: () => p.login });

describe("the name others see", () => {
  let before: string | undefined;
  beforeEach(() => {
    before = process.env.VINE_USER;
    delete process.env.VINE_USER;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.VINE_USER;
    else process.env.VINE_USER = before;
  });

  it("takes the strongest source: VINE_USER, the saved name, git, the computer account, the login name", () => {
    const dir = tempDir();
    const all = probes({ git: "Git Name", os: "Account Name", login: "loginname" });
    expect(resolveName(dir, all)).toEqual({ name: "Git Name", source: "git" });
    expect(resolveName(dir, probes({ os: "Account Name", login: "loginname" }))).toEqual({ name: "Account Name", source: "os" });
    expect(resolveName(dir, probes({ login: "loginname" }))).toEqual({ name: "loginname", source: "login" });
    setName(dir, "Chosen");
    expect(resolveName(dir, all)).toEqual({ name: "Chosen", source: "set_my_name" });
    process.env.VINE_USER = "from-env";
    expect(resolveName(dir, all)).toEqual({ name: "from-env", source: "VINE_USER" });
  });

  it("cleans a found name, and passes over one that is unusable or generic", () => {
    const dir = tempDir();
    expect(resolveName(dir, probes({ git: "  Craig (work) <c@example.com> " })).name).toBe("Craig work cexample.com");
    expect(resolveName(dir, probes({ git: "!!!", os: "System Administrator", login: "craig" }))).toEqual({ name: "craig", source: "login" });
    expect(resolveName(dir, probes({ os: "Ubuntu", login: "ubuntu" })).source).toBe("generated");
  });

  it("makes up a name from the key when nothing is found: valid, and the same every time", () => {
    const dir = tempDir();
    expect(existsSync(join(dir, "identity.json"))).toBe(false);
    const made = resolveName(dir, probes({ login: "root" }));
    expect(made.source).toBe("generated");
    expect(made.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(NAME_RE.test(made.name)).toBe(true);
    // Making the name made the key it comes from, and the identity loads that same key.
    const id = loadIdentity(dir, made.name);
    expect(generatedName(id.publicKey)).toBe(made.name);
    expect(resolveName(dir, probes({}))).toEqual(made);
    expect(generatedName(loadIdentity(tempDir(), "x").publicKey)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it("counts a login or made-up name as a guess, and the others as the person's own", () => {
    expect((["VINE_USER", "set_my_name", "git", "os", "login", "generated"] as const).filter(isGuessedName)).toEqual(["login", "generated"]);
  });
});
