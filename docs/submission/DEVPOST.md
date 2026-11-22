# Devpost entry: draft text

Ready to paste into the [Devpost](https://relate.devpost.com/) submission form. Check each line marked **Confirm** before submitting.

## Project name

Vine Context

## Tagline

Three lengths. Devpost's tagline field is short, so the first is the default.

- **Short:** Shared memory for a team's AI agents: one Relate graph, peer to peer, no server.
- **Medium:** Your team's AI agents each learn things the others never see. Vine Context gives them one shared Relate graph of claims and questions, synced peer to peer.
- **Echoing the theme:** Context, connected, between people.

## About the project

### Inspiration

When three people investigate the same problem, each with their own AI agent, each agent learns things the other two never see. Findings get repeated. Two people reach opposite conclusions and nobody notices. A week later, nobody can say what the team believed when it made the call.

Relate gives one agent a connected memory that lives inside the app, with no server. I wanted to know whether a whole team of agents could share one, and still have no server.

### What it does

Vine Context gives a small team one shared **context graph** of claims and questions.

- One person creates a context and sends each teammate a join code.
- Each teammate pastes it into their agent (Claude Code, Codex or another MCP agent) and gets a full copy of the graph on their own machine.
- Every agent reads and writes its own copy. The machines swap what each is missing whenever they are online, directly, over WebRTC.
- It keeps working offline, and when the person who created it is away.

What connects to what:

- A **claim** `SUPPORTS`, `CONTRADICTS` or `REPLACES` another claim.
- A claim `ANSWERS` a **question**. A question is `ABOUT` a claim.
- Every node and relationship records who recorded it and when.

Those relationships are the answers to what a team actually asks:

- *What do we believe now?* Claims that nothing has replaced.
- *Where do we disagree?* `CONTRADICTS` between two claims that are both current.
- *What is still open?* Questions with no claim that answers them.
- *What did we believe on Tuesday?* The same reads, as of Tuesday.

After each sync, every agent is told what the changes mean for its person: your claim was replaced, your question was answered, a new conflict appeared.

### How I built it

- **Relate, embedded, in directory mode.** Each context is one Relate directory store inside a Node process. A shared context outlives every agent session, so it needs a durable store, and a directory can be opened with Relate's own CLI.
- **The graph is built from a log of signed changes.** Every member applies the same changes to their own Relate store. Applying is order-independent, so every machine ends up with the same graph.
- **Relate features in use:** uniqueness constraints, a vector index and a full-text index, hybrid search with `SEARCH … COMBINE`, temporal values with `EXISTS {}` subqueries for the "as of" reads, pattern comprehensions, and a transaction around every read and every applied change.
- **Peer to peer:** WebRTC data channels between members, with public Nostr relays carrying sealed handshakes only. Join codes are single use.
- **For agents:** an MCP server with twelve model tools (agents never write Cypher), a plugin for Claude Code and Codex with skills and a join command, and four MCP Apps views that show in the chat.
- **A sample store in the repo:** three people investigating a checkout slowdown, with queries to run on it.

### Challenges

- **The first design was a star, and it failed in real use.** One host held the only copy, so when that person closed their laptop nobody could read or write. I replaced it with full copies on every machine and a change log, which meant making every change safe to apply twice and in any order.
- **Undo across machines.** Once a change has been sent it can't be unsent. Writes now wait 10 seconds on the author's machine, so Undo truly removes a slip, and after that an item can only be withdrawn, which keeps the history honest.
- **Connections that drop without telling you.** Relay connections went quiet silently. Links and relays are now pinged and replaced.
- **Keeping agents from damaging a shared graph.** Agents get tools with fixed queries, not Cypher, and a write is only checked by the tool: fixed code applies it the same way everywhere.

**Confirm:** these are taken from the project's design notes. Reword in your own voice.

### Accomplishments I'm proud of

- A judge can run two commands and see a real graph with a time slider, with no account, API key or model download.
- The example store opens in Relate's own CLI, and one Cypher query shows what the team believed at any minute of the incident.
- It was used to coordinate its own development.

**Confirm:** the last line is only true if you did. Remove it otherwise.

### What I learned

- Relationships with timestamps are a small idea that does a lot: "current", "conflicting" and "open" are all short traversals once every link records when it was made.
- An embedded database makes a peer-to-peer design simple. There is nothing to deploy, so "every member has a full copy" is just one directory per person.
- Agents write much better shared notes when told to search first, link instead of duplicate, and never settle a disagreement themselves.

### What's next

- A semantic search embedder published per platform.
- An optional gateway you own, so phones and assistants that only reach remote MCP servers can join.

## Built with

`relate` `neo4j` `cypher` `typescript` `node.js` `mcp` `mcp-apps` `webrtc` `nostr` `preact` `claude-code` `codex`

## Try it out

- GitHub: https://github.com/CraigDeverall/vine-context
- Video: **Confirm:** add the link

## Statements the rules ask for

**Relate capabilities used.** Embedded use from Node in directory mode, uniqueness constraints, vector and full-text indexes, hybrid retrieval (`SEARCH … COMBINE`, the `hybrid-search` preview), temporal values, `EXISTS {}` subqueries, pattern comprehensions, transactions, and the `relate` CLI to inspect the sample store.

**Third-party tools.** MCP TypeScript SDK, MCP Apps (ext-apps), node-datachannel, nostr-tools, Preact, zod, yaml, esbuild, tsup, vitest. Public Nostr relays and STUN servers for connection handshakes.

**AI tools.** Written with the help of Claude Code (Anthropic's AI coding agent), directed and reviewed by me. The product itself calls no AI model.

**Earlier work reused.** Everything in the repository was written during the contest period (first commit 15 Nov 2026). The Claims and Questions idea and some notes on Relate came from my own earlier proof of concept, and some React components were adapted from my own earlier UI work.

**Confirm:** this matches `docs/PLAN.md` section 3. Check it is still accurate and complete.

## Before submitting

- [ ] Make the repository public. It is private as of 23 Nov 2026.
- [ ] Publish `vine-context` to npm. The README's install steps assume it, and it is not published as of 23 Nov 2026.
- [ ] Topics `relate` and `relate-neo4j-hackathon` are set (they are).
- [ ] Video uploaded, two minutes at most, viewable without a login.
- [ ] Video link added to the README and to `docs/HACKATHON.md`.
- [ ] Two or three screenshots: the explorer with the time slider, the conflicts view, the Claude Code panel.
- [ ] Submitted before Fri 11 Dec 2026, 6:00 PM PST (Sat 12 Dec, 3:00 PM NZDT).
