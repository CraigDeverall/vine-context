import { describe, expect, it } from "vitest";
import { claimsPack, expandFragments } from "../src/core/pack.js";

describe("the Claims and Questions model", () => {
  it("ships and loads", () => {
    const pack = claimsPack();
    expect(pack.model.name).toBe("temporal-claims");
    expect(pack.model.search?.labels).toEqual(["Claim", "Question"]);
    expect(pack.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["add_claim", "ask_question", "link", "withdraw", "search", "beliefs", "open_questions", "conflicts", "history", "recent"]),
    );
    expect(pack.instructions).toMatch(/Before you add/);
    // Fragments are expanded at load time.
    expect(pack.tools.every((t) => t.steps.every((s) => !s.cypher.includes("{{")))).toBe(true);
  });

  it("gives read tools the reader role and write tools the contributor role", () => {
    const tools = claimsPack().tools;
    expect(tools.find((t) => t.name === "search")!.role).toBe("reader");
    expect(tools.find((t) => t.name === "add_claim")!.role).toBe("contributor");
  });

  it("names the change each write makes, and its write steps only check", () => {
    for (const t of claimsPack().tools.filter((x) => x.kind === "write")) {
      expect(t.apply).toBeDefined();
      for (const s of t.steps) expect(s.cypher).not.toMatch(/\b(CREATE|MERGE|SET|DELETE)\b/);
    }
  });
});

describe("fragments", () => {
  it("substitutes arguments and nests", () => {
    const f = { live: "%1.gone IS NULL", fresh: "{{live %1}} AND %1.at > T" };
    expect(expandFragments("WHERE {{fresh c}}", f)).toBe("WHERE ((c.gone IS NULL) AND c.at > T)");
  });

  it("stops runaway nesting", () => {
    expect(() => expandFragments("{{a}}", { a: "{{a}}" })).toThrow(/nest/);
  });
});
