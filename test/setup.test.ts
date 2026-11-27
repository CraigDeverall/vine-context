// `vine setup`: each step looks first and does only what's missing; a dry run
// changes nothing; commands are printed before they run.

import { describe, expect, it } from "vitest";
import { older, runSetup, type SetupDeps, type SetupOptions } from "../src/cli/setup.js";

interface World {
  onPath: Record<string, string>;
  vineVersion?: string;
  claudePlugins?: string;
  claudeMarkets?: string;
  codexPlugins?: string;
  codexMarkets?: string;
  name?: { name: string; source: import("../src/core/identity.js").NameSource };
  needsTurn?: boolean;
  turn?: { turn: string | null; provider?: "cloudflare" | "custom"; source?: "default" | "setting" | "env"; works?: boolean };
  autostart?: boolean;
  platform?: NodeJS.Platform;
  interactive?: boolean;
  choose?: number[];
}

function fake(w: World) {
  const ran: string[] = [];
  const said: string[] = [];
  const named: string[] = [];
  const cloudflare: { dryRun: boolean }[] = [];
  const chooseAnswers = [...(w.choose ?? [])];
  const deps: SetupDeps = {
    prompt: {
      interactive: w.interactive ?? true,
      ask: async (_q, def) => def ?? "",
      hidden: async () => "",
      choose: async (_q, _c, def = 0) => chooseAnswers.shift() ?? def,
      confirm: async (_q, def = true) => def,
    },
    say: (l) => said.push(l),
    which: (c) => w.onPath[c],
    query: (cmd, args) => {
      const k = `${cmd.split("/").pop()} ${args.join(" ")}`;
      const out: Record<string, string | undefined> = {
        "vine --version": w.vineVersion,
        "claude plugin list": w.claudePlugins,
        "claude plugin marketplace list": w.claudeMarkets,
        "codex plugin list": w.codexPlugins,
        "codex plugin marketplace list": w.codexMarkets,
      };
      return { status: 0, stdout: out[k] ?? "" };
    },
    run: (cmd, args) => {
      ran.push([cmd, ...args].join(" "));
      return { status: 0, stdout: "" };
    },
    platform: w.platform ?? "darwin",
    dataDir: "/nowhere",
    viaNpx: true,
    version: "0.2.0",
    doctor: async () => ({ checks: [{ name: "node", level: "ok", detail: "22" }], failed: 0 }),
    network: async () => ({ stun: [], relays: [], nat: w.needsTurn ? "symmetric" : "direct", needsTurn: Boolean(w.needsTurn), relaysUp: 5, summary: "net summary" }),
    name: { current: () => w.name ?? { name: "Craig", source: "git" }, set: (n) => void named.push(n) },
    turn: {
      summary: () => ({ stun: [], turn: w.turn?.turn ?? null, source: w.turn?.source ?? (w.turn?.turn ? "setting" : "default"), ...(w.turn?.provider ? { provider: w.turn.provider } : {}) }),
      check: async () => (w.turn?.works ? { ok: true, relay: "1.2.3.4:5" } : { ok: false, error: "no relay" }),
      cloudflare: async (o) => (cloudflare.push(o), { ok: true, relay: "1.2.3.4:5", created: true }),
      custom: async () => ({ ok: true, relay: "1.2.3.4:5", label: "t:3478 (udp)" }),
    },
    autostartOn: () => Boolean(w.autostart),
  };
  return { deps, ran, said, named, cloudflare, run: (o: SetupOptions = {}) => runSetup(o, deps) };
}

const step = (steps: { step: string }[], name: string) => steps.find((s) => s.step === name) as unknown as { status: string; detail: string; commands?: string[] };

