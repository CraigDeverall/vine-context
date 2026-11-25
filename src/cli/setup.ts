// `vine setup` (advertised as `npx vine-context setup`): everything a new
// machine needs, in one go, and safe to run again: each step looks at what's
// already there first, and only does what's missing or broken.
//
//   1. the global `vine` command (the plugin runs it)
//   2. the plugin, for each agent found (Claude Code, Codex)
//   3. your display name
//   4. the `vine doctor` checks
//   5. the network: does it look like it needs TURN?
//   6. TURN: Cloudflare's (default when needed), your own, or none
//   7. autostart at login (macOS)
//   8. what to do next
//
// Every command it runs is printed first. --dry-run runs only the read-only
// checks, and prints what it would do instead of doing it.

import { spawnSync } from "node:child_process";
import { packageInfo } from "../core/package-root.js";
import type { Prompter } from "./prompt.js";

export type Agent = "claude" | "codex";
export type TurnChoice = "cloudflare" | "custom" | "none";

export interface SetupOptions {
  yes?: boolean;
  /** Which agents to install the plugin for; none: no agent. Default: those found. */
  agents?: Agent[] | "none";
  turn?: TurnChoice;
  json?: boolean;
  dryRun?: boolean;
}

export type StepStatus = "ok" | "done" | "would" | "skipped" | "warn" | "failed";

export interface StepResult {
  step: string;
  status: StepStatus;
  detail: string;
  /** Commands run (or, with dry-run, that would be). Never holds a secret. */
  commands?: string[];
}

export interface RunResult {
  status: number | null;
  stdout: string;
}

