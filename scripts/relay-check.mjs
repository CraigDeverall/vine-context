// Replication over the real public Nostr relays, with the built CLI: three
// identities (alice, bob, carol), each with its own data folder, as three
// people's machines would be.
//
//   npm run build && node scripts/relay-check.mjs [workdir]
//
// It joins with codes, syncs writes both ways, checks the sync digest, takes a
// write back inside the hold, and keeps two members syncing while the
// context's creator is offline. It stops every host it started.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = process.argv[2] ?? mkdtempSync(join(tmpdir(), "p2pcg-relay-check-"));
const sdk = (p) => import(join(repo, "node_modules/@modelcontextprotocol/sdk/dist/esm", p));
const { Client } = await sdk("client/index.js");
const { StdioClientTransport } = await sdk("client/stdio.js");
const cli = join(repo, "dist/cli.js");
rmSync(work, { recursive: true, force: true });
const context = `relay-check-${Date.now().toString(36)}`;
const env = (who) => ({ ...process.env, P2PCG_DATA_DIR: join(work, who), P2PCG_USER: who, P2PCG_NO_OPEN: "1", P2PCG_AUTO_SHARE: "on", P2PCG_HOLD_MS: "1500", RELATE_TELEMETRY: "off" });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function agent(who, c) {
  mkdirSync(join(work, who), { recursive: true });
  const client = new Client({ name: `${who}-agent`, version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--context", c], env: env(who), cwd: join(work, who), stderr: "ignore" }));
  const raw = async (name, a = {}) => client.callTool({ name, arguments: a });
  const call = async (name, a = {}) => {
    const r = await raw(name, a);
    const t = r.content.find((x) => !x.text.startsWith("News")).text;
    let v;
    try {
      v = JSON.parse(t);
    } catch {
      v = t;
    }
    if (r.isError) throw new Error(typeof v === "string" ? v : JSON.stringify(v));
    return v;
  };
  const texts = async () => (await call("beliefs")).map((r) => r.text);
  return { who, raw, call, texts, close: () => client.close() };
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  log(ok ? "PASS" : "FAIL", name, detail);
};
const until = async (fn, ms = 90_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(1000);
  }
  return false;
};
const stopHost = (who, c) => spawnSync(process.execPath, [cli, "host", "stop", "--context", c], { env: env(who) });
const started = [];

try {
  const alice = await agent("alice", context);
  started.push(["alice", context]);
  await alice.call("describe_context", { description: "A relay check: claims about an imaginary outage" });
  await alice.call("add_claim", { text: "Alice wrote this before anyone joined" });
  const inv = await alice.call("share_context", { label: "for bob" });
  check("alice gets a code", /^p2pcg1_/.test(inv.code));

  const bob = await agent("bob", "own");
  started.push(["bob", "own"]);
  const t0 = Date.now();
  const j = await bob.call("join_context", { code: inv.code });
  started.push(["bob", j.here_as]);
  check(
    "bob joins over real relays: a full copy, the description and a briefing",
    (await bob.texts()).includes("Alice wrote this before anyone joined") && j.description?.startsWith("A relay check") && j.briefing?.holds?.Claim === 1,
    `${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );

  let news = "";
  await until(async () => (news = (await alice.raw("context_info")).content.map((x) => x.text).join("\n")).includes("News: bob joined"), 30_000);
  check("alice's agent is told bob joined", news.includes("News: bob joined") && news.includes(j.your_fingerprint), news.split("\n")[0]);

  const old = await alice.call("add_claim", { text: "The outage lasts 4 minutes" });
  await until(async () => (await bob.texts()).includes("The outage lasts 4 minutes"));
  await bob.call("add_claim", { text: "The outage lasts 6 minutes", replaces: [old.id] });
  let digest = "";
  check(
    "alice is told bob replaced her claim (the sync digest)",
    await until(async () => (digest += (await alice.raw("context_info")).content.map((x) => x.text).join("\n")).includes("bob replaced your claim")),
    digest.split("\n").find((l) => l.includes("replaced your claim")) ?? "",
  );

  await alice.call("add_claim", { text: "Alice's reply travels to bob" });
  check("alice's write reaches bob", await until(async () => (await bob.texts()).includes("Alice's reply travels to bob")));

  const secret = await bob.call("add_claim", { text: "Bob's home address is 1 Secret Street" });
  await bob.call("take_back", { id: secret.change });
  await sleep(8000);
  check("a taken-back write never reaches alice", !(await alice.texts()).includes("Bob's home address is 1 Secret Street"));

  const inv2 = await alice.call("share_context", { label: "for carol" });
  const carol = await agent("carol", "own");
  started.push(["carol", "own"]);
  const j2 = await carol.call("join_context", { code: inv2.code });
  started.push(["carol", j2.here_as]);
  check("carol joins", (await carol.texts()).includes("Alice's reply travels to bob"));

  // The creator goes away: bob and carol keep syncing with each other.
  await alice.close();
  stopHost("alice", context);
  await sleep(2000);
  await bob.call("add_claim", { text: "Bob wrote this while alice was away" });
  check("with alice offline, carol gets bob's write from bob", await until(async () => (await carol.texts()).includes("Bob wrote this while alice was away")));

  // Alice comes back and catches up.
  const alice2 = await agent("alice", context);
  check("alice catches up when she's back", await until(async () => (await alice2.texts()).includes("Bob wrote this while alice was away")));
  const st = await alice2.call("sharing_status");
  log("alice's relays:", JSON.stringify(st.relays), "links:", st.links.map((l) => `${l.name}:${l.state}`).join(","));
  await alice2.close();
  await bob.close();
  await carol.close();
} catch (e) {
  check("no unexpected error", false, e.message);
} finally {
  for (const [who, c] of started) stopHost(who, c);
}
const failed = results.filter((r) => !r).length;
log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
