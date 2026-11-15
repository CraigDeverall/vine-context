# p2p-context-graph

Share a [Relate](https://github.com/relatedb/relate) context graph with other
people's AI agents, peer to peer.

One person hosts the graph on their own machine and shares a link. Anyone who
opens that link in their AI agent joins a star network around the host. From
then on, every agent reads and writes the same graph through tools defined by
the graph's **context model**. The default model is temporal Claims and
Questions, and you can write your own.

No cloud service is involved. The graph stays on the host's disk, and traffic
travels over encrypted WebRTC data channels.

> **Status:** early proof of concept, built for the
> [Relate by Neo4j Hackathon](https://relate.devpost.com/). Sharing works
> between machines that WebRTC can connect. MCP Apps are next. See
> [docs/PLAN.md](docs/PLAN.md).

## Try it (from source, single player)

Needs Node 20 or later. Tested on macOS arm64, and on Linux x64 and macOS in CI.

```bash
git clone https://github.com/CraigDeverall/p2p-context-graph && cd p2p-context-graph
npm install && npm run build
node dist/cli.js doctor
claude mcp add p2p-context-graph -- node "$PWD/dist/cli.js" mcp
```

Then ask Claude Code something like *"record in the context graph that the
nightly WAN drop lasts 6 minutes"* or *"what open questions are in the
graph?"*.

## Share it

1. **You:** ask your agent to *"share the context graph"*. It calls
   `share_graph` and gives you a `p2pcg://join/…` link. Send the link
   privately.
2. **Them:** paste the link into their agent. It calls `join_graph`, and they
   see their name and a key fingerprint.
3. **You:** check the fingerprint with them, then *"approve bob as a
   contributor"* (`approve_peer`). Their graph tools now act on your graph,
   limited by their role: reader, contributor or admin.

Approved people rejoin later sessions without asking again.
`sharing_status`, `set_peer_role`, `remove_peer` and `stop_sharing` manage
the rest, and `leave_graph` takes a peer back to their own graph.

How it works:

- **Your machine runs one host process per graph** (`p2pcg host`, started
  automatically). It owns the Relate store. Every agent session on your
  machine is a client of it over a local socket, so several sessions share one
  graph.
- **The host is the centre of a star.** Peers connect to it directly over
  WebRTC data channels (DTLS-encrypted). Only the connection handshake goes
  through public Nostr relays, sealed with a key from the link's secret, which
  stays after the `#` and is never sent anywhere. Joining needs both the
  secret (an HMAC proof) and an Ed25519 identity key.
- **Peers only get the model's tools.** They never get raw Cypher or the
  host's admin operations, and the host checks every call against the
  caller's role.

If two machines can't connect (some networks block direct connections), set a
TURN server with `P2PCG_ICE=turn:user:pass@host:3478`.

## Context models

A graph's **model pack** defines its node types, relationships and tools:
parameterised Cypher, validated inputs, and instructions for agents. The
built-in `temporal-claims` pack records dated claims that support,
contradict, replace and answer each other, plus open questions. Every read
tool can answer *as of* any past moment.

Write your own model with the help of the skill, or by hand. The format is in
[plugin/skills/p2p-context-graph/references/model-packs.md](plugin/skills/p2p-context-graph/references/model-packs.md).
Check a pack with `p2pcg model validate <dir>`.

## Relate features used

| Feature | Where |
|---|---|
| Embedded store (`@relate/relate`, Node via the C ABI) | every graph: one directory store per graph |
| Uniqueness constraints | each node type's `key` |
| Vector index + full-text index across labels | `search` in `model.yaml` |
| Hybrid search, `SEARCH … COMBINE … USING WRRF` (preview `hybrid-search`) | the `search` tool |
| Temporal types and `EXISTS {}` subqueries | the *as of* reads: `beliefs`, `open_questions`, `conflicts` |
| Transactions (`begin`/`commit`/`rollback`) | every tool call is one transaction |

## Licence

[Apache-2.0](LICENSE). Relate is a Neo4j Labs project, also under Apache-2.0.
This project is not affiliated with or endorsed by Neo4j.
