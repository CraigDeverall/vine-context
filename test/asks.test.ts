// What a view's button says to the agent where the app can't run the view's
// tools: it lands in the chat as the person's own message, so it reads like one.

import { describe, expect, it } from "vitest";
import { asks } from "../apps/src/contexts/logic.js";

describe("what a view asks the agent", () => {
  it("is a plain request, not a tool call spelled out", () => {
    expect(asks("open_view", { view: "explorer" })).toBe("Open the context explorer.");
    expect(asks("open_view", { view: "explorer", at: "2026-03-01T09:00:00Z" })).toBe("Open the context explorer as it was at 2026-03-01T09:00:00Z.");
    expect(asks("open_view", { view: "console" })).toBe("Open the Vine console.");
    expect(asks("open_view", {})).toBe("Open this chat's contexts.");
    expect(asks("withdraw", { id: "x1", undo_only: true })).toBe("Take back the change x1, before it's sent to the other members.");
    expect(asks("withdraw", { id: "c_1", context: "team" })).toBe("Withdraw c_1 in the context 'team'.");
    expect(asks("share_context", { label: "Bob", role: "reader", context: "team" })).toBe("Make a join code for Bob with the role reader in the context 'team'.");
    expect(asks("link_folder", { name: "team", off: true })).toBe("Stop starting new chats in this folder with the context 'team'.");
    expect(asks("sharing", { action: "off" })).toBe("Go offline with this chat's context.");
    expect(asks("sharing", { action: "on", context: "team" })).toBe("Go back online with the context 'team'.");
    expect(asks("use_context", { name: "team" })).toBe("Use the context 'team' in this chat.");
    expect(asks("use_context", { name: "team", mode: "add" })).toBe("Add the context 'team' to this chat.");
    expect(asks("use_context", { name: "team", mode: "remove" })).toBe("Stop using the context 'team' in this chat.");
    expect(asks("update_context", { purpose: "Launch notes", context: "team" })).toBe("Change the description of the context 'team' to: Launch notes");
    expect(asks("update_context", { rename_to: "launch", context: "team" })).toBe("Rename the context 'team' to 'launch' on this machine.");
    expect(asks("update_context", { my_name: "Ally" })).toBe("Change my name in Vine Context to 'Ally'.");
    expect(asks("manage_member", { action: "set_role", name: "carol", role: "reader" })).toBe("Change carol's role to reader.");
    expect(asks("manage_member", { action: "remove", name: "carol" })).toBe("Remove carol from this chat's context.");
    expect(asks("manage_member", { action: "revoke_invite", invite: "inv2" })).toBe("Cancel the join code inv2.");
  });

  it("never reads as machinery for a tool the views use", () => {
    const calls: [string, Record<string, unknown>][] = [
      ["open_view", { view: "explorer" }],
      ["open_view", { view: "console" }],
      ["open_view", {}],
      ["use_context", { name: "team", description: "notes" }],
      ["use_context", { name: "team", mode: "add", write_here: true }],
      ["use_context", { name: "team", mode: "remove" }],
      ["link_folder", { name: "team" }],
      ["update_context", { purpose: "notes" }],
      ["update_context", { my_name: "Ally" }],
      ["update_context", { rename_to: "launch", context: "team" }],
      ["delete_context", { name: "team" }],
      ["share_context", { role: "reader" }],
      ["manage_member", { action: "revoke_invite", invite: "x1" }],
      ["manage_member", { action: "set_role", name: "carol", role: "reader" }],
      ["manage_member", { action: "remove", name: "carol" }],
      ["sharing", { action: "on" }],
      ["sharing", { action: "off" }],
      ["withdraw", { id: "x1", undo_only: true }],
      ["withdraw", { id: "x1" }],
    ];
    for (const [t, args] of calls) expect(asks(t, args)).not.toMatch(/tool|[{}_]/);
  });

  it("still says what to run for a tool it has no words for", () => {
    expect(asks("history", { id: "c1" })).toBe('Run the Vine Context tool history with {"id":"c1"}.');
  });
});
