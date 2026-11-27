# Replicated graphs: design

Status: built, 2026-11-17 (all three stages, the model cut, and section 9).
Where the build differs from this design, section 12 says how and why.

## 1. Goal

Every member of a shared graph keeps a full copy on their own machine and
knows every other member's machine. Whoever is online keeps everyone else in
step: if the person who made the graph is offline, the rest still sync with
each other, and anyone coming back catches up from whoever answers.

Today it's a star: one host holds the only copy, members work through it, and
when the host is gone (asleep, offline, sharing off) nobody can read or write.

## 2. Decisions already made

| Decision | Consequence |
| --- | --- |
| **Claims and Questions is the only model.** Other packs, the model studio, `install_model` / `validate_model` and `vine model …` are removed (later, separately). | The changes are four fixed kinds, not arbitrary Cypher from a pack. |
| **Ids are UUIDs** (v7: time-ordered, 128-bit) instead of today's 8 random characters. | Two machines never make the same id, so the only unique key in the model can't clash. |
| **Machine clocks are assumed correct and in sync.** | Changes are ordered by their timestamp, ties broken by author key. No vector clocks for ordering. |
| **Up to 20 members.** | Every member can connect to every other member (at most 190 links in the group). |
| **A new member downloads everything** (later: a snapshot plus what came after). | Simple first version; the snapshot is an optimisation. |
| **This week's failures stay fixed** (section 9). | Silent relay drops and sharing switched off would stop a mesh just as they stopped the star. |
| **A join code is answered only by the machine that made it.** | That machine must be online when the code is used; the newcomer is told to try again later otherwise. |
| **Every member, readers too, gets the full history.** | One kind of copy for everyone. |
| **A member is their machine's key; the name is just a label.** | Names can change freely (a `rename` change); everything records the key. |
| **Writes wait 10 seconds before leaving the machine; Undo works only in that time.** | Undo can truly remove something said by mistake (section 4.1). After that, only `withdraw`, which keeps the text in the history. |

## 3. Replicating changes instead of the database

Each machine keeps an **append-only log of signed changes**. The Relate
database is built from that log, and is never sent between machines.

- A write creates one change, signed by its author's key, applied locally at
  once (it works offline), and sent to whoever is connected.
- Syncing is swapping the changes the other side is missing. Two machines that
  hold the same changes always end up with the same graph, whatever order the
  changes arrived in.
- There is no "merge your diff" step. Disagreement between people (two claims
  that contradict) is data, shown by the conflicts view, not a merge error.

This works because the model only ever adds: a claim is never edited, a
correction is a new claim that `REPLACES` the old one, and a withdrawal marks a
claim as ended, keeping it in the history.

## 4. Changes

```text
{
  id:      UUIDv7            unique; also the order key with `at`
  kind:    "claim" | "question" | "link" | "withdraw" | membership kinds (section 6)
  author:  Ed25519 public key (the member's existing identity)
  seq:     1, 2, 3 …         this author's own counter, no gaps
  at:      ISO time          when it was made (clocks assumed in sync)
  body:    the kind's fields (below)
  sig:     Ed25519 signature over everything above
}
```

| Kind | Body | Applied as |
| --- | --- | --- |
| `claim` | `node` (UUID), `text`, `source?`, `about_from?`, `about_to?`, `supports[]`, `contradicts[]`, `replaces[]`, `answers[]` | Create the Claim node, then its links (each link waits for its target, below). |
| `question` | `node`, `text`, `about[]` | Create the Question node and its ABOUT links. |
| `link` | `from`, `relation`, `to` | Create the link. If the same link already exists, keep the earlier one. |
| `withdraw` | `node`, `reason?` | Set `withdrawn_at/by/reason`. If it's already withdrawn, the earliest withdrawal wins. |

