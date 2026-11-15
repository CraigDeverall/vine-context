import { describe, expect, it } from "vitest";
import { PackError, expandFragments, listBuiltinPacks, loadPack, resolvePack } from "../src/core/pack.js";
import { writePack } from "./helpers.js";

const MODEL = `
name: tiny
version: 1
title: Tiny
description: A tiny model for tests.
nodes:
  Note:
    description: A note.
    key: id
    properties:
      id: { type: id, required: true }
      text: { type: string, required: true }
relationships:
  FOLLOWS: { description: Comes after, from: [Note], to: [Note] }
search: { labels: [Note], text: text }
`;

const TOOL = (extra = "") => `
tools:
  - name: add_note
    kind: write
    description: Add a note to the graph.
    input:
      text: { type: string, required: true, description: The note }
    derive:
      id: { new_id: n }
      embedding: { embed: text }
    steps:
      - cypher: |
          CREATE (n:Note {id: $id, text: $text, embedding: $embedding}) RETURN n.id AS id
        single: true
${extra}`;

describe("model packs", () => {
  it("ships temporal-claims, and it loads", () => {
    expect(listBuiltinPacks()).toContain("temporal-claims");
    const pack = resolvePack("temporal-claims");
    expect(pack.model.search?.labels).toEqual(["Claim", "Question"]);
    expect(pack.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["add_claim", "ask_question", "link", "withdraw", "search", "beliefs", "open_questions", "conflicts", "history", "recent"]),
    );
    expect(pack.instructions).toMatch(/Before you add/);
    // Fragments are expanded at load time.
    expect(pack.tools.every((t) => t.steps.every((s) => !s.cypher.includes("{{")))).toBe(true);
  });

  it("gives read tools the reader role and write tools the contributor role by default", () => {
    const tools = resolvePack("temporal-claims").tools;
    expect(tools.find((t) => t.name === "search")!.role).toBe("reader");
    expect(tools.find((t) => t.name === "add_claim")!.role).toBe("contributor");
  });

  it("loads a minimal pack", () => {
    const pack = loadPack(writePack({ "model.yaml": MODEL, "tools.yaml": TOOL() }));
    expect(pack.model.name).toBe("tiny");
    expect(pack.tools[0]!.name).toBe("add_note");
  });

  it.each([
    ["a relationship to an unknown label", MODEL.replace("to: [Note]", "to: [Nope]"), TOOL(), /unknown node label Nope/],
    ["a search label that does not exist", MODEL.replace("labels: [Note]", "labels: [Ghost]"), TOOL(), /unknown node label Ghost/],
    ["a bad tool name", MODEL, TOOL().replace("add_note", "Add-Note"), /snake_case/],
    ["a derived parameter from an unknown input", MODEL, TOOL().replace("embed: text", "embed: body"), /unknown input body/],
    ["an input named like a server parameter", MODEL, TOOL().replace("text: { type", "now: { type: string, description: x }\n      text: { type"), /set by the server/],
    ["a built-in tool name", MODEL, TOOL().replace("add_note", "graph_info"), /built-in tool name/],
    ["an unknown fragment", MODEL, TOOL().replace("CREATE (n:Note", "MATCH (x) WHERE {{nope x}} CREATE (n:Note"), /unknown fragment/],
    ["an enum without values", MODEL, TOOL().replace("text: { type: string, required: true", "text: { type: enum, required: true"), /enum needs values/],
  ])("rejects %s", (_, model, tools, message) => {
    expect(() => loadPack(writePack({ "model.yaml": model, "tools.yaml": tools }))).toThrow(message as RegExp);
  });

  it("rejects a tool defined twice", () => {
    const twice = TOOL() + TOOL().replace("tools:\n", "");
    expect(() => loadPack(writePack({ "model.yaml": MODEL, "tools.yaml": twice }))).toThrow(/defined twice/);
  });

  it("reports a missing pack with the built-in names", () => {
    expect(() => resolvePack("no-such-pack")).toThrow(PackError);
    expect(() => resolvePack("no-such-pack")).toThrow(/temporal-claims/);
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

describe("view hints in packs", () => {
  const model = "name: hints\nversion: 1\ntitle: Hints\ndescription: x\nnodes:\n  Note:\n    description: A note\n    key: id\n    title: body\n    properties:\n      id: { type: id, required: true }\n      body: { type: string }\n";
  const tool = (extra: string) =>
    `tools:\n  - name: add_note\n    kind: write\n    description: Adds one note to the graph\n${extra}    steps:\n      - cypher: RETURN 1 AS id\n`;

  it("accepts a receipt view with an undo tool that exists", () => {
    const dir = writePack({
      "model.yaml": model,
      "tools.yaml": tool("    view: receipt\n    undo: { tool: add_note }\n"),
    });
    expect(loadPack(dir).tools[0]).toMatchObject({ view: "receipt", undo: { tool: "add_note", arg: "id", field: "id" } });
  });

  it("refuses an undo tool that isn't defined, and a title or time property that isn't there", () => {
    expect(() => loadPack(writePack({ "model.yaml": model, "tools.yaml": tool("    undo: { tool: remove_note }\n") }))).toThrow(/undo tool remove_note is not defined/);
    expect(() => loadPack(writePack({ "model.yaml": model.replace("title: body", "title: missing"), "tools.yaml": tool("") }))).toThrow(/missing is not one of its properties/);
    expect(() => loadPack(writePack({ "model.yaml": model, "tools.yaml": tool("    view: chart\n") }))).toThrow(/view/);
  });
});
