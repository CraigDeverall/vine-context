# What was measured

One measurement, which you can rerun from a clone of this repo. It says what was run, what came out, and what the number does not show.

Back to the [README](../README.md).

## Do copies end up the same?

This is the claim the project rests on: members who come and go, and write while they are apart, all end up holding the same graph.

```bash
npm run bench:churn -- --runs 100
```

Each run is a process of its own, which starts five hosts. They join with real join codes and link over real WebRTC data channels, and they find each other on an in-process bus, so no network is needed. Then, for twelve rounds, each member may go offline or come back, and each writes one to three changes to its own copy from what it can see there: claims that support, contradict or replace others, questions, replies, links and withdrawals. Nobody waits for anybody. At the end everyone comes back, and the run passes if all five change logs hold the same changes and all five Relate graphs are identical: the same nodes and relationships with the same properties, and the same answers from `beliefs`, `open_questions` and `conflicts`.

| | |
|---|---|
| Runs | 100 |
| Runs where all five copies ended identical | **100** |
| Changes written | 11,941, of which 5,683 while their author was offline |
| Times a member went offline or came back | 1,858 |
| Writes a copy refused | 29 |
| Time from everyone coming back to every copy agreeing | median 1.8 s, 95th percentile 3.6 s, longest 5.1 s |

Run on 27 Nov 2026 on a Mac (macOS, arm64, Node 22.17) with seed 1. The full results are in [`measured/churn.json`](measured/churn.json).

**What it does not show.** The five hosts share one machine and one clock, and their links never cross a real network, so this says nothing about NAT, relays or slow links. A context is sized for about 20 members, and this used five. The writes are random, not a team's real work.
