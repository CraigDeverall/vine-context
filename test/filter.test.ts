// The Questions and Claims lists' filter: what shares its words, then the
// search's closest matches by meaning, marked.

import { describe, expect, it } from "vitest";
import { filtered, ids, RELATED } from "../apps/src/contexts/logic.js";

const items = ["a", "b", "c", "d", "e", "f", "g", "h"].map((key) => ({ key, words: key === "b" || key === "e" }));
const run = (near: string[] | null | undefined) => filtered(items, (x) => x.key, (x) => x.words, near);

describe("the filter", () => {
  it("keeps word matches first, then adds what the search found in its order, once each", () => {
    const { list, byMeaning } = run(["e", "g", "zzz", "a"]);
    expect(list.map((x) => x.key)).toEqual(["b", "e", "g", "a"]);
    expect([...byMeaning]).toEqual(["g", "a"]);
  });

  it("adds at most RELATED by meaning", () => {
    const { byMeaning } = run(items.map((x) => x.key));
    expect(byMeaning.size).toBe(RELATED);
  });

  it("is the word filter alone while the search hasn't answered", () => {
    expect(run(null).list.map((x) => x.key)).toEqual(["b", "e"]);
    expect(run(undefined).byMeaning.size).toBe(0);
  });

  it("reads ids from search rows, ignoring anything else", () => {
    expect(ids([{ id: "c_1" }, { kind: "claim" }, null, { id: 3 }, { id: "q_2" }])).toEqual(["c_1", "q_2"]);
    expect(ids("not rows")).toEqual([]);
  });
});
