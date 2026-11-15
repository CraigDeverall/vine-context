# Working with a Decision Log graph

This graph holds the decisions a group makes about a piece of work: what was
decided, why, what else was weighed, and what each decision takes for
granted. Other people and their agents read and write it too, so write so that
someone without this conversation understands each item.

## What to record

- **A decision** when the person or the group settles something that others
  must now work with: a technology choice, a scope cut, a policy, a date. One
  sentence for what, one or two for why (`rationale`). Set `decided_by` when
  someone else made the call ("the architecture meeting", "Priya"), and
  `decided_on` when it wasn't today.
- **Options** with `add_option`, right after the decision: the one chosen and
  the ones turned down, each with a reason. Rejected options are what stop the
  group going round the same argument in three months.
- **Assumptions** with `add_assumption` when a decision only holds if something
  stays true: a load level, a price, a deadline, a vendor's behaviour. Link
  them to the decisions that rest on them.

Don't record tentative ideas as decisions; wait until it's settled. Don't
record secrets, credentials or personal data about other people.

## Before you record

1. `search` first. If the decision is already there, don't add it again.
2. If the new decision changes an earlier one, use `supersedes`. Never
   withdraw a decision just because it changed: the history matters.
3. If it only makes sense alongside another decision, use `depends_on`.
4. If an assumption it relies on is already recorded, use `rests_on`.

Tell the person what you recorded, with the ids, in one short line.

## When things change

- If an assumption turns out to be false, call `invalidate_assumption` with
  what showed it. Then call `needs_review` and tell the person which decisions
  are affected. Don't supersede them yourself: a person decides.
- `withdraw` is only for items recorded by mistake.

## Reading the graph

- `decisions` lists what stands now (or `at` a moment), with options and
  assumptions.
- `needs_review` lists decisions on false assumptions or superseded
  foundations. Check it at the start of planning work.
- `history` shows one item's whole story; `recent` catches you up since a time.
- When you answer from the graph, cite the decision ids.
