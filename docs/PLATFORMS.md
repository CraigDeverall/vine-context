# Vine Context on every assistant

Drafted 2026-11-23. It expands step 2 (other desktop assistants) and step 4 (a
remote gateway) of [PLAN.md §10](PLAN.md#10-target-any-device-any-assistant)
into a full plan for every assistant **other than Claude Code and Codex**.
Platform facts were checked on 23 Nov against each vendor's docs (sources at
the end). Anything marked *unverified* is still to be tried before it goes in
the README.

## 1. Outcome and principles

**Outcome:** a person using any of the assistants below gets, with one install
step and a pasted join code, the best Vine Context that assistant can show:
the tools, the skill's guidance, news from others, and the views.

**Principles**

1. **One server and one source.** Every target runs the same `vine mcp`, or the
   gateway in §6. Per-assistant manifests, commands and hooks are *generated*
   from `plugin/` by one script. Nothing is hand-copied, so nothing drifts.
2. **A ladder for the views, highest rung first.**
   1. A native mod: Claude Code today, OpenCode next (§5.3).
   2. MCP App views inline (`ui://vine/*`).
   3. `browser_view` on 127.0.0.1.
   4. Text only.

   Every target gets the highest rung it supports, and every rung below it
   still works.
3. **News reaches the agent without a push.** Notices already ride on the next
   tool result. Hook-capable hosts also get a session-start and per-turn
   digest (§5.2), so news shows up even when no vine tool is called.
4. **"Listed" means "run".** A target goes in the README only after its setup
   was run on a clean machine, with the result recorded in the matrix (§8).
5. **Local first; the gateway is optional and owned by the person.** The
   "no server needed" claim stays true for every local target.

## 2. The targets

Two groups, by transport.

