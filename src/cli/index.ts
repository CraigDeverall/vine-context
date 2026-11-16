import { parseArgs } from "node:util";
import { packageInfo } from "../core/package-root.js";

const pkg = packageInfo();
const [command, ...rest] = process.argv.slice(2);

const USAGE = `p2pcg ${pkg.version}: share a Relate context graph with other people's AI agents

Usage: p2pcg <command> [options]

Commands:
  mcp [--graph NAME] [--model PACK]   Run the MCP server on stdio (starts the graph's host if needed)
  host [--graph NAME] [--model PACK] [--share] [--idle SECONDS]
                                      Run a graph's host in the foreground
  host stop [--graph NAME]            Stop a graph's host
  demo [--port N] [--no-open]         Open the views on two example graphs (a copy; nothing of yours changes)
  ui [--graph NAME] [--port N] [--open]
                                      Show the console, explorer and model studio in a browser
  status [--graph NAME]               Show a graph's host: sharing, invites, peers
  whoami                              Show your name and key fingerprint
  doctor                              Check that this machine can run p2pcg
  model list                          List the model packs you can use
  model validate <dir>                Check a model pack, and try it on a scratch graph
  --version                           Print the version

Environment:
  P2PCG_USER        Your name in graphs (default: the name you set with set_my_name, else git's user.name, else your login name)
  P2PCG_GRAPH       The graph to use (default: default)
  P2PCG_MODEL       The model pack for a new graph (default: temporal-claims)
  P2PCG_DATA_DIR    Where graphs live (default: ~/.local/share/p2p-context-graph)
  P2PCG_RELAYS      Nostr relays for signalling, comma-separated
  P2PCG_ICE         STUN/TURN servers, comma-separated (turn:user:pass@host:port)`;

const graphOpts = { graph: { type: "string" }, model: { type: "string" } } as const;
const graphName = (v?: string) => v ?? process.env.P2PCG_GRAPH ?? "default";

async function sessionFactory(values: { graph?: string; model?: string }) {
  const [{ Session }, { ensureHost }, { defaultDataDir }, { loadIdentity, defaultName }, signal] = await Promise.all([
    import("../mcp/server.js"),
    import("../host/client.js"),
    import("../core/graph.js"),
    import("../core/identity.js"),
    import("../p2p/signal.js"),
  ]);
  const dataDir = defaultDataDir();
  const graph = graphName(values.graph);
  const log = (m: string) => console.error(`p2pcg: ${m}`);
  let ui: Promise<{ url: string }> | undefined;
  const make = (withBrowserView: boolean): InstanceType<typeof Session> =>
    new Session({
      local: () => ensureHost({ dataDir, graph, model: values.model ?? process.env.P2PCG_MODEL }),
      openLocal: (g, model) => ensureHost({ dataDir, graph: g, model }),
      dataDir,
      identity: () => loadIdentity(dataDir, defaultName(dataDir)),
      signal: signal.nostrSignaller,
      ice: signal.iceServers(),
      log,
      browserView: withBrowserView
        ? async () => {
            ui ??= import("../ui/server.js").then(({ startUi }) => startUi({ session: () => make(false), log }));
            return (await ui).url;
          }
        : undefined,
    });
  return { make, graph, log };
}

async function mcp(args: string[]) {
  const { values } = parseArgs({ args, options: graphOpts });
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { make, graph, log } = await sessionFactory(values);
  const session = make(true);
  await session.start();
  await session.server.connect(new StdioServerTransport());
  log(`session on graph '${graph}' ready on stdio`);
}

