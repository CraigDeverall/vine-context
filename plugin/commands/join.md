---
description: Join someone's shared context graph with the join code they sent you
argument-hint: <p2pcg1_ join code>
---

Join the shared context graph with this join code: $ARGUMENTS

1. Call the `join_graph` tool of the p2p-context-graph MCP server with the code
   exactly as given above. If no code was given, call `join_graph` with no code:
   it rejoins the last graph this machine joined.
2. If the result says you are waiting for approval, tell me the name and key
   fingerprint it shows, and say that the host has to approve me. They should
   check the fingerprint with me first, by a channel we both trust (a call, or
   a chat we already use). Don't approve anything yourself.
3. Once I'm approved (call `graph_info` to check), the graph tools act on the
   host's graph. Call `model_guide` before writing anything to it.
4. If it's refused because the code was already used on another machine, has
   expired or was cancelled, tell me to ask the host for a new code of my own.

The code is tied to this machine once I'm approved, so I can rejoin with it in
later sessions. Don't post it anywhere.
