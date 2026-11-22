# Demo video script

Target length 1:50. The rules cap it at 2:00. A screen share with a voiceover is enough.

The video has one job: show that connected context, shared between people, makes each agent more reliable. Every scene shows a relationship doing work.

## Setup before recording

- Two identities on one machine, each in its own Claude Code window, side by side. Alice on the left, Bob on the right. [How to set up a second identity](../GUIDE.md#trying-it-with-two-identities-on-one-machine).
- Both windows at a large font size. Hide anything personal: real name, paths, other chats.
- A terminal ready with a copy of the example store and the query from scene 6 typed but not run.
- Rehearse once with a throwaway context so the join and the sync are quick on camera.
- Record at 1080p or higher. Cut waiting time in the edit; don't speed up speech.

## Script

| Time | On screen | Voiceover |
|---|---|---|
| 0:00 to 0:12 | Title card: **Vine Context**. Then two chat windows side by side, labelled Alice and Bob | "When a team investigates a problem, everyone has their own AI agent, and each agent learns things the others never see. Vine Context gives them one shared memory." |
| 0:12 to 0:30 | Alice types: *"Start a context called checkout-incident and invite Bob."* A join code appears. Bob pastes it. His agent prints the briefing. Alice's side shows the join notice | "Alice starts a context and sends Bob a join code. Bob pastes it into his agent. He now has a full copy of the graph on his own machine. It's a Relate database, embedded. There is no server." |
| 0:30 to 0:48 | Bob: *"Record that the 14:05 deploy of payments-api caused the slowdown."* The receipt shows. Seconds later a toast appears on Alice's side | "Bob's agent records a claim. A few seconds later it reaches Alice, directly, machine to machine." |
| 0:48 to 1:08 | Alice: *"That can't be right. The slowdown started at 13:58, before the deploy."* Her agent searches, finds Bob's claim and links `CONTRADICTS`. Bob's side shows the new-conflict notice. Open the Conflicts view | "Alice's agent doesn't just add a note. It finds Bob's claim and records that hers contradicts it. Bob's agent tells him straight away. Neither agent decides who's right. The conflict stays visible until a person settles it." |
| 1:08 to 1:26 | Bob: *"Correct my claim: mobile retries exhausted the database pool."* Open the explorer. Drag the time slider back and forward: the conflict appears, then resolves | "Bob replaces his claim. Nothing is deleted. Every relationship records when it was made, so we can drag time back and see exactly what the team believed at any moment." |
| 1:26 to 1:42 | Terminal. Run the `relate` CLI on the example store with the `CONTRADICTS` query. The table prints | "And it's all an ordinary Relate store on disk. Open it with Relate's own CLI, and the contradiction is one line of Cypher." |
| 1:42 to 1:52 | The README's diagram, then the repo URL | "One graph, a full copy for everyone, no server. It works offline and syncs when you're back. Vine Context: open source, built on Relate." |

About 230 words of voiceover, which is a comfortable pace for 1:50.

## The query for scene 6

```bash
relate -d /tmp/incident --mode table "MATCH (a:Claim)-[:CONTRADICTS]->(b:Claim) RETURN a.recorded_by AS who, a.text AS claim, b.recorded_by AS against, b.text AS other"
```

Run on a copy made with `cp -R "$(npm root -g)/vine-context/examples/data/graphs/incident" /tmp/incident`. The example store holds the same story as the live scenes, recorded by Alice, Bob and Carol.

## If time is tight

Cut in this order: the terminal scene (1:26 to 1:42), then the briefing detail in scene 2. Keep the contradiction and the time slider: they are the scenes that show connected context.

## If something fails while recording

- **Join doesn't complete:** check both windows are online with `vine status --graph checkout-incident`.
- **Sync is slow:** a write waits 10 seconds before it is sent (the Undo window). Cut the wait in the edit.
- **Views don't show in the chat:** ask the agent for the *browser view* and record that.

## What each scene proves

| Scene | Criterion it serves |
|---|---|
| Join with a code, no server | Creativity, completeness |
| A claim reaching the other machine | Completeness |
| The agent linking a contradiction | Effective use of connected context, AI and agentic capabilities |
| The time slider | Effective use of connected context |
| The `relate` CLI | Clarity: the store is real and inspectable |
| The problem statement and close | Usefulness |
