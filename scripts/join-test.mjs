// Joins someone's context with a join code, with no AI agent: for trying a
// code between two people's machines. It drives the built MCP server the same
// way an agent would (join_context, beliefs, add_claim), over the real relays.
//
//   npm install && npm run build
//   node scripts/join-test.mjs '<vine1_ code>' [your name]
//
// It keeps its copy in .data/join-test inside this folder (set VINE_DATA_DIR
// to use another), so it never touches contexts you already have. It stays
// online, printing who it can see and what the context holds, until Ctrl-C.
//
// To check a code is good for one machine only, run it again with the same
// code and another folder: VINE_DATA_DIR=.data/other node scripts/join-test.mjs '<code>' other

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const [code, name = "tester"] = process.argv.slice(2);
const cli = join(repo, "dist/cli.js");
if (!code || !/vine1_/.test(code)) {
  console.error("Usage: node scripts/join-test.mjs '<vine1_ code>' [your name]");
  process.exit(2);
}
if (!existsSync(cli)) {
  console.error("Build first: npm install && npm run build");
  process.exit(2);
}
const dataDir = resolve(process.env.VINE_DATA_DIR ?? join(repo, ".data/join-test"));
mkdirSync(dataDir, { recursive: true });
const env = { ...process.env, VINE_DATA_DIR: dataDir, VINE_USER: process.env.VINE_USER ?? name, VINE_CHAT: `join-test-${Date.now().toString(36)}`, VINE_NO_OPEN: "1", RELATE_TELEMETRY: "off" };
delete env.VINE_CONTEXT;
delete env.VINE_GRAPH;

const sdk = (p) => import(join(repo, "node_modules/@modelcontextprotocol/sdk/dist/esm", p));
const { Client } = await sdk("client/index.js");
const { StdioClientTransport } = await sdk("client/stdio.js");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const client = new Client({ name: "join-test", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, cwd: dataDir, stderr: "ignore" }));
const call = async (tool, args = {}) => {
  const r = await client.callTool({ name: tool, arguments: args });
  const t = r.content.find((x) => typeof x.text === "string" && !x.text.startsWith("News"))?.text ?? "";
  let v;
  try {
    v = JSON.parse(t);
  } catch {
    v = t;
  }
  if (r.isError) throw new Error(typeof v === "string" ? v : JSON.stringify(v));
  return v;
};

let context;
const stop = async (status) => {
  await client.close().catch(() => {});
  if (context) spawnSync(process.execPath, [cli, "host", "stop", "--context", context], { env });
  process.exit(status);
};
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

log(`joining as '${env.VINE_USER}' (copy kept in ${dataDir})`);
const t0 = Date.now();
let joined;
try {
  joined = await call("join_context", { code });
} catch (e) {
  log("NOT LET IN:", e.message);
  await stop(1);
}
context = joined.here_as;
const info = await call("context_info");
log(`JOINED in ${((Date.now() - t0) / 1000).toFixed(1)}s: context '${context}', role ${info.you?.role ?? joined.role ?? "?"}`);
if (info.description ?? joined.description) log(`it is for: ${info.description ?? joined.description}`);

const claims = async () => (await call("beliefs")).map((r) => r.text);
const first = await claims();
log(`your copy holds ${first.length} claim(s):`);
for (const t of first.slice(0, 10)) log(`  - ${t}`);

const mine = `Hello from ${env.VINE_USER}, written by the join test at ${new Date().toISOString().slice(0, 16)}Z`;
try {
  await call("add_claim", { text: mine, source: "scripts/join-test.mjs" });
  log(`wrote a claim (it is sent to the others after the Undo hold, about 10 seconds): "${mine}"`);
} catch (e) {
  log("write refused:", e.message);
}

log("staying online; Ctrl-C to stop");
let last = "";
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const s = await call("sharing", { action: "status" });
    const people = (s.people ?? []).map((p) => `${p.name}${p.you ? " (you)" : ""}: ${p.role}, ${p.you || p.online ? "online" : "offline"}`).join("; ");
    const line = `${(await claims()).length} claim(s) · ${people}`;
    if (line !== last) log((last = line));
  } catch (e) {
    log("status failed:", e.message);
  }
}