describe("vine setup", () => {
  it("on a fresh machine: installs vine and the plugin, saves the name, turns on autostart, printing each command first", async () => {
    const f = fake({ onPath: { claude: "/bin/claude" } });
    // vine appears once npm has installed it.
    const run = f.deps.run;
    f.deps.run = (cmd, args) => {
      if (cmd === "npm") f.deps.which = (c) => ({ claude: "/bin/claude", vine: "/usr/local/bin/vine" })[c];
      return run(cmd, args);
    };
    const r = await f.run();
    expect(f.ran).toEqual([
      "npm install -g vine-context@0.2.0",
      "claude plugin marketplace add CraigDeverall/vine-context",
      "claude plugin install vine-context@vine-context",
      "/usr/local/bin/vine autostart on",
    ]);
    for (const cmd of f.ran) expect(f.said.join("\n")).toContain(`$ ${cmd}`);
    expect(f.named).toEqual(["Craig"]);
    expect(step(r.steps, "plugin:claude").status).toBe("done");
    expect(step(r.steps, "turn").status).toBe("skipped"); // the network looks fine: the default is skip
    expect(r.exitCode).toBe(0);
  });

  it("asks for a name when the one it found is a guess, and doesn't save the guess when it's kept", async () => {
    const f = fake({ onPath: { vine: "/bin/vine" }, vineVersion: "0.2.0", name: { name: "Brisk Otter", source: "generated" }, autostart: true });
    const r = await f.run({ agents: "none" });
    expect(f.named).toEqual([]);
    expect(step(r.steps, "name")).toMatchObject({ status: "skipped", detail: expect.stringContaining("Brisk Otter for now (made up)") });
    // A name found on the computer account is kept as theirs, like git's.
    const g = fake({ onPath: { vine: "/bin/vine" }, vineVersion: "0.2.0", name: { name: "Craig Deverall", source: "os" }, autostart: true });
    await g.run({ agents: "none" });
    expect(g.named).toEqual(["Craig Deverall"]);
  });

  it("run again on a set-up machine: changes nothing", async () => {
    const f = fake({
      onPath: { vine: "/usr/local/bin/vine", claude: "/bin/claude", codex: "/bin/codex" },
      vineVersion: "0.2.0",
      claudePlugins: "  ❯ vine-context@vine-context\n    Version: 0.2.0",
      codexPlugins: "vine-context@vine-context  installed, enabled  0.2.0",
      name: { name: "Craig", source: "chosen" },
      turn: { turn: "Cloudflare Realtime TURN (turn.cloudflare.com)", provider: "cloudflare", works: true },
      autostart: true,
    });
    const r = await f.run();
    expect(f.ran).toEqual([]);
    expect(f.named).toEqual([]);
    expect(f.cloudflare).toEqual([]);
    expect(r.steps.every((s) => s.status === "ok")).toBe(true);
  });

  it("repairs a Cloudflare setting that stopped working", async () => {
    const f = fake({ onPath: { vine: "/bin/vine" }, vineVersion: "0.2.0", turn: { turn: "Cloudflare", provider: "cloudflare", works: false }, autostart: true });
    const r = await f.run({ agents: "none" });
    expect(f.cloudflare).toEqual([{ dryRun: false }]);
    expect(step(r.steps, "turn").status).toBe("done");
  });

  it("offers Cloudflare TURN as the default when the network needs it", async () => {
    const f = fake({ onPath: { vine: "/bin/vine" }, vineVersion: "0.2.0", needsTurn: true, autostart: true });
    const r = await f.run({ agents: "none" });
    expect(f.said.join("\n")).toContain("This network looks like it needs TURN.");
    expect(f.cloudflare).toHaveLength(1);
    expect(step(r.steps, "network").status).toBe("warn");
  });

  it("--turn none is respected even when TURN looks needed, and says so", async () => {
    const f = fake({ onPath: { vine: "/bin/vine" }, vineVersion: "0.2.0", needsTurn: true, autostart: true });
    const r = await f.run({ agents: "none", turn: "none" });
    expect(f.cloudflare).toHaveLength(0);
    expect(step(r.steps, "turn")).toMatchObject({ status: "warn" });
  });

  it("a dry run runs nothing and saves nothing, but lists what it would run", async () => {
    const f = fake({ onPath: { claude: "/bin/claude", codex: "/bin/codex" }, needsTurn: true });
    const r = await f.run({ dryRun: true });
    expect(f.ran).toEqual([]);
    expect(f.named).toEqual([]);
    expect(f.cloudflare).toEqual([{ dryRun: true }]);
    expect(r.steps.flatMap((s) => s.commands ?? [])).toEqual([
      "npm install -g vine-context@0.2.0",
      "claude plugin marketplace add CraigDeverall/vine-context",
      "claude plugin install vine-context@vine-context",
      "codex plugin marketplace add CraigDeverall/vine-context",
      "codex plugin add vine-context@vine-context",
      "vine autostart on",
    ]);
    expect(f.said.join("\n")).toContain("Dry run done: nothing was changed.");
  });

  it("skips the marketplace when it's already added, and --agent picks the agents", async () => {
    const f = fake({ onPath: { vine: "/bin/vine", claude: "/c", codex: "/x" }, vineVersion: "0.2.0", codexMarkets: "vine-context   /root/x\n", autostart: true });
    await f.run({ agents: ["codex"] });
    expect(f.ran).toEqual(["codex plugin add vine-context@vine-context"]);
  });

  it("upgrades an older vine", async () => {
    const f = fake({ onPath: { vine: "/bin/vine" }, vineVersion: "0.1.0", autostart: true });
    await f.run({ agents: "none" });
    expect(f.ran).toEqual(["npm install -g vine-context@0.2.0"]);
  });

  it("won't take a TURN key without a terminal to type it in unseen", async () => {
    const f = fake({ onPath: { vine: "/bin/vine" }, vineVersion: "0.2.0", interactive: false, autostart: true });
    const r = await f.run({ agents: "none", turn: "cloudflare" });
    expect(f.cloudflare).toHaveLength(0);
    expect(step(r.steps, "turn")).toMatchObject({ status: "failed", detail: expect.stringContaining("vine turn set --provider cloudflare") });
    expect(r.exitCode).toBe(1);
  });

  it("leaves autostart alone off macOS", async () => {
    const f = fake({ onPath: { vine: "/bin/vine" }, vineVersion: "0.2.0", platform: "linux" });
    const r = await f.run({ agents: "none" });
    expect(step(r.steps, "autostart").status).toBe("skipped");
    expect(f.ran).toEqual([]);
  });

  it("compares versions", () => {
    expect(older("0.1.0", "0.2.0")).toBe(true);
    expect(older("0.10.0", "0.9.9")).toBe(false);
    expect(older("1.0.0", "1.0.0")).toBe(false);
  });
});
