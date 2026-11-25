import { parseArgs } from "node:util";
import { packageInfo } from "../core/package-root.js";

const pkg = packageInfo();
const [command, ...rest] = process.argv.slice(2);

const USAGE = `vine ${pkg.version}: a shared context graph of claims and questions, replicated peer to peer between people's AI agents

Usage: vine <command> [options]

Commands:
  setup [--yes] [--agent claude|codex|none] [--turn cloudflare|custom|none] [--json] [--dry-run]
                                      Set this machine up, or repair it: vine, your agents' plugin, your name, checks, TURN, autostart
  mcp [--context NAME]                Run the MCP server on stdio (a chat keeps the context it chose; a new chat starts with its folder's linked context, else NAME, else none until one is chosen)
  host [--context NAME] [--share] [--idle SECONDS]
                                      Run a context's host in the foreground (--share prints a new join code)
  host stop [--context NAME]          Stop a context's host
  up                                  Start the host of every context on this machine that is sharing (in the background)
  autostart on|off                    Run \`vine up\` at login (macOS), so your contexts sync after a reboot
  demo [--pace SECONDS] [--join] [--port N] [--no-open] [--verbose]
                                      Three members in one process replay the example, syncing peer to peer (nothing of yours changes; --join lets your agent join)
  ui [--context NAME] [--port N] [--open]
                                      Show the console and explorer in a browser
  status [--context NAME]             Show a context's host: sharing, members, links, relays, invites
  turn set --provider cloudflare [--key-id ID | --account ID]
                                      Use Cloudflare's TURN server, with a TURN key on your own Cloudflare account (kept in your keychain)
  turn set HOST[:PORT] --user NAME [--tcp | --tls] [--store file|keychain|env]
                                      Set a TURN server of your own, for members whose networks block direct connections (asks for the password)
  turn show | test | clear            Show, check or remove the TURN server
  whoami                              Show your name and key fingerprint
  hook session-start|prompt           What an agent's hook runs: reads the hook's JSON on stdin, prints the chat's context and other members' news for the model
  doctor                              Check that this machine can run vine
  --version                           Print the version

Environment:
  VINE_USER        Your name in contexts (default: the name you set with set_my_name, else git's user.name, else your computer account's full name, else your login name, else a made-up one)
  VINE_CONTEXT     The context a new chat starts with when its folder has none linked (default: none; the agent asks)
  VINE_CHAT        The chat's id, to remember its context (default: Claude Code's session id)
  VINE_DATA_DIR    Where contexts live (default: ~/.local/share/vine-context)
  VINE_EMBEDDER    How search turns text into vectors: auto (default: bge-small when its package works here, else hash), hash, bge-small, or minilm once built with \`npm run build:embedder\`
  VINE_AUTO_SHARE  off: new contexts don't sync until you share them
  VINE_HOOKS       off: the agent hooks say nothing; quiet: no reminder beside each prompt (the session's briefing and others' news stay)
  VINE_HOLD_MS     How long a write stays on this machine (Undo) before it is sent (default 10000)
  VINE_RELAYS      Nostr relays for signalling, comma-separated
  VINE_ICE         STUN/TURN servers, comma-separated; replaces the defaults and the \`vine turn\` setting
  VINE_TURN_PASSWORD  The TURN server's password, when it was set with --store env
  VINE_CLOUDFLARE_TURN_SECRET  The Cloudflare TURN key's secret, when it was set with --store env`;

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
  const { values } = parseArgs({
    args,
    options: { port: { type: "string" }, "no-open": { type: "boolean" }, pace: { type: "string" }, join: { type: "boolean" }, verbose: { type: "boolean" } },
  });
  const [{ startDemo }, { GRAPH_NAME }, { nostrSignaller }, { storedIce }, { defaultDataDir }] = await Promise.all([import("../demo/live.js"), import("../demo/scenario.js"), import("../p2p/signal.js"), import("../p2p/ice.js"), import("../core/graph.js")]);
  const pace = values.pace === undefined ? 4 : Number(values.pace);
  if (!Number.isFinite(pace) || pace < 0) {
    console.error("--pace is seconds between steps, 0 or more.");
    return 2;
  }
  console.log(`vine-context demo: three people, three hosts, one process
  alice, bob and carol plan the office Christmas party, each from their own copy of the context 'party'.
  Every write goes through its author's host: signed, held for undo, then carried to the other two over WebRTC.
  ${values.join ? "They find each other through the public Nostr relays, so your agent can join too." : "They find each other in this process: no network is needed, and nothing leaves this machine."}
`);
  const demo = await startDemo({
    paceMs: pace * 1000,
    narrate: (line) => console.log(line),
    log: values.verbose ? (m) => console.error(`  [${m}]`) : undefined,
    // With --join the members use the relays and this machine's STUN/TURN setting, as any host does.
    ...(values.join ? { signal: nostrSignaller, ice: storedIce(defaultDataDir()) } : {}),
  });
  const alice = demo.members.alice;

  // The browser shows alice's point of view: her console, explorer and conflicts.
  process.env.VINE_DATA_DIR = alice.dataDir;
  process.env.VINE_USER = "alice";
  const { make, log } = await sessionFactory({ graph: GRAPH_NAME });
  const { startUi } = await import("../ui/server.js");
  const server = await startUi({ session: () => make(false), port: values.port ? Number(values.port) : undefined, log });
  console.log(`
Open this on this machine (it acts as alice; don't share it):
${server.url}

Sharing console: the three members and their live links. Explore a context: the graph as it grows; drag the time slider back to replay it. Conflicts: bob and carol, until bob gives way.
`);
  if (!values["no-open"]) {
    const { spawn } = await import("node:child_process");
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(cmd, [server.url], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
    await demo.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  try {
    await demo.story;
  } catch (e) {
    console.error(`The story stopped: ${(e as Error).message}`);
    await stop();
    return 1;
  }
  console.log(`
The story is over, and the three hosts stay up. To point an agent at alice's copy:
  VINE_DATA_DIR=${alice.dataDir} vine mcp --context ${GRAPH_NAME}`);
  if (values.join) {
    const { code } = await alice.local.request<{ code: string }>("share", { label: "demo guest", role: "contributor" });
    console.log(`
To join as a fourth member from any machine, tell your agent:
  /vine-context:join ${code}`);
  }
  console.log("\nCtrl-C stops the demo.");
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
    const st = await c.request<Record<string, any>>("status");
    console.log(JSON.stringify(st, null, 2));
    // The one thing in there a person should act on, in words (on stderr: stdout stays JSON).
    if (typeof st.advice === "string") console.error(`\n${st.advice}`);
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
  const { readHidden } = await import("./prompt.js");
  return readHidden(prompt);
}

const TURN_USAGE = `Usage:
  vine turn set --provider cloudflare [--key-id ID | --account ID] [--store keychain|env]
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
        options: {
          user: { type: "string" },
          tcp: { type: "boolean" },
          tls: { type: "boolean" },
          store: { type: "string" },
          provider: { type: "string" },
          "key-id": { type: "string" },
          account: { type: "string" },
        },
      });
      if (values.provider !== undefined && values.provider !== "custom") {
        if (values.provider !== "cloudflare" || positionals.length || values.user || values.tcp || values.tls || (values.store && !["keychain", "env"].includes(values.store))) {
          console.error(TURN_USAGE);
          return 2;
        }
        const [{ setupCloudflare }, { terminalPrompter }] = await Promise.all([import("./cloudflare-setup.js"), import("./prompt.js")]);
        const r = await setupCloudflare({
          dataDir,
          prompt: terminalPrompter(),
          say: (l) => console.log(l),
          keyId: values["key-id"],
          accountId: values.account,
          ...(values.account ? { via: "token" as const } : values["key-id"] ? { via: "key" as const } : {}),
          store: values.store as "keychain" | "env" | undefined,
        });
        if (!r.ok) {
          console.log(`FAIL  ${r.error}`);
          return 1;
        }
        console.log(`ok    Cloudflare lent a relay address (${r.relay}). New connections use it when a direct one isn't possible; nothing needs restarting.`);
        return 0;
      }
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
      await ice.refreshIce(dataDir);
      const s = ice.resolveIce(dataDir).summary;
      const t = ice.readTurn(dataDir);
      const cf = ice.readCloudflare(dataDir);
      if (s.source === "env") console.log(`VINE_ICE is set, and replaces the setting here: ${[...s.stun, ...(s.turn ? [s.turn] : [])].join(", ") || "no servers"}`);
      else if (cf)
        console.log(
          `TURN server: ${s.turn}. Provider: Cloudflare, key ${cf.name ? `"${cf.name}" ` : ""}…${cf.keyId.slice(-4)}, secret in ${cf.store === "keychain" ? "your keychain" : ice.CLOUDFLARE_SECRET_ENV}.` +
            (s.expires ? `\nShort-lived credentials minted, valid until ${s.expires}; renewed automatically.` : "") +
            (s.problem ? `\nNot in use: ${s.problem}.` : ""),
        );
      else if (!t) console.log("No TURN server is set. Members connect directly. If a member can't connect, `vine turn set --provider cloudflare` sets up Cloudflare's on your own account.");
      else console.log(`TURN server: ${s.turn}, user ${t.username}, password store: ${t.store}. Provider: your own server.${s.problem ? `\nNot in use: ${s.problem}.` : ""}`);
      return 0;
    }
    case "test":
      return report();
    case "clear": {
      const cf = ice.readCloudflare(dataDir);
      console.log(ice.clearTurn(dataDir) ? "TURN server removed. New connections are direct only." : "No TURN server was set.");
      if (cf) console.log(`The TURN key itself (…${cf.keyId.slice(-4)}) is still on your Cloudflare account: delete it in the dashboard if you won't use it again.`);
      return 0;
    }
    default:
      console.log(TURN_USAGE);
      return args[0] ? 2 : 0;
  }
}

async function doctor(): Promise<number> {
  const { runDoctor } = await import("./doctor.js");
  const r = await runDoctor({ print: (l) => console.log(l) });
  console.log(r.failed ? `\n${r.failed} check(s) failed.` : "\nAll checks passed.");
  return r.failed ? 1 : 0;
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
  case "setup": {
    const { setupCommand } = await import("./setup.js");
    process.exitCode = await setupCommand(rest);
    break;
  }
  case "doctor":
    process.exitCode = await doctor();
    break;
  case "hook": {
    const { hookCommand } = await import("./hook.js");
    process.exitCode = await hookCommand(rest);
    break;
  }
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
