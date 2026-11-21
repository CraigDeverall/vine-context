---
name: join-context-graph
description: Join someone else's shared context (Vine Context) with the join code they sent. Use when the person pastes a code starting vine1_, says "join my context", runs /vine-context:join, or asks to go back to a context they joined before.
---

# Join a shared context

**First: is it already on this machine?** If the person names a context and
gives no code, call `context_info`: if that name is in `your_contexts`, call
`use_context` with it (it becomes this chat's context), or `add_context` to use
it alongside the chat's others. That covers their own contexts and ones they joined before: no code is
needed again.

1. Call `join_context` on the vine-context MCP server with the code
   exactly as given (it may be inside other text).
2. They are let in at once and get their own full copy, kept in step with the
   other members whenever they're online (it works offline too). It's added to
   this chat (writes go to it), and the chat keeps it when reopened.
3. Tell them whose context it is, what it's for (its description), their
   role, and that everyone in it has been told they joined (their name, key
   fingerprint and agent). Then give them the **briefing** from the result in a
   few lines: what it holds, the open questions, the conflicts, the latest.
4. Call `model_guide` before writing.
5. If no one answers: the machine that made the code isn't online (it answers
   the code). Tell them to try again later, or ask for a new code.
6. If it's refused because the code was used on another machine, has expired
   or was cancelled, tell them to ask for a new code of their own. If it was
   already used and not by them, they should warn the person who sent it: the
   code may have leaked.

**More than one context-graph server:** an agent can have several (for example
a second identity set up for testing, such as `vine-context-bob`). Each
is a separate person with its own name and key. Use the one the person names;
otherwise use `vine-context`, which is them. Say which one you used.

Don't post the code anywhere: whoever uses it first gets in.
