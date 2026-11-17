---
name: join-context-graph
description: Join someone else's shared context graph (p2p-context-graph) with the join code they sent. Use when the person pastes a code starting p2pcg1_, says "join my context graph", runs /p2p-context-graph:join, or asks to go back to a context graph they joined before.
---

# Join a shared context graph

**First: is it already on this machine?** If the person names a graph and
gives no code, call `graph_info`: if that name is in `your_graphs`, call
`use_graph` with it. That covers their own graphs and ones they joined before:
no code is needed again.

1. Call `join_graph` on the p2p-context-graph MCP server with the code exactly
   as given (it may be inside other text).
2. They are let in at once and get their own full copy of the graph, kept in
   step with the other members whenever they're online (it works offline too).
   Tell them whose graph it is, their role, and that everyone in it has been
   told they joined (their name, key fingerprint and agent).
3. Call `model_guide` before writing. This session now works on that graph;
   `use_graph` switches back to another.
4. If no one answers: the machine that made the code isn't online (it answers
   the code). Tell them to try again later, or ask for a new code.
5. If it's refused because the code was used on another machine, has expired
   or was cancelled, tell them to ask for a new code of their own. If it was
   already used and not by them, they should warn the person who sent it: the
   code may have leaked. An old `p2pcg://` link no longer works either.

**More than one context-graph server:** an agent can have several (for example
a second identity set up for testing, such as `p2p-context-graph-bob`). Each
is a separate person with its own name and key. Use the one the person names;
otherwise use `p2p-context-graph`, which is them. Say which one you used.

Don't post the code anywhere: whoever uses it first gets in.
