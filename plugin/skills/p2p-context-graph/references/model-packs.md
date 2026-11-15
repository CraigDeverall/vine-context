# Model packs

A model pack is a folder that defines a context graph: its shape, the tools
agents get, and how agents should use them.

```
my-model/
  model.yaml          required: nodes, relationships, what is searchable
  tools.yaml          required: the tools
  instructions.md     recommended: guidance for agents, returned by model_guide
  migrations/         optional: NNN-name.cypher files, applied once each, in name order
```

Check a pack with `npx p2p-context-graph model validate my-model`. It reports
every problem it finds, then applies the model to a scratch graph.

The built-in `temporal-claims` pack is a complete example.

## model.yaml

```yaml
name: decision-log          # lower-case, dashes; a graph records which model it uses
version: 1                  # bump when you change the model
title: Decision log
description: >-
  One or two sentences. Agents see this in the server's instructions.

nodes:
  Decision:                 # a Cypher label
    description: A choice the team made, with its reasons.
    key: id                 # creates a uniqueness constraint
    title: text             # optional: the property views show as the node's label
    properties:             # documentation for agents and people; not enforced
      id: { type: id, required: true }
      text: { type: string, required: true, description: What was decided }
      decided_on: { type: date }

relationships:
  SUPERSEDES:
    description: The first decision replaces the second.
    from: [Decision]
    to: [Decision]

search:                     # optional: makes these labels searchable
  labels: [Decision]        # one vector index and one full-text index across them
  text: text                # the property both indexes read

time:                       # optional: lets the explorer show the graph at any moment
  recorded: recorded_at     # when a node or relationship entered the graph
  ended: withdrawn_at       # optional: when a node stopped being current
```

Property types are `string`, `integer`, `number`, `boolean`, `date`,
`datetime`, `id` and `list`.

With `search`, the server creates a vector index called `search_embedding`
(on the property `embedding`) and a full-text index called `search_text`.
Tools write the `embedding` property through a derived parameter (see below),
and query both indexes together with `COMBINE`.

Without `title`, views label a node with its `search.text` property, else its
key. Without `time`, the explorer shows the graph as it is now, with no time
slider. Nodes without a `key` don't appear in the explorer.

## tools.yaml

```yaml
fragments:                  # optional reusable Cypher snippets
  live: "%1.withdrawn_at IS NULL"

tools:
  - name: add_decision      # snake_case; becomes the MCP tool name
    title: Add a decision
    kind: write             # read | write
    role: contributor       # reader | contributor | admin; default reader for reads, contributor for writes
    description: >-
      What it does and when to use it. Agents choose tools from this text, so
      say when to use it and when to use another tool instead.
    input:
      text: { type: string, required: true, max_length: 2000, description: The decision }
      decided_on: { type: date, description: When it was made (YYYY-MM-DD) }
      supersedes: { type: array, items: id, description: Decisions it replaces }
    derive:
      id: { new_id: d }         # a fresh id such as d_k3m9p2qx
      embedding: { embed: text } # a vector of the text input, for search
    steps:
      - cypher: |               # a check: any row with a non-null _error stops the call
          WITH coalesce($supersedes, []) AS refs
          OPTIONAL MATCH (d:Decision) WHERE d.id IN refs
          WITH refs, collect(d.id) AS found
          RETURN CASE WHEN size(refs) <> size(found) THEN 'Unknown decision id.' END AS _error
      - cypher: |
          CREATE (d:Decision {id: $id, text: $text, embedding: $embedding,
                              recorded_at: datetime($now), recorded_by: $by})
          SET d.decided_on = CASE WHEN $decided_on IS NULL THEN null ELSE date($decided_on) END
          RETURN d.id AS id
        single: true            # return the first row, not a list
```

### Inputs

Each input has a `type`, a `description` (agents read it), and optionally
`required`, `default`, `max_length` (strings), and `min`/`max` (numbers).

