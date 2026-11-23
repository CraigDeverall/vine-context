# vine-context: root plan

> **Superseded in part (2026-11-17):** the star is replaced by replicated
> graphs (every member keeps a full copy, synced over a mesh), Claims and
> Questions is the only model (`decision-log`, model packs and the model
> studio are gone), and joined graphs are local graphs. See
> [REPLICATION.md](REPLICATION.md) and the decision at the end of section 9.
> The rest of this plan is kept as the record of how the project got here.
>
> **The outcome wanted (2026-11-21):** easy setup and use on any device with
> any assistant. See [section 10](#10-target-any-device-any-assistant); it
> replaces the platform list in section 4.6.

Status: draft, 2026-11-15. This is the grounding plan for an open-source proof of
concept entered in the [Relate by Neo4j Hackathon](https://relate.devpost.com/).
Each milestone gets its own detailed plan; this file holds the decisions they
share.

## 1. What it is

**Vine Context** is an AI skill plus a small local MCP server. Together they
let one person host a context graph on their own machine and share it, peer to
peer, with a few other people and their AI agents.

- The **host** (the person who starts it) runs a Relate graph and is the centre
  of a star network.
- The host sends each person a join code (`vine1_<room>.<secret>`). Users B, C and D paste
  it into their agent, or runs `/vine-context:join <code>`, and their agent joins the star.
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

The published rubric (devpost "Judging Criteria", 100 points). Every milestone
should move at least one criterion, and the demo should show all five. Judges
must be able to clone, run and see the graph without asking us anything.

| Criterion | Points | What judges look for | How we answer it | Proof in the submission |
|---|---|---|---|---|
| **Relate and connected context** | 30 | Relate's relationships carry the main use case; judges can follow the instructions, run it, and explore with Relate working as described | Relationships *are* the answers: SUPPORTS/CONTRADICTS/REPLACES give `beliefs` and `conflicts`; RESTS_ON/DEPENDS_ON/SUPERSEDES give `needs_review`. Hybrid search (`COMBINE` vector + full-text), record-time queries ("what did we believe on 1 Dec?"), the explorer's time slider, and a persistent directory store judges can open with Relate's own CLI | README "How it uses Relate" lists each feature with the query that uses it; a sample store in the repo |
| **Functionality and completeness** | 25 | How much of the core use case works | Host, share, join codes, join notices, roles, two model packs, five views, the localhost page; CI on every push | A judge reaches a first result from the README in under 5 minutes |
| **Usefulness** | 20 | A real problem for a clear user, and the project shows it | Teams' AI sessions are silos: what one person's agent learns, nobody else's sees. The shared graph keeps claims, questions, decisions and contradictions across people and over time | A realistic scenario in the video: people investigating one incident |
| **Documentation and reproducibility** | 15 | The README explains the project and how to try it | The devpost README template, followed section by section; one install command; `doctor`; no account, API key or model download | README Quickstart ≤ 10 lines |
| **Creativity** | 10 | A fresh idea or an inventive use of Relate | Agents on different machines share one embedded graph peer to peer, with no server; the graph's model is a pluggable pack the skill helps write | The demo opens with two machines and no cloud |

### Submission checklist (devpost rules and "Requirements")

- [ ] Public GitHub repo, topic **`relate`** (required: it's how entries are found) and `relate-neo4j-hackathon`.
- [x] Open-source licence: Apache-2.0, the same as Relate.
- [ ] Project description on devpost: the use case, and what connects to what.
- [ ] README following the template: one-line pitch; Use case (which relationships matter); How it uses Relate (**mode: directory**, why, what the graph models); Setup and run; Where the data lives (path to the store in the repo).
- [ ] **A persistent Relate store in the repo** (a directory judges can inspect, e.g. `examples/incident-graph/`), made by a script from the demo scenario, plus how to open it with the `relate` CLI.
- [ ] Working code with Relate actually running (not prompts only).
- [ ] A demo video of 1–2 minutes, made by us and viewable without a login, plus screenshots.
- [ ] A statement of the Relate capabilities, third-party tools and **AI tools** used.
- [ ] Disclosure of reused earlier code (see §3).
- [ ] Use Relate's name and logo only to identify the product; no implied endorsement.
- [ ] Submit before **Fri 11 Dec 2026, 6:00 PM PST** (Sat 12 Dec, 3:00 PM NZDT). Keep the repo public and tagged until winners are announced on 17 Dec.

Links: [relatedb.ai](https://relatedb.ai/), [install](https://relatedb.ai/docs/get-started/install/), [github.com/relatedb/relate](https://github.com/relatedb/relate), [relate-ideas](https://github.com/jexp/relate-ideas).

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
                 │   └─ vine MCP server (stdio)                      │
                 │        ├─ Model runtime  ── model pack (shapes,    │
                 │        │                    tools, instructions)   │
                 │        ├─ Relate store (embedded, @relate/relate)  │
                 │        ├─ Star hub (node-datachannel)              │
                 │        └─ MCP Apps: console, explorer, model setup │
                 └──────────────┬───────────────┬─────────────────────┘
                     WebRTC DC  │               │  WebRTC DC
                ┌───────────────┴──┐      ┌─────┴──────────────┐
                │ Peer B           │      │ Peer C             │
                │  vine MCP (stdio)│      │  vine MCP (stdio) │
                │  = proxy to host │      │  = proxy to host   │
                └──────────────────┘      └────────────────────┘
        Signalling: a public relay, keyed by room hash, carrying only encrypted SDP/ICE.
```

### 4.1 One package, two roles

The same `vine` MCP server runs everywhere. As the **host** it owns the Relate
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

- **The model's tools run on embedded Relate** inside the vine server. That
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
  install the pack. `vine model validate <dir>` does the same from the CLI.

### 4.4 Peer to peer: the parts of the Gemini plan we adopt and drop

**Adopt:**

- Host-star topology over **node-datachannel** (libdatachannel, prebuilt N-API
  binaries).
- Default public STUN, with flags or config for custom STUN/TURN.
- Join code `vine1_<room>.<secret>`, one per invite (this replaced the
  single reusable `vine://join/<room>#<secret>` link on 16 Nov). The secret
  never leaves the two machines. The room hash is used for signalling, and an
  HMAC challenge proves the secret over the data channel before any other
  frame is accepted.
- Typed frames on the channel: `control` (hello, auth, heartbeat, join/leave,
  roles, session-closed), `rpc` (tool call and result), and `event` (graph
  changed, so views update live).
- A graceful teardown broadcast. A stopped session fails fast for new joiners.

**Change:**

- **The graph is durable, the session is not.** Unlike the Gemini plan, the
  graph lives on the host's disk across sessions, and so do the invites and
  the people who joined. Only the connections are temporary.
- **No CRDT.** The host is the single writer and the authority, so there's no
  need for one. This removes a whole area of risk.
- **Identity:** each install has an Ed25519 key. The first key to use a
  join code is let in at once with the invite's role, and the code is bound to
  it: the same machine rejoins with it later, and any other key using it is
  turned away. Everyone in the graph is told who joined (name, fingerprint,
  invite, agent, operating system). An unused code expires (24 h by default).
  We dropped the approval step and the fingerprint check on 16 Nov: people
  would compare fingerprints over the same channel the code went through,
  which adds friction and little safety once codes are single-use.

**Drop for the hackathon (could be added later):**

- The `proxy` channel (HTTP port tunnelling).
- Registering a URL scheme, or an `https://` landing page. A code gets pasted
  into an agent anyway, so a clickable link saves no steps. The code works
  pasted into any agent chat, and with `/vine-context:join <code>`.
- Short code words (`vine2_`), which need a password-authenticated key
  exchange.
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
| **Host console** | Host | Start and stop a session, show join codes, show who joined, set roles, show peers online |
| **Graph explorer** | Everyone | An interactive graph of the current model, filtered by time ("as of"), and search |
| **Model studio** | Host | Pick, install or switch a model pack, view the schema, run validation, see the authoring wizard's output |
| **Receipt** | Everyone | What my agent just wrote, with undo (withdraw) |
| **Conflicts** | Everyone | Contradictions and disputed replacements, side by side |

The views use React with components that live in the repo, and are bundled into single-file HTML and served as MCP App resources.
Where a host doesn't support MCP Apps, the same views are served on
`localhost`.

### 4.6 Distribution

- One npm package, **`vine-context`** (free on npm and GitHub as of
  2026-11-15). Its bin is `vine`, with `vine mcp`, `vine host`,
  `vine join <link>` and `vine model …`.
- The TypeScript is built and bundled with tsup or esbuild, and the MCP App UI
  is pre-built. The two native dependencies (`@relate/relate` platform packages
  and `node-datachannel`) stay as normal dependencies, because native code
  can't be bundled.
- The repo is also a Claude Code plugin marketplace: the skill, `.mcp.json`
  running `npx -y vine-context mcp`, and slash commands. `SKILL.md`
  follows the Agent Skills standard so other agents (Cursor, Codex, Gemini CLI)
  can use it.
- Supported platforms: macOS arm64, Linux x64, and Windows x64 if
  `node-datachannel` and Relate both ship prebuilt binaries for it.

## 5. Repository layout

```
vine-context/
  .claude-plugin/marketplace.json
  plugin/                 skill (SKILL.md + references), commands, .mcp.json
  src/
    core/                 relate store, model runtime, roles, identity
    p2p/                  hub, peer, signalling, frames, link codec
    mcp/                  MCP server (host + peer modes), app resources
    cli/                  vine CLI
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
over the public relays. That covers the host, join codes, join notices, roles,
forwarded tools and events. It is covered by in-process tests on real
loopback data channels. **Still to do for M2's "done when":** a second
machine on a different network, and a case that needs TURN.

## 7. Demo (≤ 2 minutes)

1. 0:00. The problem: three people, three AI sessions, nothing shared.
2. 0:15. Alice: "share our context graph". The console app shows the link.
3. 0:30. Bob pastes the code on another laptop and is in at once; Alice's agent tells her who joined.
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
- **npm:** the unscoped `vine-context` package.

Open:

- Publishing the semantic embedder's platform packages, and whether it then
  becomes the default. To publish: run the `embedder` workflow, check all five
  jobs, `npm publish` each `vine-context-embedder-<os>-<arch>` tarball from its
  artifact, then add the five to `optionalDependencies` at the same version
  and update the lockfile. The dependency lines wait until the names are ours
  on npm: an unpublished name anyone can register would be installed on every
  user's machine.
- To make it the default afterwards: `makeEmbedder` picks the model when its
  package is installed and `hash-256` otherwise; the first open of each graph
  then re-embeds, which wants a progress line; and the hybrid search needs its
  full-text half tuned first (a match on a common word such as "we" outranks
  the best match by meaning).

Decided after M4 (22 Nov):

- **Semantic embedder, opt-in:** `VINE_EMBEDDER=bge-small` (or `minilm`) runs a
  small sentence model on the CPU through a Rust addon (`native/embedder`,
  tract, no onnxruntime), built locally with `npm run build:embedder`. Spike D
  in `docs/spikes.md` has the sizes and timings. `hash-256` stays the default
  and the fallback. A graph opened with a different embedder rebuilds its
  vectors from the text on that machine; nothing is synced.
- **Embedder packaging:** one npm package per platform,
  `vine-context-embedder-<os>-<arch>`, holding the addon and the bge-small
  model (`scripts/pack-embedder.mjs`), limited by `os` and `cpu` (and glibc on
  Linux). Vine looks for it beside itself before a checkout's own build. The
  `embedder` workflow builds, runs and packs it for all five platforms and
  does not publish. MiniLM stays build-from-source.

Decided in M3 (16 Nov):

- **Embedder:** keep the offline `hash-256` embedder as the default. A local
  MiniLM (transformers.js) would make search match meaning, but it adds about
  100 MB of native dependencies and a model download on first run, which works
  against "clone, run, see it without asking" (reproducibility, 15 points).
  Hybrid search still uses both Relate indexes through `COMBINE`. The
  `Embedder` interface stays, so a semantic embedder can be added later as an
  opt-in without changing packs.
- **Second pack:** `decision-log` (decisions, options, assumptions; `needs_review`
  follows RESTS_ON and DEPENDS_ON to find decisions on stale foundations).
- **MCP Apps:** ext-apps 1.7.5 (the line that targets MCP SDK 1.x). One React
  bundle served as `ui://vine/<view>`, run on Preact to keep it near 300 KB.
  `vine ui` / `browser_view` serve the same views on 127.0.0.1 for agents
  without MCP Apps.

Decided 17 Nov:

- **Replicated graphs, one model.** Every member keeps a full copy built from
  a log of signed changes; online members keep each other in step over a
  WebRTC mesh, so the graph works offline and while its creator is away.
  Claims and Questions is the only model: with one fixed schema, changes are
  four fixed kinds (claim, question, link, withdraw) and need no merge rules.
  Model packs, `decision-log`, `validate_model`, `install_model` and the
  model studio are removed. Design and as-built notes:
  [REPLICATION.md](REPLICATION.md).

## 10. Target: any device, any assistant

Added 2026-11-21. This is the outcome the project is measured against. New
work should move a cell of the matrix below, or at least not make one harder.

**The outcome wanted:** easy setup and use on

- a MacBook,
- a Windows PC,
- an Android phone or tablet,
- an iPhone or iPad,

each with Claude, Codex, ChatGPT, Grok or any other assistant that speaks MCP.

"Easy" means one install step with no clone, no build and no environment
variables, and a join that works by pasting the code.

### 10.1 Where it stands (audit of 21 Nov)

| | Claude Code | Codex | Claude desktop chat | ChatGPT, Grok | Other MCP agents (Cursor, Gemini CLI, VS Code) |
|---|---|---|---|---|---|
| **macOS** | Works: plugin, views, mod | Plugin exists; not re-run in this audit | Manual config, undocumented | Not possible | Manual config, undocumented |
| **Windows** | Core passes in CI; plugin not yet run | Core passes in CI; plugin not yet run | Untested | Not possible | Untested |
| **Android** | Not possible | Not possible | Not possible | Not possible | Not possible |
| **iOS, iPadOS** | Not possible | Not possible | Not possible | Not possible | Not possible |

What was checked: CI is green on Linux x64, macOS and Windows x64 (all 66
tests, `vine doctor`, and the installed `vine` command), and `vine doctor`
passes on macOS arm64. Not checked: the npm registry, and the current
connector rules of ChatGPT and Grok.

Why the gaps exist:

- **Setup isn't easy yet, even on macOS.** It needs Node 20, a clone,
  `npm install`, a build and `npm link`. The package isn't on npm yet (the
  name is free, and `scripts/pack-check.mjs` proves the tarball installs and
  runs), and the `npx` route was dropped in the rename.
- **Windows runs the core, but no assistant has been tried on it.** The
  tests, the native binaries and the `vine` command pass in CI. Still open:
  whether each assistant can start the plugin's bare `vine` command (npm
  installs it as a `.cmd` shim, which Node can't start without a shell, and
  Claude Code's docs don't say how it starts one), and `autostart`, which is
  macOS only.
- **Phones, ChatGPT and Grok only reach remote MCP servers over HTTPS.** Vine
  is a local process on stdio, and its HTTP endpoint is bound to 127.0.0.1
  behind a one-time token. This is a gap in the architecture, not in the
  packaging.

### 10.2 Path to full maturity

| # | Step | Done when | Timing |
|---|---|---|---|
| 1 | **One-command install on desktop.** Publish to npm; the plugin starts the server with no clone; Windows is in the CI matrix (done 21 Nov); the plugin's launch command is proven on Windows | A clean macOS and a clean Windows machine reach a first result from one command | Before 11 Dec |
| 2 | **Desktop assistants beyond Claude Code and Codex.** A Claude desktop extension bundle; tested config snippets for Cursor, Gemini CLI and VS Code | Each is listed in the README with a setup that was run, not assumed | Before 11 Dec |
| 3 | **Connections that just work.** A stored TURN setting and link status in `status` and the console (done 23 Nov: `vine turn`, `set_turn_server`); a default relay is still open | Two members on strict networks connect with no environment variables | Before 11 Dec |
| 4 | **A remote gateway.** An always-on member (the person's own machine, or a small hosted one) serves the same tools over public HTTPS with sign-in | A phone, ChatGPT and Grok each join a context and read and write it | After the hackathon |
| 5 | **Autostart everywhere.** Windows and Linux equivalents of the macOS launch agent | Graphs keep syncing after a reboot on all three | After the hackathon |

Step 4 is the large one. It changes the "no server" claim to "no server
needed, an optional gateway you own", and it adds sign-in, so its design is
agreed before any code.

### 10.3 Rules this sets for other work

- **Native code is the main cost.** Each native dependency must ship a
  prebuilt binary for macOS arm64 and x64, Windows x64, and Linux x64 and
  arm64. A new one needs a reason, and a fallback that works without it.
- **The semantic embedder stays optional.** The offline `hash-256` embedder
  remains the default on every platform.
- **Nothing is called supported until it has been run there.** The README
  lists a platform or assistant only after a real setup on it.
