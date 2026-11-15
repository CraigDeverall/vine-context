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
`npx p2p-context-graph`. That will come with a `p2pcg doctor` command that
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
attach Relate's MCP read-only, alongside p2pcg, with no writer contention. It
needs the `relate` CLI installed, so it stays optional.

## A. Host-star over node-datachannel with Nostr signalling: passed locally

`spikes/p2p-star.ts` and `spikes/nostr-lite.ts`. One host and two peers, as
three processes on one Mac, signalling through public Nostr relays:

- The link format is `p2pcg://join/<room>#<secret>`. Signalling events are
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
   relays, configurable with `P2PCG_RELAYS`.
3. Waiting for every relay to acknowledge added about 3 s per handshake.
   Resolving on the first acceptance fixed it.

**Not yet proven:**

- **Across machines and NAT.** The local run used host candidates. We still
  need two machines on different networks (for example a laptop on a phone
  hotspot) to show srflx traversal, and a case that needs TURN.
- **Linux x64 prebuilds** for node-datachannel and Relate. The ubuntu job in
  CI covers this once the repo is on GitHub.

Both are carried into M2's "done when".
