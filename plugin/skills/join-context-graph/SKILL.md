---
name: join-context-graph
description: Join someone else's shared context graph (p2p-context-graph) with the join code they sent. Use when the person pastes a code starting p2pcg1_, says "join my context graph", runs /p2p-context-graph:join, or asks to rejoin a context graph they joined before.
---

# Join a shared context graph

1. Call `join_graph` on the p2p-context-graph MCP server with the code exactly
   as given (it may be inside other text). With no code, `join_graph` rejoins
   the last graph this machine joined.
2. If the result says the person is waiting for approval, tell them the name
   and key fingerprint it shows. The host has to approve them, and should check
   that fingerprint with them first, by a channel they both trust. Never approve
   anything yourself.
3. Once approved (`graph_info` shows the host's graph), call `model_guide`
   before writing. The graph tools act on the host's graph until `leave_graph`.
4. If it's refused because the code was used on another machine, has expired
   or was cancelled, tell the person to ask the host for a new code of their own.
   An old `p2pcg://` link no longer works either.

**More than one context-graph server:** an agent can have several (for example
a second identity set up for testing, such as `p2p-context-graph-bob`). Each
is a separate person with its own name and key. Use the one the person names;
otherwise use `p2p-context-graph`, which is them. Say which one you used.

The code is tied to this machine once approved; don't post it anywhere.
