---
name: p2p-context-graph
description: Use a shared context graph (p2p-context-graph, the p2pcg tools) to record and look up what a group knows, such as claims, questions, decisions and findings, and to design new context models for it. Use when the p2p-context-graph MCP tools are available and the work produces or needs knowledge others would want, when the person mentions a context graph, shared context, claims, open questions or what the team believes, or asks to create, change or validate a context model or model pack.
---

# p2p-context-graph

A context graph is a Relate graph database, on the person's machine, that
holds what a group knows. Its **model** (a model pack) decides what goes in it
and which tools exist. The default model, `temporal-claims`, records dated
claims and open questions. Other people's agents may read and write the same
graph, so what you record should make sense to someone who never saw this
conversation.

The tools are on the `p2p-context-graph` MCP server. Two are always there:

- `graph_info`: which graph and model this is, and how big it is.
- `model_guide`: the model's own instructions. **Call it once before you first
  write in a conversation, and follow it.** It overrides general habits.

The rest come from the model. For `temporal-claims` they are `add_claim`,
`ask_question`, `link`, `withdraw`, `search`, `beliefs`, `open_questions`,
`conflicts`, `history` and `recent`.

## Working with the graph

1. At the start of work on a topic, `search` it, or call `recent` or
   `open_questions`, so you build on what is already known.
2. Record as you go, not in a batch at the end: a finding when you confirm it,
   a question when it comes up, a decision when it's made.
3. Search before you add, then link instead of duplicating.
4. After writing, tell the person in one line what you recorded, with the ids.
5. Never invent ids. Copy them from tool results.

Don't record secrets, credentials, personal data about other people, or
anything the person asked to keep out. If unsure whether something belongs in a
shared graph, ask.

If a tool returns an error, read it. It says what to fix, such as an unknown
id or a missing permission. Don't retry the same call unchanged.

## Designing a context model

People can define their own models: the node types, relationships, and the
tools agents get. When asked to create or change one, follow
[references/model-packs.md](references/model-packs.md):

1. **Interview** briefly. What is the work? What do people need to look up
   later? What changes over time, and does the history matter? Who writes:
   agents, people, or both?
2. **Draft** the pack: `model.yaml` (shape), `tools.yaml` (operations, with
   parameterised Cypher), and `instructions.md` (when and how agents use it).
   Start from `temporal-claims` when the work is about findings and questions.
   Keep tools few and task-shaped, like `add_decision` and `open_risks`, not
   generic CRUD.
3. **Validate**: `npx p2p-context-graph model validate <dir>`. It checks the
   files and applies the schema to a scratch graph. Fix every error it lists.
4. **Try it**: open a test graph with the pack
   (`P2PCG_GRAPH=try-<name> P2PCG_MODEL=<dir>`), call each tool once, and read
   the results.
5. Show the person the model and the tool list before they use it on a real
   graph. A graph keeps the model it was created with.

## Troubleshooting

- `npx p2p-context-graph doctor` checks Node, Relate, WebRTC support, the model
  packs and the data folder.
- One graph can be open in one process at a time. If a second session can't
  open it, close the other session's server, or use another graph name
  (`P2PCG_GRAPH`).
- Graphs are stored in `~/.local/share/p2p-context-graph/graphs/<name>`
  (`P2PCG_DATA_DIR` overrides this).
