# Using Vine Context

Day-to-day use, once the [quickstart](../README.md#setup-and-run) works. You talk to your agent in plain words; the tool names are given in brackets for reference.

Back to the [README](../README.md).

## Contents

- [Install](#install)
- [Where the views show](#where-the-views-show)
- [Share a context](#share-a-context)
- [Join codes](#join-codes)
- [A chat's contexts](#a-chats-contexts)
- [Questions have threads](#questions-have-threads)
- [What a sync tells you](#what-a-sync-tells-you)
- [Undo and withdraw](#undo-and-withdraw)
- [Staying in sync](#staying-in-sync)
- [Removing someone](#removing-someone)
- [The Claude Code panel](#the-claude-code-panel)
- [Commands](#commands)
- [Trying it with two identities on one machine](#trying-it-with-two-identities-on-one-machine)

## Install

You need Node 20 or later. Install the `vine` command from npm:

```bash
npm install -g vine-context
```

### Install the plugin (recommended)

The plugin bundles the MCP server, two skills and the `/vine-context:join` command. It starts the server with the `vine` command you just installed.

**Claude Code:**

```bash
claude plugin marketplace add CraigDeverall/vine-context
claude plugin install vine-context@vine-context
```

In Claude Code the plugin also adds a band above the prompt, a status line entry, toasts and a `/contexts` panel: see [The Claude Code panel](#the-claude-code-panel).

**Codex:** the same `plugin/` folder is a Codex plugin (skills and the MCP server). Codex has no plugin slash commands, so joining is the `join-context-graph` skill: paste the code.

```bash
codex plugin marketplace add CraigDeverall/vine-context
codex plugin add vine-context@vine-context
```

### Other MCP agents

Any agent that can start a local MCP server over stdio can use the tools without the plugin. The command to run is `vine mcp`. In Claude Code, for example:

```bash
claude mcp add vine-context -- vine mcp
```

### Check your machine

```bash
vine doctor
```

### From source

To work on Vine Context itself, or to run it before a release:

```bash
git clone https://github.com/CraigDeverall/vine-context && cd vine-context
npm install && npm run build && npm link
```

`npm link` installs the `vine` command from your clone.

## Where the views show

There are four views: the sharing console, the graph explorer, a receipt (with *Undo*) after each write, and conflicts. Agents that support MCP Apps show them in the chat.

| Agent | Views |
|---|---|
| Claude (Claude Code desktop and Claude desktop) | In the chat. The console can stay open beside it, and a receipt's *Explore graph* and *Console* buttons open those panels |
| Codex app (in the ChatGPT desktop app) | In the chat, with a button to expand to full screen |
| Codex CLI and other terminal agents | None in the terminal. Ask for the *browser view*: the same views on 127.0.0.1, behind a one-time token |

## Share a context

1. **You:** create a context (*"start a context called incident-42"*) or say *"invite Sam to my context"*. Either gives you a join code straight away, as a line to send:

   `Join my context graph: /vine-context:join vine1_…`

   Send it privately, to that one person. Others see you by your git name until you change it (*"set my name to …"*, or *Change* in the console).
2. **Them:** run that command, or paste the code into their agent, while your machine is online (it answers the code). They are in straight away, with a full copy, and their agent gives them a briefing: what the context holds, the open questions, the conflicts, the latest.
3. **Everyone in the context is told** who joined, on their agent's next action: name, role, which invite, who let them in, key fingerprint, agent and version, operating system. The console's *People* list shows the same. If it isn't who you expected, remove them (*"remove sam"*, or *Remove* in the console).

From then on everyone works on their own copy, limited by their role. The role is contributor unless you say otherwise (*"invite Sam as a reader"*). Whatever anyone writes reaches the others the next time their machines are both online, directly or through any other member.

## Join codes

Each code is for one person's machine.

- Whoever uses it first is let in. Anyone else who uses it is turned away, and told to warn you that it may have leaked.
- There is no approval step: the single-use code is the credential, so send it privately.
- An unused code expires after 24 hours (*"invite Sam, valid for a week"* changes that).
- The console and `sharing_status` list the invites. *Cancel*, or `revoke_invite`, stops one working.
- A code isn't needed again. A joined context is on the member's machine, so *"use the incident-42 context"* brings it back in any later chat.

## A chat's contexts

A chat usually uses one context, and keeps it when you reopen the chat. The choice is remembered on your machine under the chat's id (Claude Code's session id, or `VINE_CHAT`), with nothing written into your project.

- *"Use the incident-42 context"* (`use_context`) sets or switches it. A new name starts a new context, and the agent asks what it's for. That description can be changed later (`describe_context`, or ✎ in the panel).
- *"Also use the infra context"* (`add_context`) adds another, and `remove_context` takes one out. With several, reads search them all, and the agent puts each write in the one whose description fits.
- There is no default. A new chat has no context until you choose, so the agent asks before its first write.
- *"Start this folder's chats with these contexts"* (`link_folder`) makes new chats in that folder, or below it, start with them. That is kept on your machine too.

## Questions have threads

Agents `reply` to a question with partial findings, ideas and follow-ups, and read the whole `thread` before adding to it. A reply never closes a question. When you give an answer, in the chat or with *Answer* in the panel, your agent records it as a claim that answers the question.

## What a sync tells you

When changes from others arrive, live or after you were offline, your agent is told what they mean for you:

- your claim was **replaced**, or your question **answered** or **replied to**;
- a **new conflict**: a claim contradicts another, yours first;
- **unsettled**: two current claims replace the same claim;
- a **possible overlap**: a new claim close to an existing one by someone else, with no link between them, for the agent to look at.

Nothing is linked automatically. The agent records `SUPPORTS`, `CONTRADICTS` or `REPLACES` with you.

## Undo and withdraw

A write stays on your machine for 10 seconds before it is sent. *Undo* on the receipt (or `take_back`) removes it without trace in that time, so a slip such as personal details in the wrong chat never reaches anyone.

After that it can only be *withdrawn*, which keeps it in everyone's history.

## Staying in sync

- Sharing is on by default and survives restarts. *"Stop sharing"* takes a context offline until you share again. Your copy keeps working.
- Each context's host runs while an agent uses it. To keep contexts syncing without an agent open, and after a reboot, run `vine autostart on` (macOS only for now).
- `vine status --graph <name>` shows the members, the live links to them, and whether the signalling relays are reachable.
- If two machines can't reach each other directly (some networks block it), set a TURN server: `VINE_ICE=turn:user:pass@host:3478`.

## Removing someone

Removing a member stops every other machine syncing with them and refuses their later changes. It can't take back the copy they already have.

## The Claude Code panel

In Claude Code the plugin adds to Claude Code's own interface:

- **A band above the prompt** in every chat: this chat's context, who is online, and the latest news (what others' changes meant for you, or the latest thing someone synced).
- **A status line entry, and a toast** when someone else's change or a sync digest arrives.
- **`/contexts`:** a panel beside the chat that updates by itself, with four tabs.

| Tab | What it shows |
|---|---|
| **Overview** | What needs you (conflicts, replies to your questions, open questions, a missing description, being offline), what others' changes meant for you, and recent activity. *Catch me up* and *Save what this chat learned* ask your agent to do just that |
| **Questions** | Open, answered or yours, each with its thread. *Answer* hands your answer to your agent to record as a claim, and *Ask my agent to look into it* sets it to work |
| **Claims** | Current, yours, in conflict, or history. A conflict shows both sides with *Keep this one*. A claim opens with everything linked to it, and *Correct it* records a claim that replaces it |
| **People** | Who is in, what each has recorded and when they were last active; roles and *Remove* for admins; the join codes still waiting, with *Copy* and *Cancel*; *Invite someone*; *Go offline* and *Go online* |

Both lists filter by words, a person or an id. *⇄ Contexts*, or the context's name in the band, turns the chat's contexts on and off.

The panel never writes a claim or question itself: your agent does, from what you tell it. Its source is [`plugin/hooks/register.tsx`](../plugin/hooks/register.tsx), and `claude plugin test plugin` runs its tests.

## Commands

| Command | What it does |
|---|---|
| `vine demo` | Open the views on a copy of the example context |
| `vine mcp` | Run the MCP server (your agent starts this) |
| `vine doctor` | Check Node, Relate, WebRTC, the model and the data directory |
| `vine status --graph <name>` | Members, live links and relay reachability for one context |
| `vine whoami` | Your name and key |
| `vine autostart on` | Keep contexts syncing after login (macOS) |

| Setting | What it changes |
|---|---|
| `VINE_DATA_DIR` | Where contexts are kept (default `~/.local/share/vine-context/`) |
| `VINE_USER` | Your name in new contexts (default: your git name) |
| `VINE_ICE` | A TURN server for strict networks |
| `VINE_EMBEDDER` | The search embedder ([limits](HOW-IT-WORKS.md#limits)) |

## Trying it with two identities on one machine

Each `VINE_DATA_DIR` is a separate person, so two MCP servers side by side can play both ends of a join:

```bash
claude mcp add vine-bob -e VINE_DATA_DIR="$HOME/.local/share/vine-bob" -e VINE_USER=bob -- vine mcp
```

To point an agent at the example data, run `vine demo` and use the `VINE_DATA_DIR=… vine mcp --graph incident` line it prints.
