# Working with a Claims and Questions graph

This graph holds what a group knows about a piece of work. Other people and
their agents read and write the same graph, so record things they would want
to know, and write so that someone without this conversation can understand
them.

## What to record

- **A claim** is one statement someone believes is true: a finding, a decision,
  a fact about the system, a measurement, a commitment. Keep it to one or two
  sentences, and make it stand alone. Write "The orders database pool hit its
  limit of 50 connections at 13:57 on 10 Nov", not "the pool ran out".
- **A question** is something the group needs to find out. Record it when the
  person raises it or when you hit an unknown that matters to others.
- Add a `source` when there is one: a URL, a file path, a ticket, a meeting, a
  person.
- Use `about_from` and `about_to` when the claim is about a period ("the
  outages between 1 and 7 November"). Leave them out for timeless claims.

Don't record chit-chat, your own plans for this conversation, or anything the
person asked you to keep private. Don't record secrets, credentials or personal
data about other people.

## Before you add

1. `search` for the topic first. If a matching claim exists, link to it
   instead of adding a duplicate.
2. If your claim is evidence for an existing one, use `supports`.
3. If it can't be true at the same time as an existing one, use `contradicts`.
   Don't decide who is right. The conflict is visible to everyone until a
   person settles it.
4. If it corrects or updates an existing claim, use `replaces`. Don't
   withdraw. The old claim stays in the history, and `beliefs` stops listing
   it.
5. If it answers an open question, use `answers`.

Tell the person what you recorded, with the ids, in one short line.

## Threads and answers

Each question has a thread of replies, where the group works it out.

- `thread` reads a question with its replies and any answering claims. Read it
  before you reply or answer.
- `reply` adds a message to the thread: a partial finding, an idea to check, a
  question back. Keep replies short and say who or what they come from.
- A reply never closes a question. When the person gives you an answer (they
  may paste it, or pick a reply from the thread), paraphrase it as a claim that
  stands alone, and record it with `add_claim` and `answers: [question id]`.
  Credit the reply in `source` if it came from one. Don't copy a reply word for
  word as the claim, and don't answer for the person: ask if it isn't settled.

## Reading the graph

| To find | Use |
|---|---|
| Anything about a topic | `search` |
| What the group believes now, or believed at some moment | `beliefs` (with `at` for the past) |
| What still needs finding out | `open_questions` |
| What's been said about a question | `thread` |
| Disagreements to settle | `conflicts` |
| The full story of one item | `history` |
| What a claim rests on, and whether that evidence still stands | `basis` |
| What changed since you last looked | `recent` |

At the start of a session on a shared graph, call `recent` with a `since` of
the last time you looked, or `open_questions`, so you work from what others
have found.

Every read tool takes `at`, an ISO 8601 time, to see the graph as it stood
then. Use it for questions like "what did we think on Tuesday?". It reads
record time: when the graph learned something, not when that thing happened.
`about_from` and `about_to` describe when it happened.

## Ids

Ids look like `c_k3m9p2qx` (claims), `q_7hd2mxwa` (questions) and `r_…` (replies). Copy them
exactly from tool results. Never invent one.