**Checking a change when it arrives:** the signature; the author is a member
with a role that allows this kind at the change's `at` (section 6); the
fields fit the schema; for a withdrawal, the author is the target's author or
an admin. These checks depend only on the change and on facts that never
change (a node's author), so every machine reaches the same answer.

**What is checked only when the change is made**, not when it's applied:
"that claim is withdrawn, don't link to it", "that link already exists". These
depend on what a machine has seen so far, so re-checking them on arrival would
make machines disagree. A link made at the same moment as a withdrawal stays,
pointing at a withdrawn claim, which is how the history reads anyway.

**A change that arrives before what it refers to** (a link to a claim not yet
received) is held and applied when the target arrives. Today's Cypher would
silently skip it (`MATCH` finds nothing), so the apply step must not use the
model's tool queries. It uses its own small, idempotent apply functions, one
per kind.

**Authors:** nodes record the author's key. The name shown is the member's
current name, from the membership log. A member is one machine's key: the same
person on two machines is two members (as today).

### 4.1 Undo and the send delay

Undo on the receipt is for "that shouldn't have gone in there", such as
personal details typed in the wrong chat. A withdrawal doesn't do that job:
it hides the claim from searches, but the text stays in the history on every
copy. (That's true today as well: the receipt's Undo is `withdraw`.)

So a new change is **held on the author's machine for 10 seconds** before it
is sent to anyone:

- It is applied locally at once, so the author's agent sees it straight away.
- **Undo within the 10 seconds deletes it** from the local log and store. It
  never leaves the machine, and nothing records that it existed. Its `seq` is
  reused by the next change, so there's no gap.
- After 10 seconds it's sent, and the receipt's button changes to
  *Withdraw*, which says that the text stays in the history.
- The receipt shows the countdown.
- Shutting down vine within the 10 seconds keeps the change and sends it on
  the next start.

10 seconds rather than 5, to leave time to read the receipt. It's one
constant, so easy to change; or drop Undo entirely and keep only Withdraw.

**Embeddings** are made on each machine from the text, and are never sent.
Members may use different embedders (`VINE_EMBEDDER`): their searches can rank
the same claims differently, but the claims themselves are the same. A graph
opened with a different embedder from the one that made its vectors rebuilds
them locally.

## 5. Syncing

**What each side has:** because each author numbers their own changes 1, 2, 3
… with no gaps, a machine's state is one number per author (at most about 20
numbers). On connecting, both sides send that list. Each then sends the
changes the other is missing, in `seq` order per author, then the two stay
connected and forward each new change.

**A machine forwards changes it didn't write**, so a change reaches everyone
who is connected to anyone who has it. Each change is applied once (by `id`),
and resending is harmless.

**Joining:** a new member gets every change from whoever answers. Later this
becomes a snapshot (the Relate store's files plus the per-author numbers it
covers), then the changes made since.

**Size:** at about 1 KB per change, 100,000 changes is about 100 MB, fine for
20 people. Compacting the log is out of scope.

## 6. Members and roles

Membership becomes changes in the same log, signed by an admin:

| Kind | Who can make it | Body |
| --- | --- | --- |
| `create` | the graph's creator (change 1 of the log) | graph name, the creator's key as the first admin |
| `add_member` | admin | key, name, role, the invite it used |
| `set_role` | admin | key, new role |
| `remove_member` | admin | key |
| `rename` | the member themselves | new name |

- A change is valid if its author was a member with a suitable role **at the
  change's `at`**. So a reader's writes are refused by every machine, and a
  removed member's later writes are refused everywhere.
- **Two admins disagreeing at the same time:** removal beats a role change;
  otherwise the later change wins.
- **Names:** a member renames themselves with a signed `rename`. A name
  already used by another member is refused when the change is made. If two
  members take the same name at once while apart, the earlier keeps it, and the
  later is shown with their key fingerprint after it until they rename.
- **Removal doesn't recall data.** A removed member keeps everything they
  already received; nobody sends them anything new, and the group's
  signalling secret changes (section 7) so they can't even find the group.
  This is weaker than today, where the host cuts access, and must be said
  plainly in the README.

**Invites:** a code is answered only by the machine that made it. That
machine checks the proof, writes `add_member`, and sends the newcomer the log
(or, once they're in, any member can). If it's offline, the newcomer is told
"the person who invited you isn't online; try again later", and their agent
retries quietly for a while.

Considered and not chosen:
- **Any online admin can answer:** each invite's secret is sent, encrypted,
  to every admin. More moving parts, and more machines holding live secrets.
- **Join requests that wait:** the newcomer leaves a signed request in the
  room, and the maker accepts it when back. The newcomer still waits, so
  it adds little over retrying.

## 7. Finding each other

- Every member holds a **group secret**. From it they derive the Nostr room
  (like an invite room today) where online members announce themselves and
  set up WebRTC with each other: full mesh, at most 19 links per machine.
- Each connection starts with proof of the group secret, then the member's
  signed key. Only members (by key, from the membership log) are accepted.
- On `remove_member`, an admin makes a new group secret and sends it,
  encrypted, to each remaining member over their connections. Members who were
  offline get it on their next sync with anyone. A removed member who was
  offline at the time still has the old secret, but finds an empty room.
- **Bootstrapping:** a new member knows only the inviting machine at first,
  then gets the group secret and the member list in the log.

## 8. Stages

Each stage is useful on its own and builds on the last.

1. **Log, replicas, catch-up, still a star.** Writes become signed changes;
   every member keeps a full copy and can read and write offline; the host
   is the meeting point, and a returning member syncs with it. Ids become
   UUIDs. *Most of the work is here.*
2. **Mesh.** The group room and member-to-member sync (section 7). Any
   online members keep each other in step; the host is no longer special
   except for answering invites.
3. **Membership without a host.** Membership changes (section 6) and the
   group secret change on removal; any admin can manage members.

The model cut (removing other packs and the studio) goes before stage 1, as
its own change.

## 9. Keeping connections alive

The mesh needs the same protections as the star, and a few more:

- **Done:** relays are pinged and replaced when they go silent, and
  reconnection never gives up (`src/p2p/nostr.ts`).
- **Done:** sharing is on by default and survives a restart; only
  `sharing` with the action `off` turns it off (`on` turns it back on).
- **To do:** WebRTC links pinged the same way; a dead link is dropped and
  set up again through the room.
- **To do:** each machine's vine starts at login (a login item / launch
  agent), so a reboot doesn't take a member offline until someone opens an
  agent.
