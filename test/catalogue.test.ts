// The catalogue: the contexts on this machine, searchable by name and
// description, built from their change logs without starting their hosts.

import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Catalogue, cardText, readCard } from "../src/core/catalogue.js";
import { Host } from "../src/host/host.js";
import { localContexts } from "../src/mcp/links.js";
import { memorySignaller } from "../src/p2p/signal.js";
import { tempDir } from "./helpers.js";

const signal = memorySignaller(new EventEmitter());
const hosts: Host[] = [];
afterAll(() => hosts.forEach((h) => h.stop()));

async function context(dataDir: string, name: string, description?: string): Promise<Host> {
  const h = await Host.start({ dataDir, graph: name, user: "ada", signal, ice: [], holdMs: 50 });
  hosts.push(h);
  if (description) await h.setDescription(description);
  return h;
}

const names = (dataDir: string) => localContexts(dataDir).map((c) => c.name);

describe("catalogue", () => {
  it("reads a context's card from its log", async () => {
    const dataDir = tempDir();
    await context(dataDir, "spring-launch", "Decisions about the spring product launch");
    const card = readCard(dataDir, "spring-launch");
    expect(card).toMatchObject({ name: "spring-launch", description: "Decisions about the spring product launch", members: 1 });
    expect(card.id).toMatch(/\S/);
    expect(card.last_change_at).toMatch(/^\d{4}-/);
    expect(cardText(card)).toBe("spring launch. Decisions about the spring product launch");
  });

  it("ranks contexts by name and description", async () => {
    const dataDir = tempDir();
    await context(dataDir, "spring-launch", "Decisions about the spring product launch: pricing, dates and the press list");
    await context(dataDir, "home-network", "The house network: router, Pi-hole DNS and the daily outage");
    await context(dataDir, "hackathon", "Our Neo4j hackathon entry and its submission checklist");
    const cat = await Catalogue.open(dataDir);
    expect(await cat.sync(names(dataDir))).toBe(3);

    expect((await cat.find("pi-hole dns outage"))[0]!.name).toBe("home-network");
    expect((await cat.find("product pricing"))[0]!.name).toBe("spring-launch");
    // A word only in the name finds it too.
    expect((await cat.find("hackathon"))[0]!.name).toBe("hackathon");
    const hit = (await cat.find("neo4j submission", 1))[0]!;
    expect(hit).toMatchObject({ name: "hackathon", members: 1 });
    expect(hit.score).toBeGreaterThan(0);
    expect(await cat.find("neo4j", 1)).toHaveLength(1);
    await expect(cat.find("  ...  ")).rejects.toThrow(/letter or digit/);
  });

  it("keeps in step: re-reads changed logs only, and drops deleted contexts", async () => {
    const dataDir = tempDir();
    const a = await context(dataDir, "alpha");
    await context(dataDir, "beta", "Garden planting notes");
    const cat = await Catalogue.open(dataDir);
    expect(await cat.sync(names(dataDir))).toBe(2);
    expect(await cat.sync(names(dataDir))).toBe(0);

    await a.setDescription("Kubernetes cluster upgrades and disk layout");
    expect(await cat.sync(names(dataDir))).toBe(1);
    expect((await cat.find("kubernetes disk"))[0]).toMatchObject({ name: "alpha", description: "Kubernetes cluster upgrades and disk layout" });

    a.stop();
    rmSync(join(dataDir, "graphs", "alpha"), { recursive: true, force: true });
    await cat.sync(names(dataDir));
    expect((await cat.find("kubernetes disk")).map((h) => h.name)).not.toContain("alpha");
  });
});
