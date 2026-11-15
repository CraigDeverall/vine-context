# p2p-context-graph: root plan

Status: draft, 2026-11-15. This is the grounding plan for an open-source proof of
concept entered in the [Relate by Neo4j Hackathon](https://relate.devpost.com/).
Each milestone gets its own detailed plan; this file holds the decisions they
share.

## 1. What it is

**p2p-context-graph** is an AI skill plus a small local MCP server. Together they
let one person host a context graph on their own machine and share it, peer to
peer, with a few other people and their AI agents.

- The **host** (the person who starts it) runs a Relate graph and is the centre
  of a star network.
- The host shares a link (`p2pcg://join/<room>#<secret>`). Users B, C and D paste
  it into their agent, or click it, and their agent joins the star.
- Everyone's agent can then read and write the shared graph. They do it through
  tools that the graph's **context model** defines, not through raw Cypher.
- The context model can be chosen and authored. The project ships a default,
  the temporal **Claims and Questions** model, and the skill shows users how to
  design their own models: shapes, tools and instructions.
- **MCP Apps** give the host a console (session, link, joins, roles, model
  setup) and give everyone views of the graph.

No cloud service is involved. The graph lives on the host's disk. Traffic goes
peer to peer over WebRTC data channels, and the only infrastructure used is
public STUN and a signalling relay that sees encrypted handshakes only.

## 2. How we will be judged

The five criteria are weighted equally (Rules §5). Every milestone should move at
least one of them, and the demo should show all five.

| Criterion | What judges look for | How we answer it | Proof in the submission |
|---|---|---|---|
| **Creativity** | An original idea and approach | Agents on different machines share one graph peer to peer, with no server. The graph's *model* is a pluggable pack that the skill can help write. | The demo opens with two laptops and no cloud. |
| **Usefulness** | It solves a real problem | Teams' AI sessions are silos: what one person's agent learns, nobody else's sees. The shared graph keeps claims, questions and contradictions across people and over time. | A realistic scenario: three people investigating one problem. |
| **Completeness** | It works end to end from the setup instructions | One install command, one command to host, one to join. CI runs a two-peer test on every push. | A judge follows the README on a clean machine in under 5 minutes. |
| **Clarity** | The write-up, demo and visuals | A short README with a diagram, a 2-minute video, and MCP App screenshots. | Video ≤ 2 min, README "Quickstart" ≤ 10 lines. |
| **Effective use of connected context** | Use of Relate's graph, retrieval and agent features | Relate's graph model, hybrid search (vector + full-text with `COMBINE`), temporal queries ("what did we believe on 1 Dec?"), and Relate's MCP surface for the host's own agent. | Each Relate feature used is listed in the README with the query that uses it. |

### Submission checklist (Rules §3–4)

- [ ] Public GitHub repo, topic **`relate`** (required) and `relate-neo4j-hackathon`.
- [x] Open-source licence: Apache-2.0, the same as Relate.
- [ ] Title and description: what it does and why it is useful.
- [ ] Setup instructions a judge can run.
- [ ] A demo video of up to 2 minutes, made by us and viewable without a login, plus screenshots.
- [ ] A statement of the Relate capabilities, third-party tools and **AI tools** used.
- [ ] Disclosure of reused earlier code (see §3).
- [ ] Use Relate's name and logo only to identify the product; no implied endorsement.
- [ ] Submit before **Fri 11 Dec 2026, 6:00 PM PST** (Sat 12 Dec, 3:00 PM NZDT). Keep the repo public and tagged until winners are announced on 17 Dec.

## 3. Provenance and reused code

The rules require new work started on or after 11 Nov 2026. Reused earlier code
is allowed only if it's disclosed, and only contest-period work is judged.

Both earlier codebases are the author's own work, and the author keeps all
rights to them, including the right to open-source.

- **UI:** there's no external UI-library dependency. We copy in the React
  components we need from the author's own earlier work, or write new ones.
  They live in `apps/` under this repo's licence.
- **Earlier proof of concept:** we reuse its ideas, its Claims and Questions
  model and its Relate notes (no `close()`, `COMBINE` behind `RELATE_PREVIEW`,
  and so on). Any code we carry over is renamed for this project and uses
  example users only.
- **Disclosure in the submission:** "Builds on the author's earlier proof of
  concept and UI components from their own earlier work. Work done during the contest
  is the p2p network, model packs, skill, MCP Apps and …" Keep the list of what
  is new accurate, because only that is judged.

## 4. Architecture

```
                 ┌────────────────── Host (User A) ───────────────────┐
                 │  Claude Code / any MCP host                        │
                 │   └─ p2pcg MCP server (stdio)                      │
                 │        ├─ Model runtime  ── model pack (shapes,    │
                 │        │                    tools, instructions)   │
                 │        ├─ Relate store (embedded, @relate/relate)  │
                 │        ├─ Star hub (node-datachannel)              │
                 │        └─ MCP Apps: console, explorer, model setup │
                 └──────────────┬───────────────┬─────────────────────┘
                     WebRTC DC  │               │  WebRTC DC
                ┌───────────────┴──┐      ┌─────┴──────────────┐
                │ Peer B           │      │ Peer C             │
                │  p2pcg MCP (stdio)│      │  p2pcg MCP (stdio) │
                │  = proxy to host │      │  = proxy to host   │
                └──────────────────┘      └────────────────────┘
        Signalling: a public relay, keyed by room hash, carrying only encrypted SDP/ICE.
```

### 4.1 One package, two roles

The same `p2pcg` MCP server runs everywhere. As the **host** it owns the Relate
store and runs the model's tools. As a **peer** it advertises the same model
tools, which it learns from the host when it joins, and forwards every call over
the data channel. So a peer's agent sees exactly the tools the host's model
defines, with the same instructions.

### 4.2 Relate: embedded, plus Relate's own MCP for the host

Relate offers an embedded Node library (`@relate/relate`) and
`relate serve --mcp stdio|PORT`. Relate's MCP has three tools: `get_schema`,
`read_cypher` and `write_cypher`. It serves one store, has one shared token and
supports `--read-only`.

Decision:

- **The model's tools run on embedded Relate** inside the p2pcg server. That
  gives one process, prebuilt native packages from npm, and no extra binary to
  install. The POC proved it works.
- **Peers never get raw Cypher.** Relate's MCP has no per-caller identity or
  roles, so exposing `write_cypher` over P2P would let any peer rewrite the
  host's graph. Peers only get model tools, and the host checks each call
  against the caller's role.
- **The host's own agent can also attach Relate's MCP** (`relate serve --mcp
  stdio --read-only` against the same store, using Relate's live-follow
  read-only mode). It is for ad-hoc questions and for authoring models with
  `get_schema`. This also shows a second Relate surface to the judges. It is
  optional and needs the `relate` CLI; the skill offers to set it up.

Spike in M0: check that a `--read-only=live` follower works beside the embedded
writer on macOS and Linux. If it doesn't, the host can switch between the two
instead.

### 4.3 Context model packs

A model pack is a folder:

```
models/temporal-claims/
  model.yaml         labels, relationships, properties, constraints, indexes (vector, full-text)
  tools.yaml         named operations → parameterised Cypher, kind (read|write), minimum role, input schema
  instructions.md    what the agent should record, when, and how to query; loaded by the skill
  migrations/        numbered Cypher files, applied in order
  views/             optional MCP App view definitions
```

- The runtime turns `tools.yaml` into MCP tools with zod input schemas. Writes
  always stamp `recorded_at` and `recorded_by` (the peer's identity) on the
  server side. Callers can't set them.
- **Default pack: `temporal-claims`.** `Claim`, `Question`, `Source` and
  `Person`. Relationships are `SUPPORTS`, `CONTRADICTS`, `REPLACES`, `ANSWERS`,
  `ABOUT` and `CITES`. There are two kinds of time: *valid time* (`about_dates`,
  what the claim is about) and *record time* (`recorded_at`, when the graph
  learned it). Tools include `add_claim`, `ask_question`, `link`,
  `record_answer`, `search` (hybrid), `as_of` (the graph at a point in record
  time), and `conflicts`.
- **A second, small pack** (for example `decision-log` or `research-notes`)
  proves that models really are pluggable. It's not a stretch goal: judges
  should see two.
- **Authoring workflow in the skill:** interview the user about their domain,
  then draft `model.yaml` and `tools.yaml`, validate them against a scratch
  Relate store (`get_schema` round trip plus a smoke test of each tool), and
  install the pack. `p2pcg model validate <dir>` does the same from the CLI.

### 4.4 Peer to peer: the parts of the Gemini plan we adopt and drop

**Adopt:**

- Host-star topology over **node-datachannel** (libdatachannel, prebuilt N-API
  binaries).
- Default public STUN, with flags or config for custom STUN/TURN.
- Link `p2pcg://join/<roomId>#<secret>`. The fragment never leaves the joining
  machine. The room hash is used for signalling, and an HMAC challenge proves
  the secret over the data channel before any other frame is accepted.
- Typed frames on the channel: `control` (hello, auth, heartbeat, join/leave,
  roles, session-closed), `rpc` (tool call and result), and `event` (graph
  changed, so views update live).
- A graceful teardown broadcast. A stopped session fails fast for new joiners.

**Change:**

- **The graph is durable, the session is not.** Unlike the Gemini plan, the
  graph lives on the host's disk across sessions. Only the links, the peer list
  and the connections are temporary. A new session issues a new link.
- **No CRDT.** The host is the single writer and the authority, so there's no
  need for one. This removes a whole area of risk.
- **Identity:** each install has an Ed25519 key. The host sees "Bob (key
  ab12…) wants to join" in the console app and approves him as reader,
  contributor or admin. Approved keys can rejoin later sessions without asking
  again.

**Drop for the hackathon (could be added later):**

- The `proxy` channel (HTTP port tunnelling).
- Registering the `p2pcg://` scheme with the OS. Instead, the link works when
  pasted into an agent chat, because the skill recognises it. We could also
  offer an `https://` landing page that shows the link and the install command.
- Copy-paste-only signalling, which needs a manual round trip and is slow in a
  demo. We keep it as a fallback flag only if it costs little.

**Signalling relay:** we need a public, free, stateless relay that is
dependable on demo day. The candidates are Nostr relays (several, for
redundancy) or a public MQTT broker. Spike in M0 and choose by reliability. The
relay only ever sees ciphertext encrypted with a key derived from the secret.

**NAT reality:** STUN alone fails on symmetric NATs. For the demo, use two
networks we've tested. In the README, document `--turn` and say plainly that
TURN may be needed.

### 4.5 MCP Apps

| App | Who sees it | Purpose |
|---|---|---|
| **Host console** | Host | Start and stop a session, show the link and a QR code, approve joins, set roles, show peers online |
| **Graph explorer** | Everyone | An interactive graph of the current model, filtered by time ("as of"), and search |
| **Model studio** | Host | Pick, install or switch a model pack, view the schema, run validation, see the authoring wizard's output |
| **Receipt** | Everyone | What my agent just wrote, with undo (withdraw) |
| **Conflicts** | Everyone | Contradictions and disputed replacements, side by side |

The views use React with components that live in the repo, and are bundled into single-file HTML and served as MCP App resources.
Where a host doesn't support MCP Apps, the same views are served on
`localhost`.

### 4.6 Distribution

- One npm package, **`p2p-context-graph`** (free on npm and GitHub as of
  2026-11-15). Its bin is `p2pcg`, with `p2pcg mcp`, `p2pcg host`,
  `p2pcg join <link>` and `p2pcg model …`.
- The TypeScript is built and bundled with tsup or esbuild, and the MCP App UI
  is pre-built. The two native dependencies (`@relate/relate` platform packages
  and `node-datachannel`) stay as normal dependencies, because native code
  can't be bundled.
- The repo is also a Claude Code plugin marketplace: the skill, `.mcp.json`
  running `npx -y p2p-context-graph mcp`, and slash commands. `SKILL.md`
  follows the Agent Skills standard so other agents (Cursor, Codex, Gemini CLI)
  can use it.
- Supported platforms: macOS arm64, Linux x64, and Windows x64 if
  `node-datachannel` and Relate both ship prebuilt binaries for it.

## 5. Repository layout

```
p2p-context-graph/
  .claude-plugin/marketplace.json
  plugin/                 skill (SKILL.md + references), commands, .mcp.json
  src/
    core/                 relate store, model runtime, roles, identity
    p2p/                  hub, peer, signalling, frames, link codec
    mcp/                  MCP server (host + peer modes), app resources
    cli/                  p2pcg CLI
  models/temporal-claims/ default model pack
  models/decision-log/    second sample pack
  apps/                   MCP App views (React, in-repo components), built to single HTML files
  test/                   unit tests + two-peer and three-peer integration tests
  docs/                   PLAN.md, architecture, model-pack spec, demo script
  LICENSE  README.md  CONTRIBUTING.md
  .github/workflows/ci.yml
```

CI is GitHub Actions, because it's a public GitHub repo: lint, typecheck, unit
tests, and a two-peer loopback test on Linux and macOS.

## 6. Milestones

Today is Sun 15 Nov. The deadline is Fri 11 Dec (Sat 12 Dec morning in New
Zealand time).

| # | Dates | Outcome | Done when |
|---|---|---|---|
| **M0 Bootstrap & spikes** | 15–18 Nov | The repo exists, and the three spikes are answered: (a) node-datachannel connects two machines through the chosen relay, (b) the Relate live read-only follower works, (c) embedded Relate works from the bundled build | Spike notes in `docs/spikes.md`, the repo public with its topics, CI green |
| **M1 Single-player graph** | 19–24 Nov | The `temporal-claims` pack, model runtime, MCP tools and skill work for one user | Claude records and queries claims and questions, and `as_of` and hybrid search work |
| **M2 Star network** | 25 Nov–1 Dec | Host, join link, auth, roles, forwarded tools and live events | Three agents on two machines share one graph, and the integration test runs in CI |
| **M3 Apps & custom models** | 2–6 Dec | Host console, explorer, model studio and receipt; the second pack; the authoring workflow | A new model pack written with the skill's help works for all peers |
| **M4 Ship** | 7–10 Dec | README, diagrams, a test on a clean machine, the npm publish, the video, the submission text | The checklist in §2 is all ticked |
| Buffer | 11 Dec | Fixes only | Submitted by 11 Dec, 6:00 PM PST |

Cut order if we're late: model studio UI (keep the CLI and skill authoring) →
conflicts view → Windows → QR code. Never cut: the two-machine demo, the second
model pack, setup instructions.

**M1's one-process limit is fixed in M2.** Each graph has one host process
that owns the store, and every session's MCP server is a client of it over a
local socket. Relate's writer lease and the missing `close()` in
`@relate/relate` 1.0.1 no longer matter.

**M2 status (2026-11-15):** the star works between processes on one machine
over the public relays. That covers the host, link, approval, roles,
forwarded tools and events. It is covered by in-process tests on real
loopback data channels. **Still to do for M2's "done when":** a second
machine on a different network, and a case that needs TURN.

## 7. Demo (≤ 2 minutes)

1. 0:00. The problem: three people, three AI sessions, nothing shared.
2. 0:15. Alice: "share our context graph". The console app shows the link.
3. 0:30. Bob pastes the link on another laptop, Alice approves him, and he's in.
4. 0:45. Bob's agent records a claim. It appears live in Alice's explorer.
5. 1:00. Carol's agent records a contradicting claim, and the conflicts view
   flags it.
6. 1:15. "What did we believe on Tuesday?": `as_of` plus hybrid search on Relate.
7. 1:30. Model studio: switch to `decision-log`, or show the skill drafting a
   new pack.
8. 1:50. Closing: no server, the graph stays on Alice's machine, open source.

## 8. Risks

| Risk | Mitigation |
|---|---|
| NAT traversal fails on demo networks | Test the exact networks in M2, document TURN, and keep a recorded fallback |
| The public signalling relay is flaky | Use several relays, retry, and choose by the M0 spike |
| Relate 1.0 is experimental (Rules §3) | Pin the version, keep the engine behind one interface, and note the limits in the README |
| Native prebuilds are missing on a judge's platform | State the supported platforms, and test `npx` on a clean macOS and Linux machine |
| MCP Apps aren't supported in the judge's agent | Serve the same views on `localhost` |
| Reused code is judged as new | §3: a clear list of what's new in the submission, and commit history from 11 Nov onwards |
| Scope creep (port tunnelling, CRDTs, OS URI) | They are dropped in §4.4 |

## 9. Decisions

Decided:

- **Licence:** Apache-2.0. It matches Relate and grants patent rights explicitly.
- **GitHub owner:** the author's personal account.
- **UI:** components are copied in or written in the repo, with no external UI
  library.
- **Signalling:** Nostr ephemeral events through our own minimal relay client
  (see [spikes.md](spikes.md)). nostr-tools is used only for signing.
- **npm:** the unscoped `p2p-context-graph` package.

Open:

1. **A semantic embedder.** M1 ships a hashing embedder (offline, no download,
   word and fragment matches only) behind an `Embedder` interface. A local
   MiniLM through transformers.js would make search match meaning, but it adds
   about 100 MB of native dependencies. Decide in M3.
2. The second model pack: `decision-log` or `research-notes`.