- **To do:** `status` and the console show each relay's and each member
  link's state, so a silent failure is visible.
- **To do:** a test for a member that comes back after a "sleep" (sockets
  that look open but are dead), on relays and on member links.

## 10. Testing

- Many replicas in one process (in-memory signalling, as the star tests use):
  random writes, random disconnects, random delivery order. Check every
  replica ends up with the same graph.
- Held changes: a link that arrives before its claim, a withdrawal that
  arrives before its claim.
- Membership: a reader's write refused everywhere; a removed member's later
  write refused; two admins acting at once.
- The section 9 failures, simulated.
- The real-relay check (as `invite-check.mjs` today), with three members and
  the creator offline.

## 11. Open questions

None at the moment. The four earlier ones are decided in section 2.

## 12. Where the code differs from this design

- **The group secret isn't changed on removal** (sections 6 and 7). Every
  member's machine refuses a removed key at the link handshake and refuses
  its later changes, so a removed member gets nothing new; they can still see
  that the group's signalling room is in use. Changing the secret needs a way
  to encrypt it to each member's key (Ed25519 keys can't encrypt), which is
  left for later.
- **A held write is numbered when it is released**, not when it is made, so
  taking one back never leaves a gap in its author's numbers.
- **The machine a code is tied to can use it again** to fetch the whole graph
  again (for example after losing its copy).
- **Undo of a link or withdrawal** rebuilds the store from the log; Undo of a
  claim or question just deletes it (nothing else can refer to it yet).
- **Joined graphs are local graphs.** `join_context` puts the graph on this
  machine under its own name (or `name-2` …), and from then on `use_context`
  switches to it; `leave_graph` is gone.
- **Where it's tested:** `test/replica.test.ts` (real WebRTC between hosts in
  one process: join, sync both ways, Undo in the hold, offline catch-up,
  members syncing while the creator is away, roles and removal everywhere,
  three copies converging, held writes surviving a restart),
  `test/temporal-claims.test.ts` (order-independent applying),
  `test/nostr.test.ts` (relay keepalive).
  A member link that goes silent is dropped by its pings, but that has no test
  of its own yet.

## 14. Contexts, descriptions and the sync digest (2026-11-19)

- **Contexts.** What people and agents see calls each graph a *context*
  (context graph); the code still says graph. Tools: `context_info`,
  `use_context`, `join_context`, `link_folder`, `share_context`,
  `open_view`, `recent` (with `activity`), `update_context`.
- **A chat's contexts** (2026-11-20; before, a conversation had a set of
  attached contexts from a `.p2p-context` file per folder). A chat usually
  has one context and may add more (`use_context` with mode `add` or `remove`). The set
  and the write context are remembered in the data folder's `links.json`
  under the chat's id (`VINE_CHAT`, else `CLAUDE_CODE_SESSION_ID`), so a
  reopened chat gets them back. A new chat starts with its folder's linked
  contexts (the same file), else the one the CLI names, else none: there's no
  default. Contexts are found by id, then name. With one context the tools
  have no `context` argument; with several, reads run on all of them, labelling
  each row, and writes go to the context named or else the write context, the
  tools' descriptions listing what each is for. See `src/mcp/links.ts`.
- **Descriptions** are a membership-style change, `describe`, made by an
  admin; the latest one counts, and the create change may carry the first.
- **Replies** (`reply`, a `Reply` node with `REPLIES_TO` to its question) are
  a data change of their own, applied like a question; a reply waiting for its
  question is pending like a link. Replies never answer: a claim with
  `ANSWERS` does. `thread` reads a question with its replies and answers, and
  the digest tells a question's author about replies.
- **The sync digest** (`src/host/digest.ts`): after changes from other members
  are applied, the host works out what they mean for its person (claims of
  theirs replaced, questions answered or replied to, new conflicts, two current claims
  replacing one, possible overlaps with no link between them) and sends the
  lines to its sessions as `News:` and to the mod's feed. A possible overlap
  is a search hit by another author sharing at least 3 content words and 40%
  of the shorter text's. Nothing is linked automatically.
- **Joining** returns a briefing (what the context holds, open questions,
  conflicts, latest), since everything in it is new to the joiner.
