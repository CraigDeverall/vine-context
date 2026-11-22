# M0 spikes

Run on 2026-11-15 on macOS arm64, with Node 22.17, `@relate/relate` 1.0.1, the
`relate` CLI 1.0.1 and `node-datachannel` 0.33.6. The scripts are in
[`spikes/`](../spikes).

## C. Embedded Relate in a bundled build: passed

`spikes/relate-embedded.ts`. It ran from source (`tsx`) and as a tsup ESM
bundle with `@relate/relate` and `koffi` marked external. Both gave the same
results:

- It opened a directory store and created a uniqueness constraint, a vector
  index (cosine, 3 dimensions) and a full-text index.
- It wrote `datetime()` and `date()` values and a relationship.
- Hybrid search with `COMBINE` (vector + full-text, WRRF) works with
  `RELATE_PREVIEW=hybrid-search`, as long as that is set **before** Relate is
  imported. It ranked `c1, c3, c2` as expected.
- After `checkpoint()`, a read-only reopen in the same process sees the data.

Consequence: we bundle our code and keep the Relate native packages as normal
dependencies. Still to check in M1: `npm pack`, then a clean install and
`npx vine-context`. That will come with a `vine doctor` command that
loads both native modules.

## B. Relate's MCP following the embedded writer: passed

`spikes/relate-live-follower.ts`. The writer kept the store open through
`@relate/relate`. A child process ran
`relate serve --database <dir> --mcp stdio --read-only=live`, and we talked
JSON-RPC to it.

| Check | Result |
|---|---|
| `serverInfo` | `relate-mcp` 1.0.1 |
| Tools in read-only mode | `read_cypher`, `get_schema` only (`write_cypher` is not listed) |
| A write committed after the follower started, with no checkpoint | Seen within 1.5 s |
| A write after a checkpoint | Seen |
| Calling `write_cypher` anyway | Refused (`isError`) |

Consequence: the plan's §4.2 works as written. The host's own agent can
attach Relate's MCP read-only, alongside vine, with no writer contention. It
needs the `relate` CLI installed, so it stays optional.

## A. Host-star over node-datachannel with Nostr signalling: passed locally

`spikes/p2p-star.ts` and `spikes/nostr-lite.ts`. One host and two peers, as
three processes on one Mac, signalling through public Nostr relays:

- The link format is `vine://join/<room>#<secret>`. Signalling events are
  ephemeral kind 25050, tagged with a hash of the room id and encrypted with
  AES-256-GCM using a key derived (HKDF) from the secret. The secret is never
  sent.
- ICE is not trickled: each side sends one SDP once gathering completes, with
  host and srflx candidates from public STUN (Google, Cloudflare).
- After the channel opens, the host sends a challenge, and the peer has to
  answer with an HMAC of the secret before any other frame is accepted.
- **About 1.6 s** from a peer starting to an authenticated channel. 20
  round trips with 512-byte payloads took p50 4–8 ms (loopback).

Findings that change the plan:

1. **Signalling relay: Nostr, using our own minimal client.** In
   nostr-tools 2.26, `SimplePool` overflows the stack when a relay connection
   fails. That happened with both Node 22's WebSocket and `ws`. We now keep
   nostr-tools for signing only, with our own small relay set on `ws`
   (`spikes/nostr-lite.ts`): per-relay timeouts, reconnect, de-duplication,
   and publish resolves on the first relay that accepts.
2. **Relay choice matters.** relay.damus.io refused the connection from here.
   offchain.pub, relay.snort.social, relay.primal.net, relay.nostr.net and
   nos.lol accepted ephemeral events (0.7–1.5 s to the first OK). Use 4–5
   relays, configurable with `VINE_RELAYS`.
3. Waiting for every relay to acknowledge added about 3 s per handshake.
   Resolving on the first acceptance fixed it.

**Not yet proven:**

- **Across machines and NAT.** The local run used host candidates. We still
  need two machines on different networks (for example a laptop on a phone
  hotspot) to show srflx traversal, and a case that needs TURN.
- **Linux x64 prebuilds** for node-datachannel and Relate. The ubuntu job in
  CI covers this once the repo is on GitHub.

Both are carried into M2's "done when".

# Post-M4 spike: a Rust semantic embedder

Run on 2026-11-21 on macOS arm64 (Apple M1 Pro), with Node 22.17, Rust 1.100,
`tract-onnx` 0.23.10, `tokenizers` 0.23.2 and `napi` 3.16.2. The addon is now in
[`native/embedder/`](../native/embedder) and the benchmark scripts are in
[`spikes/embed-rs/`](../spikes/embed-rs).

## D. Sentence embeddings from a Rust addon, called synchronously: passed

