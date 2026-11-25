import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { embedderDir, HashEmbedder, makeEmbedder, ModelEmbedder, MODELS, platformPackage, type Embedder } from "../src/core/embed.js";
import { Graph } from "../src/core/graph.js";
import { act, alice, reader, tempDir } from "./helpers.js";

type Row = Record<string, any>;

/** Sorts texts into three topics by keyword, so "ship" lands on "release" without sharing a word. */
class TopicEmbedder implements Embedder {
  readonly name = "topic-4";
  readonly dim = 4;
  embed(text: string): number[] | null {
    if (/ship|release/i.test(text)) return [1, 0, 0, 0];
    if (/database|postgres/i.test(text)) return [0, 1, 0, 0];
    return [0, 0, 1, 0];
  }
}

const vectorLengths = (g: Graph) =>
  (g as any).conn.query("MATCH (n:Claim|Question) RETURN DISTINCT size(n.embedding) AS d").rows.map((r: Row) => Number(r.d));

async function seed(g: Graph) {
  const release = (await act(g, "add_claim", { text: "The release is scheduled for the first week of December." }, alice)) as Row;
  await act(g, "add_claim", { text: "We chose Postgres over MongoDB for the billing service." }, alice);
  await act(g, "add_claim", { text: "Our office is closed on public holidays." }, alice);
  await act(g, "ask_question", { text: "Who approves the holiday roster?" }, alice);
  return release;
}

describe("embedders", () => {
  it("defaults to the hash embedder and names the ones it knows", () => {
    expect(makeEmbedder(undefined)).toBeInstanceOf(HashEmbedder);
    expect(makeEmbedder("hash").name).toBe("hash-256");
    expect(() => makeEmbedder("nope")).toThrow(/Unknown embedder 'nope'. Available: hash, bge-small, minilm\./);
  });

  it("says how to install a model embedder that is not on this machine", () => {
    expect(() => new ModelEmbedder(MODELS["bge-small"]!, tempDir())).toThrow(
      /not installed on this machine.*Install vine-context-embedder-\w+-\w+ beside vine-context.*npm run build:embedder/s,
    );
  });

  it("looks in VINE_EMBEDDER_DIR first, then the installed platform package, then a checkout's build folder", () => {
    expect(platformPackage()).toBe(`vine-context-embedder-${process.platform}-${process.arch}`);
    const before = process.env.VINE_EMBEDDER_DIR;
    try {
      process.env.VINE_EMBEDDER_DIR = "/somewhere/else";
      expect(embedderDir()).toBe("/somewhere/else");
      delete process.env.VINE_EMBEDDER_DIR;
      // npm installs the platform package as an optional dependency where one is published for this machine.
      let installed: string | undefined;
      try {
        installed = dirname(createRequire(join(process.cwd(), "package.json")).resolve(`${platformPackage()}/package.json`));
      } catch {}
      expect(embedderDir()).toBe(installed ?? join(process.cwd(), "native", "embedder", "dist"));
    } finally {
      if (before === undefined) delete process.env.VINE_EMBEDDER_DIR;
      else process.env.VINE_EMBEDDER_DIR = before;
    }
  });
});

describe("changing a graph's embedder", () => {
  it("rebuilds every vector and the index on the next open, and back again", async () => {
    const dataDir = tempDir();
    const g1 = await Graph.open({ dataDir, name: "swap" });
    const release = await seed(g1);
    expect(vectorLengths(g1)).toEqual([256]);

    const g2 = await Graph.open({ dataDir, name: "swap", embedder: new TopicEmbedder() });
    expect((await g2.info()).embedder).toBe("topic-4");
    expect(vectorLengths(g2)).toEqual([4]);
    // No word in common with the claim: only the new vectors can find it.
    const found = (await act(g2, "search", { query: "ship" }, reader)) as Row[];
    expect(found[0]).toMatchObject({ id: release.id });
    // New writes use the new embedder too.
    await act(g2, "add_claim", { text: "The database migration ran on Tuesday." }, alice);
    expect(vectorLengths(g2)).toEqual([4]);

    const g3 = await Graph.open({ dataDir, name: "swap" });
    expect((await g3.info()).embedder).toBe("hash-256");
    expect(vectorLengths(g3)).toEqual([256]);
    const again = (await act(g3, "search", { query: "release December" }, reader)) as Row[];
    expect(again[0]).toMatchObject({ id: release.id });
  });
});

// Runs only where `npm run build:embedder` has been run, unless VINE_TEST_EMBEDDER names the model: then it must run.
const built = (short: string) => {
  if (process.env.VINE_TEST_EMBEDDER === short) return true;
  const m = MODELS[short]!;
  return existsSync(join(embedderDir(), "embedder.node")) && existsSync(join(embedderDir(), "models", m.dir, m.file));
};

describe.each(Object.keys(MODELS))("the %s model embedder", (short) => {
  it.skipIf(!built(short))("embeds to unit vectors that rank by meaning", () => {
    const e = makeEmbedder(short);
    expect(e.name).toBe(MODELS[short]!.name);
    const v = e.embed("The release is scheduled for the first week of December.")!;
    expect(v).toHaveLength(e.dim);
    expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 4);
    expect(e.embed("…")).toBeNull();
    const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    const q = e.embed("When do we ship?")!;
    expect(cos(q, v)).toBeGreaterThan(cos(q, e.embed("We chose Postgres over MongoDB for the billing service.")!));
    // The recorded name finds the same embedder.
    expect(makeEmbedder(e.name).name).toBe(e.name);
  });

  it.skipIf(!built(short))("takes over a graph written with the hash embedder", async () => {
    const dataDir = tempDir();
    const release = await seed(await Graph.open({ dataDir, name: "upgrade" }));
    const g = await Graph.open({ dataDir, name: "upgrade", embedder: makeEmbedder(short) });
    expect((await g.info()).embedder).toBe(MODELS[short]!.name);
    expect(vectorLengths(g)).toEqual([384]);
    // Shares no content word with any claim, so the full-text half of the hybrid search stays out of it.
    const found = (await act(g, "search", { query: "When does it launch?" }, reader)) as Row[];
    expect(found[0]).toMatchObject({ id: release.id });
  });
});