/** What the wizard touches outside itself, so tests can stand in for it. */
export interface SetupDeps {
  prompt: Prompter;
  /** Human-readable output (stderr with --json). */
  say(line: string): void;
  /** Path of a command on PATH, or undefined. */
  which(cmd: string): string | undefined;
  /** Runs a command quietly and returns its output (read-only queries). */
  query(cmd: string, args: string[]): RunResult;
  /** Runs a command that changes something, its output shown to the person. */
  run(cmd: string, args: string[]): RunResult;
  platform: NodeJS.Platform;
  dataDir: string;
  /** Run through npx (so `vine` may not be installed yet). */
  viaNpx: boolean;
  version: string;
  doctor(): Promise<import("./doctor.js").DoctorResult>;
  network(): Promise<import("../p2p/netcheck.js").NetCheck>;
  name: { current(): { name: string; source: import("../core/identity.js").NameSource }; set(name: string): void };
  turn: {
    summary(): import("../p2p/ice.js").IceSummary;
    check(): Promise<{ ok: boolean; error?: string; relay?: string }>;
    cloudflare(o: { dryRun: boolean }): Promise<import("./cloudflare-setup.js").CloudflareSetupResult>;
    custom(): Promise<{ ok: boolean; error?: string; relay?: string; label?: string }>;
  };
  autostartOn(): boolean;
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
const shown = (cmd: string, args: string[]) => [cmd, ...args].map(quote).join(" ");

/** a < b, for plain x.y.z versions. */
export function older(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  return false;
}

export const MARKETPLACE = "CraigDeverall/vine-context";
export const PLUGIN = "vine-context@vine-context";

const AGENTS: Record<Agent, { title: string; marketplaceList: string[]; marketplaceAdd: string[]; pluginList: string[]; install: string[]; installed(out: string): boolean; hasMarket(out: string): boolean }> = {
  claude: {
    title: "Claude Code",
    marketplaceList: ["plugin", "marketplace", "list"],
    marketplaceAdd: ["plugin", "marketplace", "add", MARKETPLACE],
    pluginList: ["plugin", "list"],
    install: ["plugin", "install", PLUGIN],
    installed: (out) => out.includes(PLUGIN),
    hasMarket: (out) => /(^|\s)vine-context(\s|$)/m.test(out),
  },
  codex: {
    title: "Codex",
    marketplaceList: ["plugin", "marketplace", "list"],
    marketplaceAdd: ["plugin", "marketplace", "add", MARKETPLACE],
    pluginList: ["plugin", "list"],
    install: ["plugin", "add", PLUGIN],
    installed: (out) => new RegExp(`^${PLUGIN.replace(/[.@]/g, "\\$&")}\\s+installed`, "m").test(out),
    hasMarket: (out) => /^vine-context\s/m.test(out),
  },
};

export async function runSetup(o: SetupOptions, d: SetupDeps): Promise<{ steps: StepResult[]; exitCode: number }> {
  const steps: StepResult[] = [];
  const dry = Boolean(o.dryRun);
  const record = (r: StepResult) => {
    steps.push(r);
    const mark = { ok: "ok   ", done: "done ", would: "would", skipped: "skip ", warn: "warn ", failed: "FAIL " }[r.status];
    d.say(`${mark} ${r.status === "would" ? r.detail.replace(/^would /, "") : r.detail}`);
  };
  const heading = (n: number, title: string) => d.say(`\n${n}. ${title}`);
  /** Prints the command, then runs it (or, dry, doesn't). True if it ran and succeeded. */
  const act = (cmd: string, args: string[], commands: string[]): boolean => {
    const line = shown(cmd, args);
    commands.push(line);
    d.say(`  $ ${line}`);
    if (dry) return true;
    return d.run(cmd, args).status === 0;
  };

  d.say(`vine setup ${d.version}${dry ? " (dry run: nothing will be changed)" : ""}`);

  // 1. The global vine command.
  heading(1, "The vine command");
  {
    const path = d.which("vine");
    const have = path ? d.query(path, ["--version"]).stdout.trim() : "";
    const commands: string[] = [];
    if (path && have && !older(have, d.version)) record({ step: "vine", status: "ok", detail: `vine ${have} is installed (${path})` });
    else {
      const why = path
        ? `vine ${have || "(unknown version)"} is older than ${d.version}`
        : `vine isn't installed globally${d.viaNpx ? " (this is a temporary npx copy)" : ""}, and the plugin needs it on your PATH`;
      d.say(`  ${why}.`);
      if (await d.prompt.confirm(`  Install vine-context ${d.version} globally with npm?`, true)) {
        const ok = act("npm", ["install", "-g", `vine-context@${d.version}`], commands);
        record({ step: "vine", status: dry ? "would" : ok ? "done" : "failed", detail: dry ? `would install vine-context ${d.version}` : ok ? `installed vine-context ${d.version}` : "npm install failed (see above)", commands });
      } else record({ step: "vine", status: "skipped", detail: `not installed: run \`npm install -g vine-context\` before using the plugin` });
    }
  }

  // 2. The plugin for each agent.
  heading(2, "Your agents");
  {
    const wanted: Agent[] = o.agents === "none" ? [] : (o.agents ?? (["claude", "codex"] as Agent[]).filter((a) => d.which(a)));
    if (o.agents === "none") record({ step: "agents", status: "skipped", detail: "no agent (--agent none)" });
    else if (!wanted.length) record({ step: "agents", status: "skipped", detail: "no Claude Code or Codex found on your PATH" });
    for (const a of wanted) {
      const spec = AGENTS[a];
      if (!d.which(a)) {
        record({ step: `plugin:${a}`, status: "skipped", detail: `${spec.title} (\`${a}\`) isn't on your PATH` });
        continue;
      }
      if (spec.installed(d.query(a, spec.pluginList).stdout)) {
        record({ step: `plugin:${a}`, status: "ok", detail: `${spec.title}: the vine-context plugin is installed` });
        continue;
      }
      const commands: string[] = [];
      const needMarket = !spec.hasMarket(d.query(a, spec.marketplaceList).stdout);
      const plan = [...(needMarket ? [shown(a, spec.marketplaceAdd)] : []), shown(a, spec.install)];
      d.say(`  ${spec.title} doesn't have the plugin yet. This runs:\n${plan.map((p) => `    ${p}`).join("\n")}`);
      if (!(await d.prompt.confirm(`  Install the plugin for ${spec.title}?`, true))) {
        record({ step: `plugin:${a}`, status: "skipped", detail: `${spec.title}: not installed (you can run the commands above yourself)` });
        continue;
      }
      const ok = (!needMarket || act(a, spec.marketplaceAdd, commands)) && act(a, spec.install, commands);
      record({
        step: `plugin:${a}`,
        status: dry ? "would" : ok ? "done" : "failed",
        detail: dry ? `${spec.title}: would install the plugin` : ok ? `${spec.title}: plugin installed (restart ${spec.title} to load it)` : `${spec.title}: install failed (see above)`,
        commands,
      });
    }
    d.say("  Another MCP agent? Point it at the command `vine mcp` (stdio). For example: claude mcp add vine-context -- vine mcp");
  }

  // 3. Display name.
  heading(3, "Your name");
  {
    const cur = d.name.current();
    if (cur.source === "VINE_USER") record({ step: "name", status: "ok", detail: `${cur.name} (from VINE_USER)` });
    else {
      const from = { set_my_name: "set before", git: "from git", os: "from your computer account", login: "your login name", generated: "made up" }[cur.source] ?? cur.source;
      // A found name is offered to keep or change; a guess is only the fallback, so ask for theirs.
      const guessed = cur.source === "login" || cur.source === "generated";
      const question = guessed ? `  Your name, as others will see it (Enter keeps ${cur.name}, ${from})` : `  The name others see you as (${from})`;
      const name = (await d.prompt.ask(question, cur.name)).trim().slice(0, 60);
      if (cur.source === "set_my_name" && name === cur.name) record({ step: "name", status: "ok", detail: `${name}` });
      else if (!name) record({ step: "name", status: "skipped", detail: `kept ${cur.name}` });
      // A kept guess isn't saved, so a better name found later (or given here next time) replaces it.
      else if (guessed && name === cur.name) record({ step: "name", status: "skipped", detail: `using ${cur.name} for now (${from}); set your own with \`vine setup\`` });
      else {
        if (!dry) d.name.set(name);
        record({ step: "name", status: dry ? "would" : "done", detail: dry ? `would save ${name} as your name` : `saved ${name} as your name` });
      }
    }
  }

  // 4. Doctor.
  heading(4, "This machine");
  {
    const r = await d.doctor();
    const bad = r.checks.filter((c) => c.level === "fail");
    record(
      bad.length
        ? { step: "doctor", status: "failed", detail: `${bad.length} check(s) failed: ${bad.map((c) => c.name).join(", ")} (\`vine doctor\` shows them)` }
        : { step: "doctor", status: "ok", detail: `all ${r.checks.length} checks passed` },
    );
  }

  // 5. Network.
  heading(5, "Your network");
  let needsTurn = false;
  {
    const n = await d.network();
    needsTurn = n.needsTurn;
    d.say(`  ${n.summary}`);
    record({
      step: "network",
      status: n.relaysUp === 0 ? "failed" : n.needsTurn ? "warn" : "ok",
      detail: n.relaysUp === 0 ? "no Nostr relay reachable" : n.needsTurn ? "this network will likely need TURN" : "direct connections should work from here",
    });
  }

  // 6. TURN.
  heading(6, "TURN (a relay for networks that block direct connections)");
  {
    d.say(
      "  Vine connects members directly when it can. A TURN server only relays the encrypted connection when it can't, and only one machine in a pair needs one.\n" +
        "  Changes are forwarded between members, so you only need it if you can reach no member at all.",
    );
    const s = d.turn.summary();
    let choice: TurnChoice | undefined = o.turn;
    let working = false;
    if (s.source === "env") {
      record({ step: "turn", status: "ok", detail: `VINE_ICE is set and replaces the TURN setting (${s.turn ?? "no TURN server"})` });
      choice = "none";
      working = true;
    } else if (s.turn && !choice) {
      const c = await d.turn.check();
      if (c.ok) {
        record({ step: "turn", status: "ok", detail: `${s.turn} is set and lent a relay address` });
        working = true;
      } else {
        d.say(`  ${s.turn} is set, but it doesn't work: ${c.error}`);
        choice = s.provider === "cloudflare" ? "cloudflare" : undefined; // repair it
      }
    }
    if (!working) {
      if (!choice) {
        d.say(needsTurn ? "  This network looks like it needs TURN." : "  This network looks fine without TURN; you can add it later with `vine turn set --provider cloudflare`.");
        const i = await d.prompt.choose(
          "  Set up TURN?",
          ["Set up Cloudflare TURN (free for this use; your own Cloudflare account)", "Use my own TURN server", "Skip"],
          needsTurn ? 0 : 2,
        );
        choice = (["cloudflare", "custom", "none"] as const)[i];
      }
      if (choice === "none") record({ step: "turn", status: needsTurn ? "warn" : "skipped", detail: needsTurn ? "no TURN server: members on stricter networks may not connect" : "no TURN server (not needed here)" });
      else if (choice === "cloudflare") {
        if (!dry && !d.prompt.interactive)
          record({ step: "turn", status: "failed", detail: "Cloudflare TURN needs a terminal to type the key in unseen: run `vine turn set --provider cloudflare` in one" });
        else {
          const r = await d.turn.cloudflare({ dryRun: dry });
          record(
            dry
              ? { step: "turn", status: "would", detail: "would set up Cloudflare TURN" }
              : r.ok
                ? { step: "turn", status: "done", detail: `Cloudflare TURN set up${r.created ? " (a new TURN key)" : ""}, and it lent a relay address (${r.relay})` }
                : { step: "turn", status: "failed", detail: `Cloudflare TURN: ${r.error}` },
          );
        }
      } else if (choice === "custom") {
        if (dry) record({ step: "turn", status: "would", detail: "would ask for your TURN server, username and (unseen) password, save them, and test it" });
        else {
          const r = await d.turn.custom();
          record(r.ok ? { step: "turn", status: "done", detail: `${r.label} set, and it lent a relay address (${r.relay})` } : { step: "turn", status: "failed", detail: `TURN server: ${r.error}` });
        }
      }
    }
  }

  // 7. Autostart.
  heading(7, "Sync after a reboot");
  {
    if (d.platform !== "darwin") record({ step: "autostart", status: "skipped", detail: "autostart is for macOS; elsewhere run `vine up` from your login scripts" });
    else if (d.autostartOn()) record({ step: "autostart", status: "ok", detail: "`vine up` already runs at login" });
    else if (await d.prompt.confirm("  Run `vine up` at login, so your shared contexts sync after a reboot?", true)) {
      const commands: string[] = [];
      // The global vine, not this (possibly npx) copy: the launch agent must outlive it.
      const vine = d.which("vine");
      const ok = vine || dry ? act(vine ?? "vine", ["autostart", "on"], commands) : false;
      record({ step: "autostart", status: dry ? "would" : ok ? "done" : "failed", detail: dry ? "would turn autostart on" : ok ? "autostart on" : "couldn't turn autostart on (is vine installed?)", commands });
    } else record({ step: "autostart", status: "skipped", detail: "autostart off (`vine autostart on` turns it on)" });
  }

  // 8. Next.
  heading(8, "Next");
  d.say("  See it with an example:  vine demo");
  d.say('  Or tell your agent:      "start a context called <name> for <what it\'s for>", then "share it with Sam".');
  const failed = steps.filter((s) => s.status === "failed").length;
  d.say(failed ? `\n${failed} step(s) need attention (above). Run \`npx vine-context setup\` again to repair.` : dry ? "\nDry run done: nothing was changed." : "\nAll set.");
  return { steps, exitCode: failed ? 1 : 0 };
}

/** Real dependencies. */
export async function realDeps(o: SetupOptions, prompt: Prompter): Promise<SetupDeps> {
  const [{ defaultDataDir }, identity, ice, { existsSync }, { homedir }, { join, delimiter }] = await Promise.all([
    import("../core/graph.js"),
    import("../core/identity.js"),
    import("../p2p/ice.js"),
    import("node:fs"),
    import("node:os"),
    import("node:path"),
  ]);
  const dataDir = defaultDataDir();
  const say = (l: string) => (o.json ? process.stderr : process.stdout).write(`${l}\n`);
  const which = (cmd: string) => {
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      // npx (npm exec) puts its throwaway install, and the project's, first on PATH: those aren't installed.
      if (/[\\/]_npx[\\/]|node_modules[\\/]\.bin/.test(dir)) continue;
      for (const ext of process.platform === "win32" ? [".cmd", ".exe", ""] : [""]) {
        const p = join(dir, cmd + ext);
        if (dir && existsSync(p)) return p;
      }
    }
    return undefined;
  };
  return {
    prompt,
    say,
    which,
    query: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
      return { status: r.status, stdout: r.stdout ?? "" };
    },
    run: (cmd, args) => {
      // Output goes to the person (stderr with --json, so stdout stays JSON).
      const r = spawnSync(cmd, args, { stdio: ["inherit", o.json ? 2 : "inherit", "inherit"], shell: process.platform === "win32" });
      return { status: r.status, stdout: "" };
    },
    platform: process.platform,
    dataDir,
    viaNpx: process.env.npm_command === "exec" || /[\\/]_npx[\\/]/.test(process.argv[1] ?? ""),
    version: packageInfo().version,
    doctor: async () => {
      const { runDoctor } = await import("./doctor.js");
      return runDoctor({ network: false, print: (l) => say(`  ${l}`) });
    },
    network: async () => {
      const { checkNetwork } = await import("../p2p/netcheck.js");
      return checkNetwork();
    },
    name: {
      current: () => identity.resolveName(dataDir),
      set: (n) => void identity.setName(dataDir, n),
    },
    turn: {
      summary: () => ice.resolveIce(dataDir).summary,
      check: () => ice.checkStoredTurn(dataDir),
      cloudflare: async ({ dryRun }) => {
        const { setupCloudflare } = await import("./cloudflare-setup.js");
        return setupCloudflare({ dataDir, prompt, say: (l) => say(`  ${l}`), dryRun });
      },
      custom: async () => {
        const { keychainTool } = await import("../core/secret.js");
        try {
          const where = await prompt.ask("  TURN server (host or host:port)");
          const { host, port } = ice.parseHostPort(where);
          const username = await prompt.ask("  Username");
          const transport = (["udp", "tcp", "tls"] as const)[await prompt.choose("  How is it reached?", ["UDP (usual)", "TCP", "TLS"], 0)];
          const store = keychainTool() ? "keychain" : "file";
          const password = await prompt.hidden(`  Password for ${username} on ${host} (typed unseen)`);
          const t = ice.saveTurn(dataDir, { host, port, username, transport, store, password });
          const c = await ice.checkStoredTurn(dataDir);
          return { ...c, label: `${t.host}:${t.port} (${t.transport})` };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
    },
    autostartOn: () => existsSync(join(homedir(), "Library", "LaunchAgents", "dev.vine.up.plist")),
  };
}

export const SETUP_USAGE = `Usage: vine setup [--yes] [--agent claude|codex|none] [--turn cloudflare|custom|none] [--json] [--dry-run]
  (or, before vine is installed: npx vine-context setup)

Sets this machine up for Vine Context, and repairs it when run again:
installs the vine command and your agents' plugin, confirms your name, checks
the machine and the network, sets up TURN if the network needs it, and offers
autostart at login (macOS).

  --yes        take the default answer to every question (secrets are still typed, unseen)
  --agent      which agents get the plugin (comma-separated); default: those found
  --turn       cloudflare, custom or none, instead of asking
  --json       print the steps' results as JSON on stdout (the rest goes to stderr)
  --dry-run    run the read-only checks only, and print what would be done`;

export async function setupCommand(args: string[]): Promise<number> {
  const { parseArgs } = await import("node:util");
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args,
      options: { yes: { type: "boolean", short: "y" }, agent: { type: "string" }, turn: { type: "string" }, json: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } },
    }));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${SETUP_USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(SETUP_USAGE);
    return 0;
  }
  const agentArg = values.agent as string | undefined;
  const agents = agentArg === undefined ? undefined : agentArg === "none" ? ("none" as const) : (agentArg.split(",").map((s) => s.trim()) as Agent[]);
  const turn = values.turn as TurnChoice | undefined;
  if ((Array.isArray(agents) && agents.some((a) => !(a in AGENTS))) || (turn && !["cloudflare", "custom", "none"].includes(turn))) {
    console.error(SETUP_USAGE);
    return 2;
  }
  const o: SetupOptions = { yes: Boolean(values.yes), agents, turn, json: Boolean(values.json), dryRun: Boolean(values["dry-run"]) };
  const { terminalPrompter, defaultsPrompter } = await import("./prompt.js");
  const prompt = o.yes ? defaultsPrompter(terminalPrompter()) : terminalPrompter();
  const deps = await realDeps(o, prompt);
  try {
    const r = await runSetup(o, deps);
    if (o.json) console.log(JSON.stringify({ version: deps.version, dryRun: Boolean(o.dryRun), steps: r.steps }, null, 2));
    return r.exitCode;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}