A napi-rs addon runs the model in pure Rust with tract, so there is no
onnxruntime library. Node loads it with `require` and calls
`embed(text): Float32Array` synchronously, which is the shape of the `Embedder`
interface in `src/core/embed.ts`. The model files are the ONNX exports from
`Xenova/bge-small-en-v1.5` and `Xenova/all-MiniLM-L6-v2` on Hugging Face.

- **Addon size:** 21.6 MB, stripped, thin LTO. It links only `libSystem` and
  `libiconv`.
- **Dynamic length works.** tract ran the models with a different token count
  on every call, with no padding and no per-length plan.
- **The int8-quantized exports run in tract** and agree with full precision:
  cosine 0.996 (bge-small) and 0.990 (MiniLM) at worst over 8 texts.

| Model | File | Load | 14 tokens (p50) | 256 tokens (p50) | Memory added |
|---|---|---|---|---|---|
| bge-small-en-v1.5, int8 | 34.0 MB | 0.6–0.7 s | 6.3–7.2 ms | 99–101 ms | 130–175 MB |
| bge-small-en-v1.5, fp32 | 133.1 MB | 0.9 s | 6.9 ms | 66 ms | 353 MB |
| all-MiniLM-L6-v2, int8 | 23.0 MB | 0.3 s | 3.6 ms | 51 ms | 107 MB |
| all-MiniLM-L6-v2, fp32 | 90.4 MB | 0.5 s | 3.6 ms | 38 ms | 226 MB |
| hash-256 (today) | none | none | 0.04 ms | not measured | none |

All four produce 384-dimension unit vectors. tract ran on one thread.
Quantizing saves disk and memory but not time: on long texts the int8 files
were slower than fp32.

**Ranking by meaning.** `bench.mjs` holds 8 claims and 6 queries written to
share meaning but few words ("When do we ship?" for "The release is scheduled
for the first week of December."). All four model variants put the right claim
first for 6 of 6. `hash-256` managed 2 of 6 (`baseline.mjs`). This is a sanity
check on a hand-written set, not a retrieval benchmark.

Consequence: the Rust route removes both objections recorded in M3. Installed
cost is about 45 MB (addon plus MiniLM int8) or 56 MB (addon plus bge-small
int8) per platform, with no download on first run if the model ships in the
package.

**Not yet proven:**

- **Other platforms.** Only darwin-arm64 was built. Linux x64/arm64 and
  Windows x64 need a CI build matrix, and their speed is unmeasured.
- **Vectors against a reference.** The output was checked for self-consistency
  (int8 against fp32) and ranking, not against sentence-transformers.
- **Startup.** The 0.3–0.7 s load would be paid at every server start unless
  the model loads on first use.

To run it again: `npm run build:embedder -- all`, then
`node spikes/embed-rs/bench.mjs all-MiniLM-L6-v2 model_quantized.onnx mean`
(one model per process), and `npx tsx spikes/embed-rs/baseline.mjs` for
`hash-256`.

## E. The embedder as a per-platform npm package: passed on macOS arm64

Run on 2026-11-23 on the same machine. `scripts/pack-embedder.mjs` assembles
`vine-context-embedder-<os>-<arch>` from the built addon and the bge-small
int8 model; `scripts/pack-check.mjs` installs it beside the vine-context
tarball in an empty folder.

- **Size, darwin-arm64:** a 32.0 MB tarball; 56.3 MB installed (addon 21.6 MB,
  model 34.0 MB, tokenizer 0.7 MB).
- **Found without configuration.** From the clean install,
  `VINE_EMBEDDER=bge-small vine doctor` reported
  `bge-small-en-v1.5-int8 (384 dimensions, matches meaning)` with no
  `VINE_EMBEDDER_DIR`: vine resolved the package beside itself.
- **darwin-x64 cross-compiles** from this machine
  (`--target x86_64-apple-darwin`): a 25.9 MB addon. It was not run.
- **Without the package nothing changes.** The same clean install ran
  `hash-256` by default. Asking for a model that is not installed fails with
  how to install it (covered by a unit test, not by a clean install).

**Not yet proven:**

- **The `embedder` workflow has never run.** It is written for darwin-arm64,
  darwin-x64 (cross-compiled, run under Rosetta by an x64 Node), linux-x64,
  linux-arm64 and win32-x64, and each job runs the addon's tests and the clean
  install. Whether the runners have Rosetta, and whether tract builds on
  Windows and Linux arm64, is unknown until it runs on GitHub.
- **Publishing.** No package is on npm, and vine-context does not list them as
  optional dependencies yet (see Open in `docs/PLAN.md`).
- **musl Linux** (Alpine) has no package; it keeps `hash-256`.
