# What was measured

Two measurements, both of which you can rerun from a clone of this repo. Each section says what was run, what came out, and what the number does not show.

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

**What it does not show.** The five hosts share one machine and one clock, and their links never cross a real network, so this says nothing about NAT, relays or slow links. A context is sized for about 20 members, and this used five. An earlier version ran all 100 runs inside one process, and after about 80 of them new members could not connect for a while. No copies differed, and it did not happen with a process for each run, which is how hosts run, but what a host does after thousands of links in one lifetime has not been looked into. The writes are random, not a team's real work.

## What can one person answer alone?

The example story has four people, and each saw only part of it. The measurement takes 18 questions a teammate would ask, such as *Can a judge install it from npm with one command today?* and *Why did CI never start on pull request 33?* Each has one right answer, and the questions name the claims the answers rest on ([`scripts/recall-questions.ts`](../scripts/recall-questions.ts)).

```bash
npm run bench:recall
```

For each person, the script takes only the changes that person signed, from the example's change log. A question is **right** when their own notes hold what the right answer rests on. It is **out of date** when they hold a claim that was true once and that someone else has since replaced, so their notes point at a wrong answer. Otherwise they **can't tell**. For the shared graph, the same test is run on what the vine tools (`beliefs`, `open_questions`, `conflicts`) return from the example's Relate store.

| From | Right | Out of date | Can't tell |
|---|---|---|---|
| Craig's own notes | 8 | 1 | 9 |
| Craigslist's own notes | 2 | 2 | 14 |
| Craigosaurus Rex's own notes | 1 | 5 | 12 |
| Craiginator's own notes | 6 | 0 | 12 |
| The shared graph | 18 | 0 | 0 |

The best any one person can do alone is 8 of 18, and between them they hold 8 answers that are out of date. Of the nine times in the story that a claim was replaced or contradicted, six were by someone other than the claim's author: corrections that a memory kept by one person's agent would never receive.

**What it does not show.** No model answered anything here: the table is worked out from who wrote what, so it says what each person's notes *could* support, not what an agent would actually say. The story was written to show the features, with made-up people, so the split of who knows what is ours, not a real team's. That the shared graph holds every answer is true by construction. What the run checks is that the store really returns them, with nothing out of date in the current view.

**Asking a model.** `npm run bench:recall -- --ask` gives the same notes to a Claude model through the `claude` command (which must be logged in), once for each person and once for the shared graph, and marks its answers against the key. This has not been run yet, so there is no result to report.
