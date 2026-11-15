// Spike B: can the host's agent attach Relate's own MCP server, read-only, to
// the store that p2pcg is writing through embedded Relate?
//
// The writer (this process) keeps the store open and writes. A child process
// runs `relate serve --mcp stdio --read-only=live` on the same directory. We
// talk JSON-RPC to it and check that it sees writes made after it started.
// Run: npx tsx spikes/relate-live-follower.ts <dir>

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Database } from "@relate/relate";

const dir = process.argv[2] ?? "./.data/spike-b";
const relateBin = process.env.RELATE_BIN ?? "relate";

const db = Database.open(dir);
const conn = db.connect();
conn.query("CREATE CONSTRAINT claim_id IF NOT EXISTS FOR (c:Claim) REQUIRE c.id IS UNIQUE");
conn.query("MERGE (:Claim {id: 'before', text: 'written before the follower started'})");
db.checkpoint();

const child = spawn(relateBin, ["serve", "--database", dir, "--mcp", "stdio", "--read-only=live"], {
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

const pending = new Map<number, (msg: any) => void>();
createInterface({ input: child.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});
let nextId = 1;
function rpc(method: string, params: unknown = {}): Promise<any> {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout on ${method}; stderr: ${stderr.slice(-400)}`)), 10_000);
  });
}
const count = async () => {
  const r = await rpc("tools/call", {
    name: "read_cypher",
    arguments: { statement: "MATCH (c:Claim) RETURN count(c) AS n" },
  });
  return JSON.parse(r.result.content[0].text).rows[0].n;
};

const out: Record<string, unknown> = {};
const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "spike-b", version: "0" },
});
out.server = init.result?.serverInfo;
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
out.tools = (await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
out.countAtStart = await count();

// Write after the follower started, with and without a checkpoint.
conn.query("MERGE (:Claim {id: 'after-commit', text: 'committed, no checkpoint'})");
await new Promise((r) => setTimeout(r, 1500));
out.countAfterCommit = await count();
db.checkpoint();
conn.query("MERGE (:Claim {id: 'after-checkpoint', text: 'committed after a checkpoint'})");
db.checkpoint();
await new Promise((r) => setTimeout(r, 1500));
out.countAfterCheckpoint = await count();

const write = await rpc("tools/call", {
  name: "write_cypher",
  arguments: { statement: "CREATE (:Claim {id: 'from-mcp'})" },
});
out.writeRefused = write.error ? write.error.message : write.result?.isError ? "isError" : "NOT REFUSED";

child.kill();
console.log(JSON.stringify(out, null, 1));
process.exit(0);