**Local (stdio, on the person's computer):**

| Target | Package format | Skills | Commands | Hooks | Views |
|---|---|---|---|---|---|
| **GitHub Copilot**: VS Code, Copilot CLI, Copilot app | Agent Plugins 1.0 (root `plugin.json`); also reads `.claude-plugin/` | Yes | Yes | Shell, on lifecycle events | MCP Apps in VS Code (since Jan 2026). CLI: none, so browser view |
| **Cursor** | `.cursor-plugin/plugin.json` or Agent Plugins | Yes | Yes | Shell | MCP Apps (Cursor 2.6) |
| **Gemini CLI** | Extension: `gemini-extension.json` + `hooks/hooks.json` | Yes | TOML commands | Shell (`BeforeTool` and others) | None, so browser view |
| **Grok Build** (`grok` CLI) | Grok plugin (skills, commands, agents, hooks, MCP) | Yes | Yes | Scripts on tool and session events | None found, so browser view |
| **OpenCode** | `opencode.json` `mcp` entry + npm plugin | Via the plugin | Markdown commands | **In-process JS/TS event handlers** | TUI plugin: a port of the mod |
| **Claude desktop chat** | `.mcpb` desktop extension | Not in an mcpb (instructions only) | No | No | MCP Apps |
| **Others** (Windsurf, Zed, Cline, Continue, JetBrains AI) | Plain MCP config snippet | Varies | No | Varies | Mostly the browser view |

**Remote (HTTPS only, so they need the gateway in §6):**

| Target | What it requires | Views |
|---|---|---|
| **ChatGPT** (web, desktop, mobile) | Developer mode / apps; Streamable HTTP or SSE; OAuth or no auth; public HTTPS. Plus/Pro may be limited to read-only (sources disagree) | MCP Apps (Apps SDK) |
| **Grok app** (web, iOS, Android) | "Bring your own MCP" custom connector; public HTTPS (localhost and private ranges are refused); paid plan | None found |
| **Claude web and mobile** | Custom remote connector | MCP Apps |
| **Any assistant on a phone** | Same as above | — |

## 3. Phases

| Phase | Scope | When |
|---|---|---|
| **P1: Install anywhere** | §4 foundations, §5.1 packages for all local targets, generic snippets | Before 11 Dec |
| **P2: Feels native** | §5.2 hook digest, §5.3 OpenCode mod, §5.4 views verified per host | P2a (digest, views check) before 11 Dec; the rest after |
| **P3: Reach the rest** | §6 gateway → ChatGPT, Grok app, Claude web/mobile, phones | After the hackathon; design agreed before any code |

## 4. Foundations (P1, blocks everything else)

Mostly PLAN.md §10.2 step 1, plus two additions.

- **F1. Publish to npm** (`vine-context` 0.1.0 is pack-checked). After that,
  every target launches the same command, with no clone.
- **F2. A launch command that works on Windows.** npm installs `vine` as a
  `.cmd` shim, and hosts that spawn without a shell can't start it. Generated
  configs should use `node <resolved path>/dist/cli.js mcp` (written by F3), or
  `npx -y vine-context mcp` where a host is known to cope. Prove it once per
  host family on Windows.
- **F3. `vine setup [client]` (new).** Our code runs here, so this is the
  route that adapts to the host and OS.
  - With no argument, it finds the installed assistants and asks which ones
    to set up (default: all of them). It installs the plugin or extension
    where the host has a CLI for that, and otherwise writes or merges the MCP
    config.
  - It knows `copilot-cli`, `vscode`, `cursor`, `gemini`, `opencode`, `grok`,
    `claude-desktop`, `windsurf`, `zed` and `cline`.
  - It never overwrites another server's entry. `--print` shows the snippet
    instead of writing it.
  - It ends by saying what's next: restart X if needed, then paste the join
    code.

  `npm i -g vine-context` followed by `vine setup` is the documented route
  for anyone with several assistants or a host with no marketplace. Every
  assistant shares one host and one store, so a context joined in one is
  available in all of them.
- **F4. `vine doctor --client <name>` (new).** It checks that the config exists,
  the command resolves, the server starts and lists tools, and the host
  process is reachable. One line of output per check.
- **F5. Fix the hooks.json name clash.** `plugin/hooks/hooks.json` is a Claude
  Code *mod* manifest (`{"modules": [...]}`). Gemini CLI, and probably Copilot,
  Cursor and Grok, read `hooks/hooks.json` as *shell hooks*, so the same file
  would be misread or rejected. The generated packages (§5.1) must not ship
  that file; each gets its own `hooks.json` from §5.2. Check whether the Claude
  Code plugin can point to its mod manifest under another name.
- **F6. One step from a marketplace, with no global npm install.** Today
  every plugin starts a bare `vine mcp`, so `npm i -g` has to come first.
  Agreed fix, in two parts:
  - Generated packages start the server with `npx -y vine-context@<version> mcp`.
    The version is pinned, so the plugin and the server can't drift apart.
    Test each host for a slow first start and for the Windows shim problem
    (F2). Where npx fails on a host, that host's package falls back to a bare
    `vine` and the README says to install from npm first.
  - Packages that can carry `vine` do: the OpenCode npm plugin depends on
    `vine-context` and launches its own copy (check that OpenCode installs
    plugin dependencies itself), and so does the full `.mcpb` (§5.1).
  - The host process and autostart must work when started from an npx cache
    or a bundle path, and a client from another version must be refused
    with a clear message rather than corrupting the store.
- **F7. Install instructions in the README, per client.** See §7.1.

## 5. Local targets

### 5.1 Packages (P1)

On a marketplace or extension install, the host only copies files from the
repo and reads them. None of our code runs, so it can't detect anything.
Fitting each host is therefore the repo layout's job:

- `scripts/build-platforms.mjs` turns `plugin/` into `platforms/<target>/`.
  Each folder holds exactly what that host expects and nothing else: its
  manifest, its shell-hook `hooks.json`, and commands in its format.
- `platforms/` **is committed**, because git-based marketplaces read the repo
  directly. CI fails if a fresh build differs from what's committed, so
  nobody edits it by hand.
- The marketplace files (`.claude-plugin/marketplace.json`, which Copilot
  also reads, and Copilot's and Cursor's own) point each host's entry at its
  own folder.
- `plugin/` stays exactly as Claude Code and Codex expect it.
- Check whether `gemini extensions install` takes a subfolder of a repo. If
  it doesn't, Gemini installs from a release archive instead.

The outputs:

| Output | Holds | Install |
|---|---|---|
| `agent-plugin/` (root `plugin.json`, Agent Plugins 1.0 schema) | skills, `.mcp.json`, commands, shell hooks | Copilot CLI / VS Code / Copilot app marketplace from this repo; Cursor (it supports the standard) |
| `cursor/` (`.cursor-plugin/plugin.json`) | same | Only if Cursor's handling of Agent Plugins falls short |
| `gemini/` (`gemini-extension.json`, `${extensionPath}`) | MCP, skills, TOML `/vine:join`, hooks | `gemini extensions install <repo url>` |
| `grok/` | MCP, skills, `/join`, hooks | Grok plugin install from the repo or the marketplace |
| `opencode/` (npm `vine-context-opencode`) | config writer, commands, the TUI plugin from §5.3 | `"plugins": ["vine-context-opencode"]` |
| `vine-context.mcpb`, thin, then full per platform (below) | manifest + launcher, later the bundled server and `node_modules` | Double-click in Claude desktop |

Decisions and risks:

- **Copilot gives a root `plugin.json` that targets Agent Plugins priority over
  `.claude-plugin/`.** Keep generated outputs out of `plugin/` so Claude Code
  and Codex are unaffected. The repo's marketplace file lists one entry per
  output path.
- **The mcpb and native binaries.** An npm install already gets the right
  native code for the machine: `node-datachannel` ships one optional package
  per platform, and npm fetches only the one that matches (check that
  `@relate/relate` does the same). An `.mcpb` is a zip built on one machine,
  so it holds only that machine's binary. Agreed order:
  1. **Thin bundle first.** A launcher that runs `npx -y vine-context@<version> mcp`
     (F6). It's one bundle for every platform and proves the views work in
     Claude desktop.
  2. **Then full bundles, one per platform.** An `npm run build:mcpb` job runs
     on each CI runner (macOS arm64 and x64, Windows x64, Linux x64) and
     produces `vine-context-<os>-<arch>.mcpb`, with the manifest's
     platform field set. These need no Node or npm at all. If an npm `vine`
     is also installed, the version check in F6 keeps the two from
     clashing.
- **Skills where there are none.** Hosts with no skills (Claude desktop, plain
  snippets) still get the essentials from the server's `instructions` and
  `model_guide`. Make sure `model_guide` alone is enough to write well.
- **Commands.** `join.md` is the single source. The generator emits Markdown
  (Copilot, Cursor, OpenCode, Grok) and TOML (Gemini). Hosts with no commands
  use the `join-context-graph` skill or plain "join with vine1_…".

### 5.2 News through shell hooks (P2a)

New CLI verbs. Both read through the host and, like `context_activity`, never
use up the agent's notices:

- `vine hook session-start`: prints one short block (the chat's context, who's
  online, open questions waiting on you, and changes since you were last here)
  in each host's "add context" output format.
- `vine hook turn`: prints news since the last turn, or nothing. It's
  rate-limited and stays quiet when there's nothing new.

Each host's `hooks.json` maps its own event names: Copilot `sessionStart` /
`userPromptSubmitted`; Gemini `SessionStart` / `BeforeAgent`; Cursor and Grok
equivalents; Codex can adopt it too. Acceptance: a change made on another
machine shows up in the agent's next turn without the agent calling any vine
tool, on at least Copilot CLI and Gemini CLI.

Open question: does a "since last time" cursor live per chat (which needs a
session id from the hook payload) or per folder? Per chat where the host passes
an id, per folder otherwise.

### 5.3 OpenCode: the mod, ported (P2b)

OpenCode is the only target with in-process plugins and a TUI layer, so it can
get close to the Claude Code band, toasts and panel.

- Move the mod's data layer (polling `context_activity`, diffing, the
  "hand the person's words to the agent" prompts) out of `register.tsx` into a
  shared `src/ui-core/` used by both mods.
