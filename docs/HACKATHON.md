# Vine Context and the Relate by Neo4j Hackathon

**Vine Context – P2P Shared Context Graphs**

Vine Context is an entry in the [Relate by Neo4j Hackathon](https://relate.devpost.com/) (theme: *Context, Connected*). This page is for judges: what to run, where to look, and the statements the rules ask for.

Back to the [README](../README.md).

## Judge it in five minutes

1. **Run it.** One command, with Node 20 or later. Nothing to install (npx fetches a copy), no account or API key, and it touches nothing of yours:

   ```bash
   npx vine-context demo
   ```

   Three members start in one process, join with codes, and replay the story (three colleagues planning the office Christmas party) through their own hosts, syncing peer to peer; the terminal narrates each step as it reaches the others. In the browser (alice's view): *Sharing console* for the three members and their links, *Explore the graph* to watch it grow, then drag the time slider back to replay it; *Conflicts* for the one the story ends with. `--pace 1` runs it faster.

   To use it with your own agent, `npx vine-context setup` installs the `vine` command and the plugin for Claude Code or Codex, printing each command before it runs it ([README](../README.md#setup-and-run)).
2. **Open the Relate store yourself.** It is a directory store that ships in the package and the repo, at [`examples/data/graphs/party`](../examples/data/graphs/party). `npx vine-context example /tmp/party` copies it out, and [Relate's CLI](https://relatedb.ai/docs/get-started/install/) opens the copy. [Eight queries to try](RELATE.md#explore-the-example-store), from *where did the team disagree?* to *what does the decision rest on, and does it still stand?*
3. **Read how Relate is used:** [README](../README.md#how-it-uses-relate) for the short form, [RELATE.md](RELATE.md) for each feature and its Cypher.
4. **Watch the demo video:** link to be added with the Devpost submission.

## The idea in one paragraph

Relate gives one agent a connected memory. Vine Context gives a team of agents the same one. Each person's agent keeps a full Relate graph of the team's claims and questions on its own machine, and the machines keep each other in step peer to peer, with no server. Because the graph records how statements relate (`SUPPORTS`, `CONTRADICTS`, `REPLACES`, `ANSWERS`) and when each was recorded, an agent can say what the team believes, where it disagrees and what is still open, now or as of any past moment, by following relationships instead of guessing.

## How it meets the judging criteria

The [rules](https://relate.devpost.com/rules) score five things. Here is what the entry offers under each, and where to see it.

### Relate and connected context (30 points)

The relationships do the answering. Each of these is a traversal, not a lookup, and because every node and relationship carries its time, each can be asked as of any past moment:

| Question | Relationships |
|---|---|
| What does the team believe? | Claims that no current claim `REPLACES` |
| Where does it disagree? | `CONTRADICTS` between two claims that are both current |
| What is still open? | Questions with no current claim that `ANSWERS` them |
| What does this decision rest on, and does that still stand? | `SUPPORTS` followed back any number of steps, each piece of evidence tested against `REPLACES`, `CONTRADICTS` and withdrawal |

The last one is the reason for a graph. In the example, the decision to book the Orangery is still current, but of the five things it rests on, one was replaced, one was withdrawn and one is contradicted by a claim nobody has answered. No single statement says so: only the paths do ([the query](RELATE.md#explore-the-example-store), or the `basis` tool).

Search is hybrid, vector plus full text, on Relate's own indexes. [RELATE.md](RELATE.md) lists each feature used, with its Cypher. The store is a directory any judge can open with the `relate` CLI.

### Functionality and completeness (25 points)

It works end to end: create, invite, join, record, link, search, sync, undo, withdraw, roles and removal. `vine demo` runs the whole path between three members in one process. There are over 180 automated tests, run in CI on Linux, macOS and Windows (`npm run check`). What has not been tested is said plainly under [Limits](HOW-IT-WORKS.md#limits).

### Usefulness (20 points)

The problem is the one most teams using AI agents have now: each person's sessions are a silo, and what one agent learns nobody else's sees. Findings get repeated, contradictions go unnoticed, and a week later nobody can say what the team believed when it made a call. A shared graph of claims and questions fixes that for any small group working on one problem, and each agent is told what a sync means for its person: your claim was replaced, your question was answered, a new conflict appeared. The [party example](../README.md#use-case) is a worked case: nothing technical, just three people who need to agree on a venue, a date and a budget.

### Documentation and reproducibility (15 points)

One page per audience: the [README](../README.md) to a first result in one command, the [guide](GUIDE.md) for day-to-day use, [RELATE.md](RELATE.md) for the graph and its queries, and [HOW-IT-WORKS.md](HOW-IT-WORKS.md) for the design. Every query in the docs runs as written against the store in the repo.

### Creativity (10 points)

An embedded database is one process on one machine. Vine Context keeps it that way and still gives a team one graph: every member has their own embedded Relate store, built from the same log of signed changes, so every copy is the same graph with no server between them. [How it works](HOW-IT-WORKS.md) explains the log, the mesh and the join codes, and [the replication design](REPLICATION.md) the decisions behind them.

## What agents get

- **Tools, not a query language.** Thirteen MCP tools defined by the model, each a fixed query with a row limit, beside thirteen for contexts, sharing and views. Agents never write Cypher, so they can't corrupt a graph that other people rely on ([tools](../models/temporal-claims/tools.yaml)).
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
- Variable-length paths, with a time test on every relationship in the path
- Transactions: `begin`, `commit`, `rollback`
- The `relate` CLI, to inspect the sample store

## Third-party tools

[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [MCP Apps (ext-apps)](https://github.com/modelcontextprotocol/ext-apps), [node-datachannel](https://github.com/murat-dogan/node-datachannel) (WebRTC), [nostr-tools](https://github.com/nbd-wtf/nostr-tools), React, @squonk/ui, zod, yaml, esbuild, tsup, vitest. Public Nostr relays and STUN servers carry connection handshakes only.

## AI tools

The code and documentation were written with the help of Claude Code (Anthropic's AI coding agent), directed and reviewed by the author. The product itself calls no AI service: search embeddings come from a small open sentence model (bge-small) run on the CPU, installed with vine, with a local hash of words as the fallback.

## What is new and what was reused

Everything in this repository was written during the contest period: the first commit is dated 15 Nov 2026.

It builds on the author's own earlier, private work in three ways:

- the idea of a Claims and Questions model, and notes on using Relate, came from an earlier proof of concept;
- some React components in [`apps/`](../apps) were adapted from the author's earlier UI work;
- the views in [`apps/`](../apps) are built on [@squonk/ui](https://ui.squonkstack.io), the author's own React component library, which predates the contest. It is used as a dependency, unchanged, and vendored in [`vendor/`](../vendor) because it is published to a private registry.

Work done during the contest: the embedded Relate graph and its model, the change log and replication, the peer-to-peer mesh and join codes, membership and roles, the MCP server and tools, the MCP Apps views, the Claude Code and Codex plugin, the example store and the tests.

## Submission checklist

- [x] Repository is public
- [x] `vine-context` is published to npm
- [x] GitHub topics `relate` and `relate-neo4j-hackathon`
- [x] Open-source licence (Apache-2.0)
- [x] README with setup instructions a judge can follow
- [x] A persistent Relate store in the repo
- [ ] Demo video, two minutes at most, viewable without a login
- [ ] Devpost entry, submitted before Fri 11 Dec 2026, 6:00 PM PST
