---
name: join-context-graph
description: Join someone else's shared context graph (p2p-context-graph) with the join code they sent. Use when the person pastes a code starting p2pcg1_, says "join my context graph", runs /p2p-context-graph:join, or asks to rejoin a context graph they joined before.
---

# Join a shared context graph

**First: is it their own graph?** If the person names a graph and gives no
code, call `graph_info`: if that name is in its `your_graphs` (graphs on this
machine), it's theirs. Call `use_graph` with that name instead of joining;
joining is only for someone else's graph. `use_graph` also leaves any graph
this session joined.

1. Call `join_graph` on the p2p-context-graph MCP server with the code exactly
   as given (it may be inside other text). With no code, `join_graph` rejoins
   the last graph this machine joined.
2. They are let in at once. Tell them whose graph it is, their role, and that
   everyone in it has been told they joined (their name, key fingerprint and
   agent).
3. Call `model_guide` before writing. The graph tools act on the host's graph until `leave_graph`.
4. If it's refused because the code was used on another machine, has expired
   or was cancelled, tell the person to ask the host for a new code of their own.
   If it was already used and not by them, they should warn the host: the code
   may have leaked.
   An old `p2pcg://` link no longer works either.
   If the host doesn't answer, it may not be sharing right now; to get back
   to their own graph meanwhile, call `use_graph` (or `leave_graph`).

**More than one context-graph server:** an agent can have several (for example
a second identity set up for testing, such as `p2p-context-graph-bob`). Each
is a separate person with its own name and key. Use the one the person names;
otherwise use `p2p-context-graph`, which is them. Say which one you used.

The code is tied to this machine once used; don't post it anywhere.
