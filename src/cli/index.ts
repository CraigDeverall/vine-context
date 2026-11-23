import { parseArgs } from "node:util";
import { packageInfo } from "../core/package-root.js";

const pkg = packageInfo();
const [command, ...rest] = process.argv.slice(2);

const USAGE = `vine ${pkg.version}: a shared context graph of claims and questions, replicated peer to peer between people's AI agents

Usage: vine <command> [options]

Commands:
  mcp [--context NAME]                Run the MCP server on stdio (a chat keeps the context it chose; a new chat starts with its folder's linked context, else NAME, else none until one is chosen)
  host [--context NAME] [--share] [--idle SECONDS]
                                      Run a context's host in the foreground (--share prints a new join code)
  host stop [--context NAME]          Stop a context's host
  up                                  Start the host of every context on this machine that is sharing (in the background)
  autostart on|off                    Run \`vine up\` at login (macOS), so your contexts sync after a reboot
  demo [--port N] [--no-open]         Open the views on an example context (a copy; nothing of yours changes)
  ui [--context NAME] [--port N] [--open]
                                      Show the console and explorer in a browser
  status [--context NAME]             Show a context's host: sharing, members, links, relays, invites
  turn set HOST[:PORT] --user NAME [--tcp | --tls] [--store file|keychain|env]
                                      Set a TURN server, for members whose networks block direct connections (asks for the password)
  turn show | test | clear            Show, check or remove the TURN server
  whoami                              Show your name and key fingerprint
  doctor                              Check that this machine can run vine
  --version                           Print the version

Environment:
  VINE_USER        Your name in contexts (default: the name you set with set_my_name, else git's user.name, else your login name)
  VINE_CONTEXT     The context a new chat starts with when its folder has none linked (default: none; the agent asks)
  VINE_CHAT        The chat's id, to remember its context (default: Claude Code's session id)
  VINE_DATA_DIR    Where contexts live (default: ~/.local/share/vine-context)
  VINE_EMBEDDER    How search turns text into vectors: hash (default), or bge-small or minilm once built with \`npm run build:embedder\`
  VINE_AUTO_SHARE  off: new contexts don't sync until you share them
  VINE_HOLD_MS     How long a write stays on this machine (Undo) before it is sent (default 10000)
  VINE_RELAYS      Nostr relays for signalling, comma-separated
  VINE_ICE         STUN/TURN servers, comma-separated; replaces the defaults and the \`vine turn\` setting
  VINE_TURN_PASSWORD  The TURN server's password, when it was set with --store env`;

const graphOpts = { graph: { type: "string" }, context: { type: "string" } } as const;
const graphName = (v?: string): string => {
  const name = v ?? process.env.VINE_CONTEXT ?? process.env.VINE_GRAPH;
  if (name) return name;
  console.error("Name a context with --context NAME (there's no default context).");
  process.exit(2);
};

