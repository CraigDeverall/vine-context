# Changelog

## Unreleased

### What a claim rests on

`basis` is a new model tool: it follows `SUPPORTS` back from a claim any number
of steps, as of a moment, and marks evidence that was replaced, withdrawn or is
contradicted by a current claim. The MCP server lists 26 tools.

The example story is longer to show it. The decision rests on evidence three
steps deep; by the end the headcount is replaced, one figure is withdrawn and a
second conflict is open. The example store holds 10 claims, 3 questions, 3
replies and 16 relationships.

### Other changes

- `vine example [DIR]` copies the example Relate store to a folder, to open
  with Relate's own CLI.
- The explorer draws each relationship type in its own colour and line.
- The "no signalling relay" warning shows only when no member is linked.
- Lines people read leave out item ids; what agents are told keeps them.
- The slogan is "Vine Context – P2P Shared Context Graphs", and the byline
  under the mark is "Shared Graphs".
- `npm run bench:churn` measures whether members who come and go end up with
  the same graph ([docs/MEASURED.md](docs/MEASURED.md)).

### Fewer, smaller MCP tools

The MCP server lists 25 tools instead of 40, and their definitions (name,
description and input schema, from `tools/list`) are 17,535 characters instead
of 28,346. Nothing was removed: tools that were pairs or overlaps are now one
tool with an action, a mode or an option.

| Before | Now |
| --- | --- |
| `start_sharing` | `sharing` with `action: "on"` |
| `stop_sharing` | `sharing` with `action: "off"` |
| `sharing_status` | `sharing` with `action: "status"` |
| `set_turn_server` | `turn_server` with `action: "set"` |
| `remove_turn_server` | `turn_server` with `action: "clear"` |
| `add_context` | `use_context` with `mode: "add"` |
| `remove_context` | `use_context` with `mode: "remove"` |
| `context_details` (`name`) | `context_info` with `details: true` (`context`) |
| `context_activity` | `recent` with `activity: true` |
| `take_back` | `withdraw`, which undoes a write that is still only on this machine (the result says `taken_back`), and withdraws it otherwise; `undo_only: true` never withdraws |
| `describe_context` (`description`) | `update_context` with `purpose` |
| `rename_context` (`name`, `to`) | `update_context` with `context` and `rename_to` |
| `set_my_name` (`name`) | `update_context` with `my_name` |
| `set_peer_role` | `manage_member` with `action: "set_role"` |
| `remove_peer` | `manage_member` with `action: "remove"` |
| `revoke_invite` (`id`) | `manage_member` with `action: "revoke_invite"` (`invite`) |
| `open_contexts` | `open_view` (the default view, `contexts`) |
| `open_console` | `open_view` with `view: "console"` |
| `explore_context` | `open_view` with `view: "explorer"` |
| `browser_view` | `open_view` with `browser: true` |

Unchanged: `add_claim`, `ask_question`, `reply`, `link`, `search`, `beliefs`,
`open_questions`, `thread`, `conflicts`, `history`, `model_guide`,
`join_context`, `share_context`, `find_context`, `link_folder`,
`delete_context`.

Also:

- Date arguments are listed as a plain `format: date` or `format: date-time`
  instead of a long validation pattern. They are checked as strictly as before
  where the call is handled, and a wrong one is refused with a message that
  says what a right one looks like.
- `withdraw` only undoes a new item without trace while nothing else links to
  it; otherwise it withdraws it, as before.
- `update_context` returns one key per thing changed (`purpose`, `renamed`,
  `my_name`).
- `open_view` is one tool for three views, so it names one view resource,
  `ui://vine/view`, which shows the view the call asked for.
- Where a name came from is reported as `chosen` (was `set_my_name`).
