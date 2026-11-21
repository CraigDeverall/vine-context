import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { packageInfo } from "../core/package-root.js";

const pkg = packageInfo();
const [command, ...rest] = process.argv.slice(2);

const USAGE = `p2pcg ${pkg.version}: share a Relate context graph with other people's AI agents

Usage: p2pcg <command> [options]

Commands:
  mcp [--graph NAME] [--model PACK]   Run the MCP server on stdio
  doctor                              Check that this machine can run p2pcg
  model list                          List the built-in model packs
  model validate <dir>                Check a model pack, and try it on a scratch graph
  --version                           Print the version

Environment:
  P2PCG_USER        Your name in the graph (default: your login name)
  P2PCG_GRAPH       The graph to open (default: default)
  P2PCG_MODEL       The model pack for a new graph (default: temporal-claims)
  P2PCG_DATA_DIR    Where graphs are stored (default: ~/.local/share/p2p-context-graph)`;

function me(): string {
  return process.env.P2PCG_USER ?? userInfo().username;
}

async function mcp(args: string[]) {
  const { values } = parseArgs({ args, options: { graph: { type: "string" }, model: { type: "string" } } });
  const [{ Graph }, { createMcpServer }, { StdioServerTransport }] = await Promise.all([
    import("../core/graph.js"),
    import("../mcp/server.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
  ]);
  const graph = await Graph.open({ name: values.graph, model: values.model });
  // Single player: the person running the server owns the graph.
  const server = createMcpServer(graph, { id: me(), role: "admin" });
  await server.connect(new StdioServerTransport());
  console.error(`p2pcg: graph '${graph.name}' (${graph.model.name}) ready on stdio as ${me()}`);
}

async function doctor(): Promise<number> {
  let failed = 0;
  const check = async (name: string, fn: () => Promise<string> | string) => {
    try {
      console.log(`ok    ${name}: ${await fn()}`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name}: ${(e as Error).message}`);
    }
  };
  await check("node", () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 20) throw new Error(`Node ${process.versions.node}; p2pcg needs Node 20 or later`);
    return `${process.versions.node} on ${process.platform}-${process.arch}`;
  });
  await check("p2p-context-graph", () => pkg.version);
  await check("relate", async () => {
    const { loadRelate } = await import("../core/relate.js");
    const R = await loadRelate();
    const conn = R.Database.open(":memory:").connect();
    conn.query("CREATE FULLTEXT INDEX t IF NOT EXISTS FOR (n:T) ON EACH [n.text]");
    conn.query(
      "CREATE VECTOR INDEX v IF NOT EXISTS FOR (n:T) ON (n.e) OPTIONS {indexConfig: {`vector.dimensions`: 2, `vector.similarity_function`: 'cosine'}}",
    );
    conn.query("CREATE (:T {text: 'hello graph', e: [1.0, 0.0]})");
    const r = conn.query(
      "MATCH (n:T) SEARCH n IN (COMBINE (VECTOR INDEX v FOR [1.0, 0.0] LIMIT 5 WEIGHT 1, " +
        "FULLTEXT INDEX t FOR 'hello' LIMIT 5 WEIGHT 1) USING WRRF WITH CONSTANT 60 LIMIT 5) SCORE AS s RETURN count(n) AS n",
    );
    if (Number(r.rows[0]?.n) !== 1) throw new Error("hybrid search returned nothing");
    return "embedded store, vector + full-text + COMBINE hybrid search";
  });
  await check("node-datachannel", async () => {
    const ndc = (await import("node-datachannel")).default;
    const pc = new ndc.PeerConnection("doctor", { iceServers: [] });
    pc.createDataChannel("probe");
    pc.close();
    return "WebRTC data channels available";
  });
  await check("model packs", async () => {
    const { listBuiltinPacks, resolvePack } = await import("../core/pack.js");
    const names = listBuiltinPacks();
    if (!names.length) throw new Error("no built-in packs found");
    for (const n of names) resolvePack(n);
    return names.join(", ");
  });
  await check("data directory", async () => {
    const { defaultDataDir } = await import("../core/graph.js");
    const { mkdirSync, accessSync, constants } = await import("node:fs");
    const dir = defaultDataDir();
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return dir;
  });
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
  return failed ? 1 : 0;
}

async function model(args: string[]): Promise<number> {
  const [sub, dir] = args;
  const { listBuiltinPacks, loadPack, resolvePack, PackError } = await import("../core/pack.js");
  if (sub === "list") {
    for (const name of listBuiltinPacks()) {
      const p = resolvePack(name);
      console.log(`${name}  ${p.model.title}: ${p.tools.length} tools`);
    }
    return 0;
  }
  if (sub === "validate" && dir) {
    try {
      const pack = loadPack(dir);
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { Graph } = await import("../core/graph.js");
      const scratch = mkdtempSync(join(tmpdir(), "p2pcg-validate-"));
      try {
        // Opening a scratch graph applies the model's constraints, indexes and migrations.
        const g = await Graph.open({ name: "validate", dataDir: scratch, model: pack.dir });
        console.log(`ok  ${pack.model.name} v${pack.model.version}: ${Object.keys(pack.model.nodes).length} node types, ${pack.tools.length} tools, schema applied`);
        console.log(`    tools: ${g.tools.map((t) => `${t.name} (${t.kind})`).join(", ")}`);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      return 0;
    } catch (e) {
      console.error(e instanceof PackError ? e.message : `error: ${(e as Error).message}`);
      return 1;
    }
  }
  console.error("Usage: p2pcg model list | p2pcg model validate <dir>");
  return 2;
}

switch (command) {
  case "--version":
  case "-v":
    console.log(pkg.version);
    break;
  case "mcp":
    await mcp(rest);
    break;
  case "doctor":
    process.exitCode = await doctor();
    break;
  case "model":
    process.exitCode = await model(rest);
    break;
  default:
    console.log(USAGE);
    if (command && command !== "help" && command !== "--help") process.exitCode = 2;
}