| type | Agents send | Notes |
|---|---|---|
| `string` | text | up to `max_length`, or 20,000 characters |
| `id` | text | 1–64 characters |
| `integer`, `number`, `boolean` | JSON values | |
| `date` | `YYYY-MM-DD` | use `date($x)` in Cypher |
| `datetime` | ISO 8601 with offset | use `datetime($x)` in Cypher |
| `enum` | one of `values: [...]` | |
| `array` | a list of `items` (any scalar type above) | up to 100 items |

Optional inputs that are left out arrive as `null`. Unknown inputs are
rejected.

### Server parameters

Set on every call. Callers can never set them.

| Parameter | Value |
|---|---|
| `$now` | the call's time, ISO 8601: use `datetime($now)` |
| `$by` | the caller's identity |
| `$role` | the caller's role: `reader`, `contributor` or `admin` |

### Derived parameters

| `derive` | Gives |
|---|---|
| `{ new_id: <prefix> }` | a fresh id: the prefix, `_`, and 8 random characters |
| `{ embed: <input> }` | the input's text as a vector, for the `search_embedding` index |
| `{ terms: <input> }` | the input's text as plain search words, for the full-text index |

### Steps

All steps run in one transaction, in order. Only the parameters a step uses
are passed to it.

- If any row of any step has a non-null `_error` column, the call is rolled
  back and the agent sees that text as the error. Write errors that tell the
  agent what to do instead.
- The tool returns the last step's rows (one row with `single: true`). If any
  step has a `name`, it returns an object with each named step's rows instead.
- Temporal values come back as ISO strings. The `embedding` property is never
  returned.

### Views

A tool can name a built-in view that shows its result where the agent
supports MCP Apps (or in `p2pcg ui`):

```yaml
  - name: add_decision
    kind: write
    view: receipt             # what was written, with an undo button
    undo: { tool: withdraw }  # calls withdraw with { id: result.id }
```

- `receipt` (write tools) shows the call's input and result. With `undo`, it
  offers to call `undo.tool` with `{ [undo.arg]: result[undo.field] }`; `arg`
  and `field` default to `id`. The undo tool must exist; it is only offered to
  callers whose role allows it.
- `conflicts` shows rows that hold two items (map values, such as
  `a {.id, .text} AS claim, b {.id, .text} AS contradicts`) side by side,
  with the row's other columns as details.

### Fragments

`{{name a b}}` inserts the fragment's text, wrapped in parentheses, with `%1`,
`%2`, … replaced by `a`, `b`, …. Fragments can use other fragments.

## Cypher notes for Relate 1.0

- Hybrid search:
  ```cypher
  MATCH (n:A|B) SEARCH n IN (COMBINE (
    VECTOR INDEX search_embedding FOR $vector LIMIT 100 WEIGHT 1,
    FULLTEXT INDEX search_text FOR $terms LIMIT 100 WEIGHT 1
  ) USING WRRF WITH CONSTANT 60 LIMIT 100) SCORE AS score
  ```
- An alias defined in a `WITH` is not visible inside an `EXISTS { }` in that
  same `WITH`'s `WHERE`. Add a second `WITH` that passes the alias through,
  then filter.
- Relationship types can't be parameters. Use one
  `FOREACH (_ IN CASE WHEN $rel = 'X' THEN [1] ELSE [] END | CREATE …)` per
  type.
- `CALL (x) { UNWIND coalesce($list, []) AS i … RETURN count(*) AS n }` adds
  links for an optional list without losing the row when the list is empty.

## instructions.md

This is what `model_guide` returns, after a summary of the model. Write it
for an agent that has never seen the graph:

- what belongs in the graph and what doesn't;
- what to check before adding (search, link instead of duplicating);
- which tool answers which kind of question;
- how ids look, and that they must be copied, never invented.

## Changing a model

A graph keeps the model name and embedder it was created with. To change a
model, bump `version` and add a migration for any data change. Migrations run
once each, in name order, inside a transaction, when a graph opens with the
new pack. Statements in a migration file are separated by `;` at the end of a
line.
