# Vine Context and the Relate by Neo4j Hackathon

Vine Context is an entry in the [Relate by Neo4j Hackathon](https://relate.devpost.com/) (theme: *Context, Connected*). This page is for judges: what to run, where to look, and the statements the rules ask for.

Back to the [README](../README.md).

## Judge it in five minutes

1. **Run it.** Two commands, no account or API key ([README](../README.md#setup-and-run)):

   ```bash
   npm install -g vine-context
   ```

   ```bash
   vine demo
   ```

   In the browser: open *Explore the graph* and drag the time slider back to 10 Nov.
2. **Open the Relate store yourself.** It is a directory store that ships in the package and the repo, at [`examples/data/graphs/incident`](../examples/data/graphs/incident). [Six queries to try](RELATE.md#explore-the-example-store), from *where did the team disagree?* to *what did they believe at 3:15 pm?*
3. **Read how Relate is used:** [README](../README.md#how-it-uses-relate) for the short form, [RELATE.md](RELATE.md) for each feature and its Cypher.
4. **Watch the demo video:** link to be added with the Devpost submission.

## The idea in one paragraph

Relate gives one agent a connected memory. Vine Context gives a team of agents the same one. Each person's agent keeps a full Relate graph of the team's claims and questions on its own machine, and the machines keep each other in step peer to peer, with no server. Because the graph records how statements relate (`SUPPORTS`, `CONTRADICTS`, `REPLACES`, `ANSWERS`) and when each was recorded, an agent can say what the team believes, where it disagrees and what is still open, now or as of any past moment, by following relationships instead of guessing.

## Against the judging criteria

The [official rules](https://relate.devpost.com/rules) list five criteria, weighted equally. The [announcement](https://neo4j.com/blog/graph-database/announcing-the-relate-by-neo4j-hackathon-2026-build-ai-agents-on-an-embedded-graph-database/) adds a sixth, on AI and agentic capabilities.

| Criterion | What Vine Context offers | Where to see it |
|---|---|---|
| **Creativity** | An embedded database is one process on one machine. Here every teammate has their own embedded Relate store, and a log of signed changes makes them all the same graph, with no server in between | [How it works](HOW-IT-WORKS.md) |
| **Usefulness** | Teams' AI sessions are silos: what one person's agent learns, nobody else's sees. A shared graph of claims and questions fixes that for any small group working on one problem | [Use case](../README.md#use-case); the incident example |
| **Completeness** | Create, invite, join, record, link, search, sync, undo, withdraw, roles and removal all work end to end. 70 automated tests, and CI on Linux, macOS and Windows | [Guide](GUIDE.md); `npm test` |
| **Clarity** | A README that reaches a first result in two commands, a sample store with queries, and a page per audience | [README](../README.md#more-documentation) |
| **Effective use of connected context** | The relationships are the answers: current beliefs, conflicts, open questions and evidence chains are each a traversal. Hybrid search (vector plus full text), temporal reads and transactions all run on Relate | [RELATE.md](RELATE.md) |
| **AI and agentic capabilities** | See the next section | |

## What agents get

- **Tools, not a query language.** Twelve MCP tools defined by the model, each with a row limit. Agents never write Cypher, so they can't corrupt a graph that other people rely on ([tools](../models/temporal-claims/tools.yaml)).
- **Guidance on writing for others:** search before adding, link instead of duplicating, flag a contradiction but never decide who is right ([instructions](../models/temporal-claims/instructions.md)).
- **Skills and a command.** A plugin for Claude Code and Codex with two skills and `/vine-context:join` ([plugin](../plugin)).
- **A briefing on joining,** so a new member's agent starts with the open questions, the conflicts and the latest.
- **A digest after every sync,** which tells each agent what others' changes mean for its person: your claim was replaced, your question was answered, a new conflict appeared.
- **Many agents, one graph.** Several sessions on one machine share one host, and every applied change is one Relate transaction. Across machines, changes merge without overwriting each other.
- **Views in the chat.** Four MCP Apps views, and in Claude Code a live panel beside the chat. The views hand actions to the agent rather than writing to the graph themselves.

## Relate capabilities used

- Embedded use from Node (`@relate/relate` 1.0.1), in **directory mode**
- Uniqueness constraints
- A vector index and a full-text index across two labels
- Hybrid retrieval: `SEARCH … COMBINE (VECTOR …, FULLTEXT …) USING WRRF` (the `hybrid-search` preview)
- Temporal values, `EXISTS {}` subqueries and pattern comprehensions
- Transactions: `begin`, `commit`, `rollback`
- The `relate` CLI, to inspect the sample store

## Third-party tools

[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [MCP Apps (ext-apps)](https://github.com/modelcontextprotocol/ext-apps), [node-datachannel](https://github.com/murat-dogan/node-datachannel) (WebRTC), [nostr-tools](https://github.com/nbd-wtf/nostr-tools), Preact, zod, yaml, esbuild, tsup, vitest. Public Nostr relays and STUN servers carry connection handshakes only.

## AI tools

The code and documentation were written with the help of Claude Code (Anthropic's AI coding agent), directed and reviewed by the author. The product itself calls no AI service: search embeddings come from a small open sentence model (bge-small) run on the CPU, installed with vine, with a local hash of words as the fallback.

## What is new, and what was reused

Everything in this repository was written during the contest period: the first commit is dated 15 Nov 2026.

It builds on the author's own earlier, private work in two ways:

- the idea of a Claims and Questions model, and notes on using Relate, came from an earlier proof of concept;
- some React components in [`apps/`](../apps) were adapted from the author's earlier UI work.

Work done during the contest: the embedded Relate graph and its model, the change log and replication, the peer-to-peer mesh and join codes, membership and roles, the MCP server and tools, the MCP Apps views, the Claude Code and Codex plugin, the example store and the tests.

## Submission checklist

- [ ] Repository is public
- [ ] `vine-context` is published to npm (the README's install steps depend on it)
- [x] GitHub topics `relate` and `relate-neo4j-hackathon`
- [x] Open-source licence (Apache-2.0)
- [x] README with setup instructions a judge can follow
- [x] A persistent Relate store in the repo
- [ ] Demo video, two minutes at most, viewable without a login
- [ ] Devpost entry, submitted before Fri 11 Dec 2026, 6:00 PM PST
