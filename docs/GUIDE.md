# Using Vine Context

Day-to-day use, once the [quickstart](../README.md#setup-and-run) works. You talk to your agent in plain words; the tool names are given in brackets for reference.

Back to the [README](../README.md).

## Contents

- [Install](#install)
- [Do I need a TURN server?](#do-i-need-a-turn-server)
- [Where the views show](#where-the-views-show)
- [Share a context](#share-a-context)
- [Join codes](#join-codes)
- [A chat's contexts](#a-chats-contexts)
- [Questions have threads](#questions-have-threads)
- [What a sync tells you](#what-a-sync-tells-you)
- [Undo and withdraw](#undo-and-withdraw)
- [Staying in sync](#staying-in-sync)
- [Strict networks: TURN and STUN](#strict-networks-turn-and-stun)
- [Removing someone](#removing-someone)
- [The Claude Code panel](#the-claude-code-panel)
- [Commands](#commands)
- [Trying it with two identities on one machine](#trying-it-with-two-identities-on-one-machine)

## Install

You need Node 20 or later. Then run:

```bash
npx vine-context setup
```

It goes through eight steps, and says what it found at each one:

1. **The `vine` command.** Installs it globally with npm if it's missing or older (the plugin runs it).
2. **Your agents.** Finds Claude Code and Codex, and installs the plugin for each one that doesn't have it, printing the exact commands before running them. For other MCP agents it prints the `vine mcp` line to add.
3. **Your name.** Confirms the name others see (your git name, by default).
4. **This machine.** Runs the `vine doctor` checks.
5. **Your network.** Decides, without asking, whether it looks like it needs TURN (see [Do I need a TURN server?](#do-i-need-a-turn-server)).
6. **TURN.** Offers *Set up Cloudflare TURN* (the default when the network needs it), *my own TURN server*, or *skip*.
7. **Autostart.** On macOS, offers to run `vine up` at login, so contexts sync after a reboot.
8. **Next.** Suggests `vine demo`, or what to tell your agent.

Run it again at any time: each step checks what's there first, and only fixes what's missing or broken.

| Option | What it does |
|---|---|
| `--yes` | Takes the default answer to every question. Secrets are still typed, unseen. |
| `--agent claude\|codex\|none` | Which agents get the plugin (comma-separated). Default: the ones found. |
| `--turn cloudflare\|custom\|none` | The TURN choice, instead of asking. |
| `--json` | Prints each step's result as JSON on stdout; the rest goes to stderr. |
| `--dry-run` | Runs the read-only checks only, and prints every command, API call and keychain write it would make. |

Once `vine` is installed, `vine setup` is the same command.

### Install by hand

The same steps, one at a time. Install the `vine` command from npm:

```bash
npm install -g vine-context
```

#### Install the plugin (recommended)

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

#### Other MCP agents

Any agent that can start a local MCP server over stdio can use the tools without the plugin. The command to run is `vine mcp`. In Claude Code, for example:

```bash
claude mcp add vine-context -- vine mcp
```

#### Check your machine

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

## Do I need a TURN server?

Probably not. Here is how two machines connect, and where TURN comes in.

1. **Directly, first.** Two members' machines find each other through public Nostr relays, which only pass the short handshake. Then they connect straight to each other, peer to peer.
2. **STUN finds the way.** Most machines sit behind a router (NAT) and don't know their public address. Vine asks two public STUN servers for it, so each side can tell the other where to connect. That's enough on most home and office networks.
3. **Some networks don't allow it.** A direct connection fails when the network blocks UDP, or when its NAT hands out a different public port for every destination ("symmetric" NAT). This is common on corporate networks, guest Wi-Fi, VPNs and phone hotspots.
4. **TURN relays the connection.** A TURN server sits on the public internet and passes the connection between the two machines. It only ever sees encrypted data: the link is encrypted end to end between the members, as it is without TURN.
5. **Only one machine in a pair needs one.** If either side has a TURN server, that pair can connect.
6. **You only need it when you can reach no member at all.** Changes are forwarded from member to member, so if you're linked to anyone in a context, everyone's changes still reach you.

**How you'll know.** `vine setup` and `vine doctor` check the network and say *"this network will likely need TURN"* when STUN gets no answer over UDP, or when the two STUN servers see different public ports. When members are found but can't be connected to, Vine says so in plain words, in the terminal, in `vine status` and in your agent's next sync notice:

> Found Sam's machine, but your networks wouldn't allow a direct connection. A TURN server can carry the connection… Run `vine turn set --provider cloudflare`.

**Setting one up.** `vine setup` does it for you, or run `vine turn set --provider cloudflare` on its own. Cloudflare Realtime TURN is free for the first 1,000 GB each month (then $0.05 per GB), and Vine's traffic is tiny. It runs on your own Cloudflare account: Vine ships no shared key. You choose one of two ways:

- **Let Vine create the key.** Make an API token with the *Realtime Admin* (or *Calls Write*) permission, and type your account id and the token, unseen. Vine creates a TURN key named after this machine and then forgets the token.
- **Create the key yourself** in the dashboard (Realtime → TURN Server), and type its id and secret, unseen.

The key's secret is kept only in the macOS Keychain, or the Linux secret service. It never goes in a file, a command line, a log or the output. When a connection needs TURN, the host uses the key to get short-lived credentials (12 hours) from Cloudflare. It keeps them in memory, and fetches new ones on the next connection once they're within an hour of expiry. The key never leaves your machine. On a machine with no keychain, `--store env` keeps nothing and reads `VINE_CLOUDFLARE_TURN_SECRET`; create the key yourself for that.

## Where the views show

There are four views: the sharing console, the graph explorer, a receipt (with *Undo*) after each write, and conflicts. Agents that support MCP Apps show them in the chat.

| Agent | Views |
|---|---|
| Claude (Claude Code desktop and Claude desktop) | In the chat. The console can stay open beside it, and a receipt's *Explore graph* and *Console* buttons open those panels |
| Codex app (in the ChatGPT desktop app) | In the chat, with a button to expand to full screen |
| Codex CLI and other terminal agents | None in the terminal. Ask for the *browser view*: the same views on 127.0.0.1, behind a one-time token |

## Share a context

1. **You:** create a context (*"start a context called incident-42"*) or say *"invite Sam to my context"*. Creating a context invites no one. Inviting someone asks what they may do (read and add, only read, or also invite), then gives you a join code, as a line to send:

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
- Pin contexts to a folder (`link_folder`; the 📌 on each context in the panel): new chats started in that folder, or below it, start with the pinned ones. That is kept on your machine too.
- *"Delete the old-spike context"* (`delete_context`) deletes this machine's copy for good, after you confirm it by name; other members keep theirs. In the panel it's under a context's **Settings**.
- *"Rename the incident-42 context to checkout-slowdown"* (`rename_context`) changes this machine's name for it; other members keep their own name for it. A context's **Settings** in the panel (the same whether it's on for the chat or not) changes its name and description, invites people and takes it offline.

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
- If two machines can't reach each other directly (some networks block it), set a TURN server: see [Strict networks](#strict-networks-turn-and-stun).

## Strict networks: TURN and STUN

If two machines can't reach each other directly (some networks block it), one of them sets a TURN server, which then carries that pair's connection. There's none by default, and Vine ships no shared one: it's Cloudflare's on your own account, or a server you run. See [Do I need a TURN server?](#do-i-need-a-turn-server).

- `vine turn set --provider cloudflare` sets up Cloudflare Realtime TURN with a key on your account (`--key-id ID` to paste a key you made, or `--account ID` to have Vine create one with an API token). `vine turn show` names the provider and says until when the current credentials are valid.
- `vine turn set turn.example.org --user sam` asks for the password in the terminal and keeps it in a file only you can read (`--store keychain` uses the macOS Keychain or the Linux secret service; `--store env` keeps nothing and reads `VINE_TURN_PASSWORD`). `--tcp` and `--tls` pick how the server is reached.
- `vine turn show`, `vine turn test` and `vine turn clear` show, check and remove it; `vine doctor` checks it too.
- It applies to every context on the machine from the next connection on, with nothing to restart. `vine status` and the console say which links are direct and which are relayed.
- An agent can set the server and username (`set_turn_server`) but never takes the password: it's read from `VINE_TURN_PASSWORD`, or you run `vine turn set` yourself.

**STUN servers.** To find a route between two machines, Vine asks public STUN servers for each machine's public address: by default `stun.l.google.com:19302` and `stun.cloudflare.com:3478`. Those servers see your public IP address, nothing else. To use your own, or none, set `VINE_ICE` where vine runs (for Claude Code, in the environment it starts with), then stop each running context's host (`vine host stop --context NAME`) so it picks it up:

- `VINE_ICE=stun:stun.example.org:3478` uses only your STUN server.
- `VINE_ICE=stun:stun.example.org:3478,turn:user:pass@turn.example.org:3478` adds a TURN server too. `VINE_ICE` replaces both the default STUN servers and the `vine turn` setting, so a TURN server goes in the same list, with its password.
- `VINE_ICE=` (set but empty) uses no servers: machines connect only when they can reach each other directly, such as on the same network.

`vine turn show` says when `VINE_ICE` is in effect. There's no stored STUN setting: `vine turn set` only adds a TURN server alongside the default STUN servers.

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

Both lists filter by words, a person or an id.

*⇄ Contexts*, or the context's name in the band, opens the chat's contexts: each one's switch turns it on or off for the chat, and its 📌 pins it to the chat's folder. *+ Create new context* asks for a name and what it's for. A context's **Details** show its description, your role, who made it, what it holds, whether it's syncing and where it's stored, with *Share* (a join code), *Go offline* or *Go online*, and *Delete from this machine*, which asks you to type its name first.

The panel never writes a claim or question itself: your agent does, from what you tell it. Its source is [`plugin/hooks/register.tsx`](../plugin/hooks/register.tsx), and `claude plugin test plugin` runs its tests.

## Commands

| Command | What it does |
|---|---|
| `vine setup` | Set the machine up, or repair it ([install](#install)); `npx vine-context setup` before `vine` is installed |
| `vine demo` | Open the views on a copy of the example context |
| `vine mcp` | Run the MCP server (your agent starts this) |
| `vine doctor` | Check Node, Relate, WebRTC, the model, the data directory, the network (does it need TURN?) and the TURN server |
| `vine status --graph <name>` | Members, live links and relay reachability for one context |
| `vine whoami` | Your name and key |
| `vine turn set \| show \| test \| clear` | Set (`--provider cloudflare`, or a server of your own), show, check or remove a TURN server ([strict networks](#strict-networks-turn-and-stun)) |
| `vine autostart on` | Keep contexts syncing after login (macOS) |

| Setting | What it changes |
|---|---|
| `VINE_DATA_DIR` | Where contexts are kept (default `~/.local/share/vine-context/`) |
| `VINE_USER` | Your name in new contexts (default: your git name) |
| `VINE_ICE` | STUN and TURN servers, replacing the defaults and the `vine turn` setting ([strict networks](#strict-networks-turn-and-stun)) |
| `VINE_TURN_PASSWORD` | The TURN server's password, when it was set with `--store env` |
| `VINE_CLOUDFLARE_TURN_SECRET` | The Cloudflare TURN key's secret, when it was set with `--store env` |
| `VINE_EMBEDDER` | The search embedder: `auto` (default: the sentence model when installed, else the built-in), `hash` or a model name ([limits](HOW-IT-WORKS.md#limits)) |

## Trying it with two identities on one machine

Each `VINE_DATA_DIR` is a separate person, so two MCP servers side by side can play both ends of a join:

```bash
claude mcp add vine-bob -e VINE_DATA_DIR="$HOME/.local/share/vine-bob" -e VINE_USER=bob -- vine mcp
```

To point an agent at the example data, run `vine demo` and use the `VINE_DATA_DIR=… vine mcp --graph incident` line it prints.
