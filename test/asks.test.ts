// What a view's button says to the agent where the app can't run the view's
// tools: it lands in the chat as the person's own message, so it reads like one.

import { describe, expect, it } from "vitest";
import { asks } from "../apps/src/contexts/logic.js";

describe("what a view asks the agent", () => {
  it("is a plain request, not a tool call spelled out", () => {
    expect(asks("explore_context", {})).toBe("Open the context explorer.");
    expect(asks("open_console", {})).toBe("Open the Vine console.");
    expect(asks("take_back", { id: "x1" })).toBe("Take back the change x1, before it's sent to the other members.");
    expect(asks("share_context", { label: "Bob", role: "reader", context: "team" })).toBe("Make a join code for Bob with the role reader in the context 'team'.");
    expect(asks("link_folder", { name: "team", off: true })).toBe("Stop starting new chats in this folder with the context 'team'.");
    expect(asks("stop_sharing", {})).toBe("Go offline with this chat's context.");
  });

  it("never reads as machinery for a tool the views use", () => {
    const tools = ["explore_context", "open_console", "open_contexts", "use_context", "add_context", "remove_context", "link_folder", "describe_context", "delete_context", "set_my_name", "share_context", "revoke_invite", "set_peer_role", "remove_peer", "start_sharing", "stop_sharing", "take_back", "withdraw"];
    for (const t of tools) expect(asks(t, { name: "team", id: "x1", role: "reader", description: "notes" })).not.toMatch(/tool|[{}_]/);
  });

  it("still says what to run for a tool it has no words for", () => {
    expect(asks("history", { id: "c1" })).toBe('Run the Vine Context tool history with {"id":"c1"}.');
  });
});
