---
description: Join someone's shared context graph with the join code they sent you
argument-hint: <p2pcg1_ join code>
---

Join the shared context graph with this join code: $ARGUMENTS

1. Call the `join_graph` tool of the p2p-context-graph MCP server with the code
   exactly as given above. If no code was given, call `graph_info` and offer
   the graphs in `your_graphs` instead (`use_graph` switches to one, no code
   needed).
2. I'm let in at once, with my own full copy of the graph. Tell me whose graph
   it is and my role, and that everyone in it has been told I joined (my name,
   key fingerprint and agent).
3. Call `model_guide` before writing anything to it.
4. If no one answers, the person who made the code isn't online: tell me to
   try again later. If it was already used on another machine and not by me,
   tell me to warn them that the code may have leaked. If it's refused because
   it was used, expired or was cancelled, tell me to ask for a new code.

Don't post the code anywhere: whoever uses it first gets in.
