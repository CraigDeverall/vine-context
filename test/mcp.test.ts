// End to end: a real MCP client talks to `p2pcg mcp` over stdio.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalHost } from "../src/host/client.js";
import { socketPath } from "../src/host/state.js";
import { tempDir } from "./helpers.js";

let client: Client;
const dataDir = tempDir();

beforeAll(async () => {
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/cli/index.ts", "mcp", "--graph", "e2e"],
      env: { ...process.env, P2PCG_DATA_DIR: dataDir, P2PCG_USER: "e2e-user" } as Record<string, string>,
      stderr: "ignore",
    }),
  );
});

afterAll(async () => {
  await client?.close();
  // The session started a background host for the graph: stop it.
  const host = await LocalHost.connect(socketPath(dataDir, "e2e"));
  await host.request("shutdown");
  host.close();
});

const textOf = (r: any) => (r.content as { type: string; text: string }[])[0]!.text;

describe("p2pcg mcp", () => {
  it("lists the model's tools and the built-in ones, with schemas and hints", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["add_claim", "search", "beliefs", "context_info", "model_guide", "share_context", "revoke_invite", "join_context", "remove_peer"]),
    );
    const add = tools.find((t) => t.name === "add_claim")!;
    expect(add.inputSchema.required).toEqual(["text"]);
    expect(add.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === "search")!.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toMatch(/model_guide/);
  });

  it("offers a join prompt that passes the code to join_context", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("join");
    const r = await client.getPrompt({ name: "join", arguments: { code: "p2pcg1_abc.def" } });
    expect((r.messages[0]!.content as { text: string }).text).toMatch(/join_context with the code exactly as given[\s\S]*fingerprint/);
    expect(((r.messages[0]!.content as { text: string }).text)).toContain("p2pcg1_abc.def");
  });

  it("records and finds a claim as the server's user", async () => {
    const added = JSON.parse(textOf(await client.callTool({ name: "add_claim", arguments: { text: "MCP clients can record claims" } })));
    expect(added.id).toMatch(/^c_/);
    const found = JSON.parse(textOf(await client.callTool({ name: "search", arguments: { query: "record claims" } })));
    expect(found[0]).toMatchObject({ id: added.id, recorded_by: "e2e-user" });
  });

  it("returns tool errors as isError results the agent can read", async () => {
    const r = await client.callTool({ name: "link", arguments: { from: "c_none", relation: "SUPPORTS", to: "c_none2" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/No current claim c_none/);
  });

  it("serves the model guide and graph info", async () => {
    expect(textOf(await client.callTool({ name: "model_guide", arguments: {} }))).toMatch(/# Model: Claims and Questions[\s\S]*Before you add/);
    const info = JSON.parse(textOf(await client.callTool({ name: "context_info", arguments: {} })));
    expect(info).toMatchObject({ graph: "e2e", model: { name: "temporal-claims" }, embedder: "hash-256", created_by: "e2e-user", you: { role: "admin", name: "e2e-user" } });
    expect(info.nodes.Claim).toBeGreaterThanOrEqual(1);
  });
});