async function sessionFactory(values: { graph?: string; context?: string }) {
  const [{ Session }, { chatIdFromEnv }, { ensureHost }, { defaultDataDir }, { loadIdentity, defaultName }, signal] = await Promise.all([
    import("../mcp/server.js"),
    import("../mcp/links.js"),
    import("../host/client.js"),
    import("../core/graph.js"),
    import("../core/identity.js"),
    import("../p2p/signal.js"),
  ]);
  const { storedIce } = await import("../p2p/ice.js");
  const dataDir = defaultDataDir();
  // A chat keeps the context it chose (by its id); a new one starts with its folder's linked context, or one named here; there's no default.
  const graph = values.context ?? values.graph ?? process.env.VINE_CONTEXT ?? process.env.VINE_GRAPH;
  const log = (m: string) => console.error(`vine: ${m}`);
  let ui: Promise<{ url: string }> | undefined;
  const make = (withBrowserView: boolean): InstanceType<typeof Session> =>
    new Session({
      local: graph ? () => ensureHost({ dataDir, graph }) : undefined,
      cwd: process.cwd(),
      chat: chatIdFromEnv(),
      openLocal: (g) => ensureHost({ dataDir, graph: g }),
      dataDir,
      identity: () => loadIdentity(dataDir, defaultName(dataDir)),
      signal: signal.nostrSignaller,
      ice: storedIce(dataDir),
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
  log(`session ready on stdio${graph ? ` (context '${graph}')` : ""}`);
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
  const dataDir = mkdtempSync(join(tmpdir(), "vine-demo-"));
  cpSync(examples, dataDir, { recursive: true });
  process.env.VINE_DATA_DIR = dataDir;
  process.env.VINE_USER ??= "alice";
  process.env.VINE_AUTO_SHARE ??= "off"; // the example stays on this machine
  const { make, log } = await sessionFactory({ graph: "incident" });
  const { startUi } = await import("../ui/server.js");
  const server = await startUi({ session: () => make(false), port: values.port ? Number(values.port) : undefined, log });
  console.log(`vine-context demo: an example graph, copied to ${dataDir}
  incident   three people investigating a checkout slowdown

Open this on this machine (it acts as you; don't share it):
${server.url}

In the browser: Explore the graph (drag the time slider) and Conflicts.
To point an agent at the same data:
  VINE_DATA_DIR=${dataDir} vine mcp --graph incident

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
    const { values } = parseArgs({ args: args.slice(1), options: graphOpts });
    const [{ LocalHost }, { socketPath }, { defaultDataDir }] = await Promise.all([
      import("../host/client.js"),
      import("../host/state.js"),
      import("../core/graph.js"),
    ]);
    try {
      const c = await LocalHost.connect(socketPath(defaultDataDir(), graphName(values.context ?? values.graph)));
      await c.request("shutdown");
      c.close();
      console.log("Host stopped.");
      return 0;
    } catch {
      console.log("No host is running for that context.");
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
      graph: graphName(values.context ?? values.graph),
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
  const { values } = parseArgs({ args, options: graphOpts });
  const [{ LocalHost }, { socketPath }, { defaultDataDir }] = await Promise.all([
    import("../host/client.js"),
    import("../host/state.js"),
    import("../core/graph.js"),
  ]);
  try {
    const c = await LocalHost.connect(socketPath(defaultDataDir(), graphName(values.context ?? values.graph)));
    console.log(JSON.stringify(await c.request("status"), null, 2));
    c.close();
    return 0;
  } catch {
    console.log("No host is running for that context.");
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

/** Reads a password: typed unseen at a terminal, or the first line of piped input. */
async function readPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let all = "";
    for await (const chunk of stdin) all += chunk;
    return all.split(/\r?\n/)[0] ?? "";
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let typed = "";
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      fn();
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(typed));
        if (ch === "\u0003") return done(() => reject(new Error("Cancelled.")));
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const TURN_USAGE = `Usage:
  vine turn set HOST[:PORT] --user NAME [--tcp | --tls] [--store file|keychain|env]
  vine turn show
  vine turn test
  vine turn clear`;

/** The TURN server this machine's links may go through when a direct connection isn't possible. */
async function turn(args: string[]): Promise<number> {
  const [ice, { SECRET_STORES }, { defaultDataDir }] = await Promise.all([import("../p2p/ice.js"), import("../core/secret.js"), import("../core/graph.js")]);
  const dataDir = defaultDataDir();
  const report = async (): Promise<number> => {
    const r = await ice.checkStoredTurn(dataDir);
    console.log(r.ok ? `ok    The server answered and lent a relay address (${r.relay}).` : `FAIL  ${r.error}`);
    return r.ok ? 0 : 1;
  };
  switch (args[0]) {
    case "set": {
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        allowPositionals: true,
        options: { user: { type: "string" }, tcp: { type: "boolean" }, tls: { type: "boolean" }, store: { type: "string" } },
      });
      const store = (values.store ?? "file") as (typeof SECRET_STORES)[number];
      if (positionals.length !== 1 || !values.user || (values.tcp && values.tls) || !SECRET_STORES.includes(store)) {
        console.error(TURN_USAGE);
        return 2;
      }
      try {
        const { host, port } = ice.parseHostPort(positionals[0]!);
        const password = store === "env" ? undefined : await readPassword(`Password for ${values.user} on ${host}: `);
        const t = ice.saveTurn(dataDir, { host, port, username: values.user, transport: values.tls ? "tls" : values.tcp ? "tcp" : "udp", store, password });
        const kept = { file: "in a file only you can read", keychain: "in your keychain", env: `nowhere: set ${ice.TURN_PASSWORD_ENV} where vine runs` }[t.store];
        console.log(`TURN server set: ${t.host}:${t.port} (${t.transport}), user ${t.username}. Password kept ${kept}.`);
        console.log("New connections use it from now on; nothing needs restarting.");
      } catch (e) {
        console.error((e as Error).message);
        return 1;
      }
      return report();
    }
    case "show": {
      const s = ice.resolveIce(dataDir).summary;
      const t = ice.readTurn(dataDir);
      if (s.source === "env") console.log(`VINE_ICE is set, and replaces the setting here: ${[...s.stun, ...(s.turn ? [s.turn] : [])].join(", ") || "no servers"}`);
      else if (!t) console.log("No TURN server is set. Members connect directly. Set one with `vine turn set` if a member can't connect.");
      else console.log(`TURN server: ${s.turn}, user ${t.username}, password store: ${t.store}${s.problem ? `\nNot in use: ${s.problem}.` : ""}`);
      return 0;
    }
    case "test":
      return report();
    case "clear":
      console.log(ice.clearTurn(dataDir) ? "TURN server removed. New connections are direct only." : "No TURN server was set.");
      return 0;
    default:
      console.log(TURN_USAGE);
      return args[0] ? 2 : 0;
  }
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
    if (major < 20) throw new Error(`Node ${process.versions.node}; vine needs Node 20 or later`);
    return `${process.versions.node} on ${process.platform}-${process.arch}`;
  });
  await check("vine-context", () => pkg.version);
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
  await check("search embedder", async () => {
    const { makeEmbedder } = await import("../core/embed.js");
    const e = makeEmbedder();
    const v = e.embed("hello graph");
    if (v?.length !== e.dim) throw new Error(`${e.name} returned ${v?.length ?? "no"} numbers, not ${e.dim}`);
    return e.name === "hash-256" ? `${e.name} (built in; matches words, not meaning)` : `${e.name} (${e.dim} dimensions, matches meaning)`;
  });
  await check("data directory", async () => {
    const { defaultDataDir } = await import("../core/graph.js");
    const { mkdirSync, accessSync, constants } = await import("node:fs");
    const dir = defaultDataDir();
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return dir;
  });
  await check("turn server", async () => {
    const { defaultDataDir } = await import("../core/graph.js");
    const ice = await import("../p2p/ice.js");
    const s = ice.resolveIce(defaultDataDir()).summary;
    if (s.source === "env") return `VINE_ICE is set (${s.turn ?? "no TURN server"})`;
    if (!s.turn) return "none set: members connect directly (`vine turn set` adds one)";
    const r = await ice.checkStoredTurn(defaultDataDir());
    if (!r.ok) throw new Error(`${s.turn}: ${r.error}`);
    return `${s.turn} answered`;
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

/** A macOS launch agent that runs `vine up` at login. */
async function autostart(args: string[]): Promise<number> {
  const [sub] = args;
  const [{ existsSync, mkdirSync, unlinkSync, writeFileSync }, { homedir }, { join }] = await Promise.all([import("node:fs"), import("node:os"), import("node:path")]);
  const label = "dev.vine.up";
  if (process.platform !== "darwin") {
    console.log("autostart is for macOS. Elsewhere, run `vine up` from your login scripts (for example a systemd user service).");
    return sub === "on" || sub === "off" ? 1 : 2;
  }
  const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  if (sub === "off") {
    if (existsSync(plist)) unlinkSync(plist);
    console.log(`Removed ${plist}. Your graphs sync only while an agent (or \`vine up\`) runs them.`);
    return 0;
  }
  if (sub !== "on") {
    console.error("Usage: vine autostart on|off");
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
  <key>EnvironmentVariables</key><dict>${process.env.VINE_DATA_DIR ? `<key>VINE_DATA_DIR</key><string>${esc(process.env.VINE_DATA_DIR)}</string>` : ""}</dict>
</dict></plist>
`,
  );
  console.log(`Wrote ${plist}: \`vine up\` runs at each login. \`vine autostart off\` removes it.`);
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
  case "turn":
    process.exitCode = await turn(rest);
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