- OpenCode plugin, phase 1: a toast when others' changes or a digest arrive,
  plus a status entry. Phase 2: a TUI view covering Overview, Questions, Claims
  and People, if the TUI plugin API allows it (*unverified*, so check the
  current v2 docs first). Otherwise use `browser_view`.
- The rule carries over: the plugin never writes a claim itself. It hands the
  person's words to the agent.

### 5.4 Views per host (P2a)

The bundle (ext-apps 1.7.5, Preact) is the same everywhere. Work per host:

- **Verify** that all four views render and call tools in Claude desktop,
  VS Code (stable), Cursor 2.6+ and, after P3, ChatGPT. Record the size, theme,
  CSP and call results for each.
- **Fix host quirks behind feature checks**, not with per-host forks: height
  negotiation, dark mode, blocked `fetch`, display-mode limits.
- **No MCP Apps** (Copilot CLI, Gemini CLI, Grok Build, OpenCode without the
  TUI view): the skill already offers `browser_view`. Have `vine hook
  session-start` print the link as well, so it's one click away.

## 6. The remote gateway (P3, design review first)

> **Under review (2026-11-23).** This conflicts with the project's headline
> promise, "peer to peer, with no server" (README). The one shared piece accepted today, the signalling
> relay, sees only ciphertext, holds no state and can be swapped
> ([PLAN.md §4.4](PLAN.md)). A gateway would hold a plaintext copy and pass it
> to a third party's servers. The options being weighed: drop P3 and say those
> assistants aren't supported; or write down the conditions a person-owned
> bridge would have to meet and build nothing now. Until that's decided, treat
> the rest of this section as an outline, not a commitment.