async function demo(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { port: { type: "string" }, "no-open": { type: "boolean" } } });
  const [{ cpSync, existsSync, mkdtempSync }, { tmpdir }, { join }, { packageRoot }] = await Promise.all([
    import("node:fs"),
    import("node:os"),
    import("node:path"),
    import("../core/package-root.js"),
  ]);
  const examples = join(packageRoot(), "examples", "data");
  if (!existsSync(join(examples, "graphs"))) {
    console.error(`The example graphs aren't in this install (${examples}).`);
    return 1;
  }
  // A copy, so the demo never changes the examples that ship with the package.
  const dataDir = mkdtempSync(join(tmpdir(), "p2pcg-demo-"));
  cpSync(examples, dataDir, { recursive: true });
  process.env.P2PCG_DATA_DIR = dataDir;
  process.env.P2PCG_USER ??= "alice";
  const { make, log } = await sessionFactory({ graph: "incident" });
  const { startUi } = await import("../ui/server.js");
  const server = await startUi({ session: () => make(false), port: values.port ? Number(values.port) : undefined, log });
  console.log(`p2p-context-graph demo: two example graphs, copied to ${dataDir}
  incident   (temporal-claims) three people investigating a checkout slowdown
  decisions  (decision-log)    what they decided to do about it

Open this on this machine (it acts as you; don't share it):
${server.url}

In the browser: Explore the graph (drag the time slider), Conflicts, and
Model studio > Packs and graphs to switch to 'decisions' (then "Decisions that
need review"). To point an agent at the same data:
  P2PCG_DATA_DIR=${dataDir} p2pcg mcp --graph incident

Ctrl-C stops the demo.`);
  if (!values["no-open"]) {
    const { spawn } = await import("node:child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(cmd, [server.url], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  }
  const stop = async () => {
    await server.close();
    for (const g of ["incident", "decisions"]) {
      try {
        const { LocalHost } = await import("../host/client.js");
        const { socketPath } = await import("../host/state.js");
        const c = await LocalHost.connect(socketPath(dataDir, g));
        await c.request("shutdown");
        c.close();
      } catch {
        // not running
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  return -1;
}

async function ui(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { ...graphOpts, port: { type: "string" }, open: { type: "boolean" } } });
  const { make, log } = await sessionFactory(values);
  const { startUi } = await import("../ui/server.js");
  const server = await startUi({ session: () => make(false), port: values.port ? Number(values.port) : undefined, log });
  console.log(`Open this on this machine (it acts as you; don't share it):\n${server.url}`);
  if (values.open) {
    const { spawn } = await import("node:child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(cmd, [server.url], { stdio: "ignore", detached: true }).unref();
  }
  const stop = () => void server.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return -1;
}

async function host(args: string[]): Promise<number> {
  if (args[0] === "stop") {
    const { values } = parseArgs({ args: args.slice(1), options: { graph: { type: "string" } } });
    const [{ LocalHost }, { socketPath }, { defaultDataDir }] = await Promise.all([
      import("../host/client.js"),
      import("../host/state.js"),
      import("../core/graph.js"),
    ]);
    try {
      const c = await LocalHost.connect(socketPath(defaultDataDir(), graphName(values.graph)));
      await c.request("shutdown");
      c.close();
      console.log("Host stopped.");
      return 0;
    } catch {
      console.log("No host is running for that graph.");
      return 1;
    }
  }
  const { values } = parseArgs({ args, options: { ...graphOpts, share: { type: "boolean" }, idle: { type: "string" } } });
  const [{ Host, HostRunningError }, { defaultDataDir }, { defaultName }] = await Promise.all([
    import("../host/host.js"),
    import("../core/graph.js"),
    import("../core/identity.js"),
  ]);
  const log = (m: string) => console.error(`[${new Date().toISOString()}] ${m}`);
  try {
    const h = await Host.start({
      dataDir: defaultDataDir(),
      graph: graphName(values.graph),
      model: values.model ?? process.env.P2PCG_MODEL,
      user: defaultName(defaultDataDir()),
      idleSeconds: values.idle ? Number(values.idle) : 0,
      log,
      onStop: () => process.exit(0),
    });
    log(`host for graph '${h.graph.name}' (${h.graph.model.name}) on ${h.socket}`);
    if (values.share) console.log(h.share().code);
    const stop = () => h.stop();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return -1; // keep running
  } catch (e) {
    if (e instanceof HostRunningError) {
      console.error(e.message);
      return 3;
    }
    throw e;
  }
}

async function status(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { graph: { type: "string" } } });
  const [{ LocalHost }, { socketPath }, { defaultDataDir }] = await Promise.all([
    import("../host/client.js"),
    import("../host/state.js"),
    import("../core/graph.js"),
  ]);
  try {
    const c = await LocalHost.connect(socketPath(defaultDataDir(), graphName(values.graph)));
    console.log(JSON.stringify(await c.request("status"), null, 2));
    c.close();
    return 0;
  } catch {
    console.log("No host is running for that graph.");
    return 1;
  }
}

async function whoami(): Promise<number> {
  const [{ loadIdentity, defaultName, fingerprint }, { defaultDataDir }] = await Promise.all([
    import("../core/identity.js"),
    import("../core/graph.js"),
  ]);
  const id = loadIdentity(defaultDataDir(), defaultName(defaultDataDir()));
  console.log(`${id.name}  ${fingerprint(id.publicKey)}`);
  return 0;
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
  const { listPacks, resolvePack } = await import("../core/pack.js");
  if (sub === "list") {
    for (const entry of listPacks()) {
      const p = resolvePack(entry.dir);
      console.log(`${entry.name}  ${p.model.title}: ${p.tools.length} tools (${entry.source})`);
    }
    return 0;
  }
  if (sub === "validate" && dir) {
    const { validatePack, formatReport } = await import("../core/validate.js");
    const report = await validatePack(dir);
    console.log(formatReport(report));
    return report.ok ? 0 : 1;
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
  case "host": {
    const code = await host(rest);
    if (code >= 0) process.exitCode = code;
    break;
  }
  case "demo": {
    const code = await demo(rest);
    if (code >= 0) process.exitCode = code;
    break;
  }
  case "ui": {
    const code = await ui(rest);
    if (code >= 0) process.exitCode = code;
    break;
  }
  case "status":
    process.exitCode = await status(rest);
    break;
  case "whoami":
    process.exitCode = await whoami();
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
