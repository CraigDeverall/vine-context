// Loads the Rust addon and measures load time, per-call latency and whether it
// ranks by meaning. Run after `npm run build:embedder -- all`, one model per
// process so the memory figure is that model's:
//   node spikes/embed-rs/bench.mjs <model-dir> <onnx-file> <cls|mean>
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "native", "embedder", "dist");
const { Model } = createRequire(import.meta.url)(join(dist, "embedder.node"));
const [dir, file, pooling] = process.argv.slice(2);

const rss0 = process.memoryUsage().rss;
let t = performance.now();
const addon = new Model(join(dist, "models", dir), file, pooling, 256);
const loadMs = performance.now() - t;

const cos = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

// Claims in the style the graph holds, and queries that share meaning but few words.
const claims = [
  "The release is scheduled for the first week of December.",
  "We chose Postgres over MongoDB for the billing service.",
  "Sam is responsible for the mobile app's login flow.",
  "The nightly backup job fails when the disk is nearly full.",
  "Customers in Europe must have their data stored in Frankfurt.",
  "The API rate limit is 100 requests per minute per key.",
  "Our office is closed on public holidays.",
  "The design team prefers Figma for prototypes.",
];
const queries = [
  ["When do we ship?", 0],
  ["Which database did we pick for payments?", 1],
  ["Who owns authentication on iOS and Android?", 2],
  ["Why do backups break?", 3],
  ["Where is EU user information kept?", 4],
  ["How many calls can a client make before being throttled?", 5],
];

const claimVecs = claims.map((c) => addon.embed(c));
if (process.env.DUMP) (await import("node:fs")).writeFileSync(process.env.DUMP, JSON.stringify(claimVecs.map((v) => Array.from(v))));
let top1 = 0;
const misses = [];
for (const [q, want] of queries) {
  const qv = addon.embed(q);
  const scores = claimVecs.map((v) => cos(qv, v));
  const best = scores.indexOf(Math.max(...scores));
  if (best === want) top1++;
  else misses.push(`${q} -> ${claims[best]}`);
}

// Latency: one short claim, one long text (truncated to 256 tokens).
const short = claims[3];
const long = claims.join(" ").repeat(6);
const time = (text, n) => {
  for (let i = 0; i < 5; i++) addon.embed(text);
  const ms = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    addon.embed(text);
    ms.push(performance.now() - s);
  }
  ms.sort((a, b) => a - b);
  return { p50: ms[Math.floor(n / 2)], p95: ms[Math.floor(n * 0.95)] };
};
const s = time(short, 100);
const l = time(long, 30);
const v = addon.embed(short);

console.log(
  JSON.stringify({
    model: `${dir}/${file}`,
    dim: v.length,
    norm: +Math.sqrt(cos(v, v)).toFixed(4),
    load_ms: Math.round(loadMs),
    short_tokens: addon.tokenCount(short),
    short_p50_ms: +s.p50.toFixed(2),
    short_p95_ms: +s.p95.toFixed(2),
    long_tokens: addon.tokenCount(long),
    long_p50_ms: +l.p50.toFixed(1),
    long_p95_ms: +l.p95.toFixed(1),
    top1: `${top1}/${queries.length}`,
    misses,
    rss_mb: Math.round((process.memoryUsage().rss - rss0) / 1e6),
    head: Array.from(v.slice(0, 4)).map((x) => +x.toFixed(4)),
  }),
);
