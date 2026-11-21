// Join codes: vine1_<room>.<secret>, found in whatever text the person pastes.

import { describe, expect, it } from "vitest";
import { CODE_PREFIX, formatCode, newLink, parseCode } from "../src/p2p/link.js";

describe("join codes", () => {
  const link = newLink();
  const code = formatCode(link);

  it("formats a self-describing code", () => {
    expect(code).toMatch(/^vine1_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  });

  it("parses a bare code back to the same room and secret", () => {
    const back = parseCode(code);
    expect(back.room).toBe(link.room);
    expect(back.secret.equals(link.secret)).toBe(true);
  });

  it("finds the code inside a sentence or a slash command", () => {
    for (const text of [`Join my context graph: /vine-context:join ${code}`, `here: ${code}.`, `(${code})`, `\`${code}\``, `  ${code}\n`])
      expect(parseCode(text).room).toBe(link.room);
  });

  it("says a cut-short or damaged code is damaged", () => {
    expect(() => parseCode(code.slice(0, -5))).toThrow(/damaged or cut short/);
    expect(() => parseCode(code.replace(".", ""))).toThrow(/damaged or cut short/);
    expect(() => parseCode(`${code}xyz`)).toThrow(/damaged or cut short/);
    expect(() => parseCode(`vine1_${link.room.slice(0, 21)}!.${code.split(".")[1]}`)).toThrow(/damaged or cut short/);
  });

  it("rejects other text", () => {
    expect(() => parseCode("see you tomorrow")).toThrow(/not a Vine Context join code/);
    expect(() => parseCode(`vine2_${code.slice(CODE_PREFIX.length)}`)).toThrow(/not a Vine Context join code/);
  });
});
