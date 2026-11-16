---
description: Join someone's shared context graph with the join code they sent you
argument-hint: <p2pcg1_ join code>
---

Join the shared context graph with this join code: $ARGUMENTS

1. Call the `join_graph` tool of the p2p-context-graph MCP server with the code
   exactly as given above. If no code was given, call `join_graph` with no code:
   it rejoins the last graph this machine joined.
2. I'm let in at once. Tell me whose graph it is and my role, and that everyone
   in it has been told I joined (my name, key fingerprint and agent).
3. The graph tools now act on the host's graph. Call `model_guide` before
   writing anything to it.
4. If it was already used on another machine and not by me, tell me to warn
   the host that the code may have leaked. If it's refused because it was used,
   expired or was cancelled, tell me to ask the host for a new code of my own.

The code is tied to this machine once I've used it, so I can rejoin with it in
later sessions. Don't post it anywhere.