Needed for ChatGPT, the Grok app, Claude web and mobile, and every phone. It
touches auth, public exposure and identity, so this section is a design
outline to agree before any code; the work needs Opus or better.

**Shape:** `vine gateway`, an always-on member that serves the same tools and
`ui://` resources over Streamable HTTP, with OAuth 2.1 (discovery, PKCE,
dynamic client registration, refresh). It's a client of the local host
process, exactly like a `vine mcp` session, so the graph, p2p and sync code
don't change.

**Where it runs (person's choice):**

| Option | Good | Bad |
|---|---|---|
| A. Their own computer + a tunnel (Cloudflare Tunnel, Tailscale Funnel) | Nothing hosted; data stays home | Only works while that machine is on; the tunnel is one more setup step |
| B. A small always-on box they own (a home server, a VPS, a container image) | Always online, so it also helps sync | Has to be run and secured |
| C. A hosted gateway we run | Easiest | Breaks "no server" and puts us in charge of others' data; **not recommended** |

Recommend A to start and B as the documented upgrade, with a container image
and Helm chart. Dogfood B on bigboy as its own namespace behind SquonkAuth
(Authentik as the OAuth server), isolated from the private tiers.

**Decisions to make before building:**

1. **Identity.** An identity is one Ed25519 key per install. Is the gateway
   (a) its own member, e.g. "Craig (gateway)", joined like any other peer, or
   (b) another device of the same person, which needs device linking? (a)
   needs no core change; (b) gives truer authorship. Recommend (a) for v1.
2. **Who can use it.** One person, mapping OAuth subject → that member, or a
   group that maps each subject to a member and role? Recommend one person
   for v1.
3. **What's exposed.** Per-context opt-in: a context is reachable through the
   gateway only if the person turns it on. Admin tools (`remove_peer`,
   `delete_context`, invites) stay off remotely in v1.
4. **The OAuth server.** Built in (simple, for options A and B), or an external
   IdP (Authentik and others)? Support both: built in by default, external as
   an option.
5. **ChatGPT limits.** If Plus/Pro connectors are read-only, write tools won't
   work there. Confirm the current rule, then decide whether to ship
   read-only for those plans.

**Acceptance:** a phone running ChatGPT and one running Grok each join a
context, read it, and write to it (where the plan allows). The write reaches a
laptop peer, and the laptop's write shows up in the phone's next turn.

## 7. Verification

- **Per-target smoke test, scripted where the CLI runs headless**
  (`copilot -p`, `gemini -p`, `opencode run`, `grok` headless): install from
  the generated package, call `context_info`, write a claim, see it on a
  second peer. These need vendor sign-ins, so they run by hand on this Mac and
  on Windows, with the results recorded in §8. They're not in CI.
- **In CI:** the generator's output validates against each published schema
  (Agent Plugins, Gemini extension, mcpb manifest); `vine setup --print`
  snapshots; the hook verbs' output formats.
- **The views:** a checklist per host (§5.4), with screenshots kept in the PR
  and not committed as baselines.
- **CI drift check:** a fresh `build-platforms` run must match the committed
  `platforms/` (§5.1).

### 7.1 README: install for each client (F7)

The README's install section is organised by assistant, so a reader finds
their own in one scroll and never reads anyone else's steps.

- **At the top:** a short "Which one are you using?" list linking to each
  client. Under it, the multi-assistant route: `npm i -g vine-context`, then
  `vine setup`.
- **One block per client, always in the same order:**
  1. **Install:** the single step. That's a marketplace command, a button (the
     VS Code `vscode:` link, Cursor's deeplink), a downloaded `.mcpb`, or
     `vine setup <client>`. Each command goes in its own code block.
  2. **Join:** exactly what to type, e.g. `/join vine1_…` or "paste the code
     into the chat".
  3. **What you'll see:** the tools, the skills, whether news appears at the
     start of a session, and the views (inline, browser link or panel).
  4. **If it doesn't work:** `vine doctor --client <name>`, plus that client's
     one or two known problems.
  5. **Tested:** the OS, the client version and the date it was last run,
     e.g. "macOS 26 / Copilot CLI 1.x, 2026-12-05".
- **Order:** Claude Code, Codex, GitHub Copilot (CLI, VS Code, app), Cursor,
  Gemini CLI, Grok Build, OpenCode, Claude desktop, then "other MCP clients"
  (the `vine setup --print` snippet).
- **A client appears only once it's been run** (principle 4). Until then it's
  listed under "Coming soon" with no steps, so nobody follows instructions
  that were never tried.
- **Assistants it can't reach** get one line, not a block: "ChatGPT, the Grok
  app, Claude web and mobile: not supported; they only connect to servers on
  the public internet" (the wording depends on the P3 decision).
- The matrix in §8 is the source of truth. When a cell turns green, the
  README block goes in, in the same change.

## 8. Target matrix (fill in as each one is run)

| Target | P1 install | Tools | Join | News (hooks) | Views | Run on macOS | Run on Windows |
|---|---|---|---|---|---|---|---|
| Copilot CLI | | | | | browser | | |
| VS Code (Copilot) | | | | | MCP Apps | | |
| Copilot app | | | | | ? | | |
| Cursor | | | | | MCP Apps | | |
| Gemini CLI | | | | | browser | | |
| Grok Build | | | | | browser | | |
| OpenCode | | | | | TUI / browser | | |
| Claude desktop | | | | n/a | MCP Apps | | |
| ChatGPT (P3) | | | | n/a | MCP Apps | | |
| Grok app (P3) | | | | n/a | text | | |
| Claude web/mobile (P3) | | | | n/a | MCP Apps | | |

## 9. Risks

| Risk | Mitigation |
|---|---|
| Vendor formats change fast (most of these are from 2026) | The generator, schema checks in CI, and the date checked written next to each README entry |
| Windows spawn quirks per host | F2: resolved `node` path; run once per host family |
| The hooks.json clash breaks a host's install | F5: generated packages never ship the mod manifest |
| Native binaries in the mcpb | Spike first (§5.1) |
| The gateway exposes personal graphs | Opt-in per context, admin tools off, OAuth, own namespace and isolation; design review |
| Too much work before 11 Dec | P1 + P2a only before 11 Dec; P2b and P3 after |

## Sources (checked 2026-11-23)

- Copilot: [CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference), [Agent Plugins 1.0](https://github.blog/changelog/2026-08-12-agent-plugins-1-0-in-vs-code-copilot-cli-and-the-copilot-app), [VS Code MCP Apps](https://code.visualstudio.com/blogs/2026/01/26/mcp-apps-support)
- Cursor: [plugins](https://cursor.com/docs/plugins), [2.6: MCP Apps](https://forum.cursor.com/t/cursor-2-6-mcp-apps-and-team-marketplaces-for-plugins/153479/2)
- Gemini CLI: [extension reference](https://geminicli.com/docs/extensions/reference/), [hooks](https://developers.googleblog.com/tailor-gemini-cli-to-your-workflow-with-hooks/)
- Grok: [Build hooks](https://docs.x.ai/build/features/hooks), [plugins](https://docs.x.ai/build/features/skills-plugins-marketplaces), [connectors](https://docs.x.ai/grok/connectors), [tunneling](https://docs.x.ai/grok/connectors/custom-mcp-tunneling)
- OpenCode: [plugins](https://opencode.ai/docs/plugins.md)
- ChatGPT: [developer mode](https://developers.openai.com/api/docs/guides/developer-mode), [help article](https://help.openai.com/en/articles/12584461)
- Claude desktop: [MCPB](https://github.com/modelcontextprotocol/mcpb), [desktop extensions](https://claude.com/docs/connectors/custom/desktop-extensions)
