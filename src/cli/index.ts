import { parseArgs } from "node:util";
import { packageInfo } from "../core/package-root.js";

const pkg = packageInfo();
const [command, ...rest] = process.argv.slice(2);

const USAGE = `p2pcg ${pkg.version}: a shared context graph of claims and questions, replicated peer to peer between people's AI agents

Usage: p2pcg <command> [options]

Commands:
  mcp [--graph NAME]                  Run the MCP server on stdio (starts the graph's host if needed)
  host [--graph NAME] [--share] [--idle SECONDS]
                                      Run a graph's host in the foreground (--share prints a new join code)
  host stop [--graph NAME]            Stop a graph's host
  up                                  Start the host of every graph on this machine that is sharing (in the background)
  autostart on|off                    Run \`p2pcg up\` at login (macOS), so your graphs sync after a reboot
  demo [--port N] [--no-open]         Open the views on an example graph (a copy; nothing of yours changes)
  ui [--graph NAME] [--port N] [--open]
                                      Show the console and explorer in a browser
  status [--graph NAME]               Show a graph's host: sharing, members, links, relays, invites
  whoami                              Show your name and key fingerprint
  doctor                              Check that this machine can run p2pcg
  --version                           Print the version

Environment:
  P2PCG_USER        Your name in graphs (default: the name you set with set_my_name, else git's user.name, else your login name)
  P2PCG_GRAPH       The graph to use (default: default)
  P2PCG_DATA_DIR    Where graphs live (default: ~/.local/share/p2p-context-graph)
  P2PCG_AUTO_SHARE  off: new graphs don't sync until you share them
  P2PCG_HOLD_MS     How long a write stays on this machine (Undo) before it is sent (default 10000)
  P2PCG_RELAYS      Nostr relays for signalling, comma-separated
  P2PCG_ICE         STUN/TURN servers, comma-separated (turn:user:pass@host:port)`;

const graphOpts = { graph: { type: "string" } } as const;
const graphName = (v?: string) => v ?? process.env.P2PCG_GRAPH ?? "default";

async function sessionFactory(values: { graph?: string }) {
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
      local: () => ensureHost({ dataDir, graph }),
      openLocal: (g) => ensureHost({ dataDir, graph: g }),
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
  process.env.P2PCG_AUTO_SHARE ??= "off"; // the example stays on this machine
  const { make, log } = await sessionFactory({ graph: "incident" });
  const { startUi } = await import("../ui/server.js");
  const server = await startUi({ session: () => make(false), port: values.port ? Number(values.port) : undefined, log });
  console.log(`p2p-context-graph demo: an example graph, copied to ${dataDir}
  incident   three people investigating a checkout slowdown

Open this on this machine (it acts as you; don't share it):
${server.url}

In the browser: Explore the graph (drag the time slider) and Conflicts.
To point an agent at the same data:
  P2PCG_DATA_DIR=${dataDir} p2pcg mcp --graph incident

Ctrl-C stops the demo.`);
  if (!values["no-open"]) {
    const { spawn } = await import("node:child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(cmd, [server.url], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  }
  const stop = async () => {
    await server.close();
    for (const g of ["incident"]) {
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
      user: defaultName(defaultDataDir()),
      idleSeconds: values.idle ? Number(values.idle) : 0,
      log,
      onStop: () => process.exit(0),
    });
    log(`host for graph '${h.graph.name}' on ${h.socket}`);
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
  await check("model", async () => {
    const { claimsPack } = await import("../core/pack.js");
    const p = claimsPack();
    return `${p.model.title}: ${p.tools.length} tools`;
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

/** Starts the host of every graph here that is sharing, so they sync without an agent open. */
async function up(): Promise<number> {
  const [{ existsSync, readdirSync, readFileSync }, { join }, { ensureHost }, { defaultDataDir }] = await Promise.all([
    import("node:fs"),
    import("node:path"),
    import("../host/client.js"),
    import("../core/graph.js"),
  ]);
  const { autoShare } = await import("../core/paths.js");
  const dataDir = defaultDataDir();
  const dir = join(dataDir, "graphs");
  const graphs = existsSync(dir) ? readdirSync(dir).filter((n) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(n)) : [];
  let started = 0;
  for (const g of graphs) {
    let on = autoShare();
    try {
      on = JSON.parse(readFileSync(join(dataDir, "hosts", g, "sharing.json"), "utf8")).on === true;
    } catch {
      // no setting: the default
    }
    if (!on) continue;
    try {
      // idle 0: a sharing host stays up anyway; this keeps it up for the members.
      const c = await ensureHost({ dataDir, graph: g, idleSeconds: 0 });
      c.close();
      started++;
      console.log(`up: ${g}`);
    } catch (e) {
      console.error(`${g}: ${(e as Error).message}`);
    }
  }
  console.log(`${started} graph host(s) running.`);
  return 0;
}

/** A macOS launch agent that runs `p2pcg up` at login. */
async function autostart(args: string[]): Promise<number> {
  const [sub] = args;
  const [{ existsSync, mkdirSync, unlinkSync, writeFileSync }, { homedir }, { join }] = await Promise.all([import("node:fs"), import("node:os"), import("node:path")]);
  const label = "dev.p2pcg.up";
  if (process.platform !== "darwin") {
    console.log("autostart is for macOS. Elsewhere, run `p2pcg up` from your login scripts (for example a systemd user service).");
    return sub === "on" || sub === "off" ? 1 : 2;
  }
  const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  if (sub === "off") {
    if (existsSync(plist)) unlinkSync(plist);
    console.log(`Removed ${plist}. Your graphs sync only while an agent (or \`p2pcg up\`) runs them.`);
    return 0;
  }
  if (sub !== "on") {
    console.error("Usage: p2pcg autostart on|off");
    return 2;
  }
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const args2 = [process.execPath, ...process.execArgv, process.argv[1]!, "up"];
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args2.map((a) => `<string>${esc(a)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>${process.env.P2PCG_DATA_DIR ? `<key>P2PCG_DATA_DIR</key><string>${esc(process.env.P2PCG_DATA_DIR)}</string>` : ""}</dict>
</dict></plist>
`,
  );
  console.log(`Wrote ${plist}: \`p2pcg up\` runs at each login. \`p2pcg autostart off\` removes it.`);
  return 0;
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
  case "up":
    process.exitCode = await up();
    break;
  case "autostart":
    process.exitCode = await autostart(rest);
    break;
  default:
    console.log(USAGE);
    if (command && command !== "help" && command !== "--help") process.exitCode = 2;
}
