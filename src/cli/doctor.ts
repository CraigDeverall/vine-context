// `vine doctor`: can this machine run vine, and will its network let members
// connect? Also run inline by `vine setup`.

import { packageInfo } from "../core/package-root.js";

export type CheckLevel = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  level: CheckLevel;
  detail: string;
}

export interface DoctorResult {
  checks: CheckResult[];
  failed: number;
  /** The network check, when it ran. */
  network?: import("../p2p/netcheck.js").NetCheck;
}

/** A check that passes but wants a word said: shown as "warn", not counted as failed. */
export class Warn extends Error {}

const tag: Record<CheckLevel, string> = { ok: "ok   ", warn: "warn ", fail: "FAIL " };

export async function runDoctor(o: { print?: (line: string) => void; network?: boolean } = {}): Promise<DoctorResult> {
  const checks: CheckResult[] = [];
  const out: DoctorResult = { checks, failed: 0 };
  const check = async (name: string, fn: () => Promise<string> | string) => {
    let r: CheckResult;
    try {
      r = { name, level: "ok", detail: await fn() };
    } catch (e) {
      r = { name, level: e instanceof Warn ? "warn" : "fail", detail: (e as Error).message };
    }
    checks.push(r);
    if (r.level === "fail") out.failed++;
    o.print?.(`${tag[r.level]} ${name}: ${r.detail}`);
  };
  const pkg = packageInfo();

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

  const { defaultDataDir } = await import("../core/graph.js");
  const ice = await import("../p2p/ice.js");
  const summary = ice.resolveIce(defaultDataDir()).summary;

  if (o.network !== false) {
    await check("network", async () => {
      const { checkNetwork } = await import("../p2p/netcheck.js");
      const stun = summary.stun.length >= 2 ? summary.stun : ice.DEFAULT_STUN;
      const n = await checkNetwork({ stun });
      out.network = n;
      if (n.relaysUp === 0) throw new Error(n.summary);
      if (n.needsTurn && !summary.turn) throw new Warn(`${n.summary} Set one up with \`vine turn set --provider cloudflare\` (only one machine in a pair needs it).`);
      return n.needsTurn ? `${n.summary} A TURN server is set, so that's covered.` : n.summary;
    });
  }

  await check("turn server", async () => {
    if (summary.source === "env") return `VINE_ICE is set (${summary.turn ?? "no TURN server"})`;
    if (!summary.turn) return "none set: members connect directly (`vine turn set --provider cloudflare` adds one)";
    const r = await ice.checkStoredTurn(defaultDataDir());
    if (!r.ok) throw new Error(`${summary.turn}: ${r.error}`);
    return `${summary.turn} answered and lent a relay address`;
  });
  return out;
}
