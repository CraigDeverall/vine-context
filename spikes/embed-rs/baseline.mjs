// The same ranking test as bench.mjs, against the current hash-256 embedder.
//   npx tsx spikes/embed-rs/baseline.mjs
import { HashEmbedder } from "../../src/core/embed.ts";

const e = new HashEmbedder();
const cos = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
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
const vecs = claims.map((c) => e.embed(c));
let top1 = 0;
for (const [q, want] of queries) {
  const scores = vecs.map((v) => cos(e.embed(q), v));
  if (scores.indexOf(Math.max(...scores)) === want) top1++;
}
const s = performance.now();
for (let i = 0; i < 1000; i++) e.embed(claims[3]);
console.log(JSON.stringify({ model: e.name, top1: `${top1}/${queries.length}`, short_ms: +((performance.now() - s) / 1000).toFixed(3) }));
