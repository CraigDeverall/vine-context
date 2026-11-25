// The STUN/TURN setting: what `vine turn set` stores, what links are given,
// and what status shows. No network: the test against a real TURN server is
// turn.test.ts.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_STUN, checkStoredTurn, clearTurn, parseHostPort, readTurn, resolveIce, rtcConfig, saveTurn, storedIce } from "../src/p2p/ice.js";
import { tempDir } from "./helpers.js";
import type { PeerConnection } from "node-datachannel";
import { routeOf } from "../src/p2p/mesh.js";

const PASSWORD = "p:a@ss word";

afterEach(() => {
  delete process.env.VINE_ICE;
  delete process.env.VINE_TURN_PASSWORD;
});

describe("the TURN setting", () => {
  it("has no TURN server by default: the public STUN servers only", () => {
    const { config, summary } = resolveIce(tempDir());
    expect(config.servers).toEqual(DEFAULT_STUN);
    expect(summary).toEqual({ stun: DEFAULT_STUN, turn: null, source: "default" });
  });

  it("adds a saved TURN server to the STUN servers, and never shows its password", () => {
    const dir = tempDir();
    saveTurn(dir, { host: "turn.example.org", username: "sam", password: PASSWORD });
    const { config, summary } = resolveIce(dir);
    expect(config.servers).toEqual([...DEFAULT_STUN, { hostname: "turn.example.org", port: 3478, username: "sam", password: PASSWORD, relayType: "TurnUdp" }]);
    expect(summary).toEqual({ stun: DEFAULT_STUN, turn: "turn.example.org:3478 (udp)", source: "setting", provider: "custom" });
    expect(JSON.stringify(summary)).not.toContain(PASSWORD);
  });

  it.skipIf(process.platform === "win32")("keeps the file readable by its owner only", () => {
    const dir = tempDir();
    saveTurn(dir, { host: "turn.example.org", username: "sam", password: PASSWORD });
    expect(statSync(join(dir, "network.json")).mode & 0o777).toBe(0o600);
  });

  it("uses the usual port for the transport unless one is given", () => {
    const dir = tempDir();
    expect(saveTurn(dir, { host: "t.example", username: "u", password: "p", transport: "tls" })).toMatchObject({ port: 5349, transport: "tls" });
    expect(saveTurn(dir, { host: "t.example", port: 443, username: "u", password: "p", transport: "tcp" })).toMatchObject({ port: 443, transport: "tcp" });
    expect(resolveIce(dir).config.servers.at(-1)).toMatchObject({ port: 443, relayType: "TurnTcp" });
  });

  it("with the env store, saves no password and reads VINE_TURN_PASSWORD when a link is made", () => {
    const dir = tempDir();
    expect(() => saveTurn(dir, { host: "t.example", username: "u", password: "p", store: "env" })).toThrow(/VINE_TURN_PASSWORD/);
    saveTurn(dir, { host: "t.example", username: "u", store: "env" });
    expect(readFileSync(join(dir, "network.json"), "utf8")).not.toContain("password");
    // Not set here: direct connections still work, and status says why the server isn't used.
    expect(resolveIce(dir).config.servers).toEqual(DEFAULT_STUN);
    expect(resolveIce(dir).summary).toMatchObject({ turn: "t.example:3478 (udp)", problem: expect.stringContaining("VINE_TURN_PASSWORD") });
    process.env.VINE_TURN_PASSWORD = PASSWORD;
    expect(resolveIce(dir).config.servers.at(-1)).toMatchObject({ hostname: "t.example", password: PASSWORD });
    expect(resolveIce(dir).summary.problem).toBeUndefined();
  });

  it("refuses a setting it couldn't use", () => {
    const dir = tempDir();
    expect(() => saveTurn(dir, { host: "t.example", username: "u" })).toThrow(/password/i);
    expect(() => saveTurn(dir, { host: "", username: "u", password: "p" })).toThrow();
    expect(() => saveTurn(dir, { host: "t.example", port: 70000, username: "u", password: "p" })).toThrow();
    expect(readTurn(dir)).toBeUndefined();
  });

  it("is picked up by a source that is already in use, and dropped when cleared", () => {
    const dir = tempDir();
    const source = storedIce(dir);
    expect(rtcConfig(source).iceServers).toEqual(DEFAULT_STUN);
    saveTurn(dir, { host: "t.example", username: "u", password: "p" });
    expect(rtcConfig(source).iceServers).toHaveLength(DEFAULT_STUN.length + 1);
    expect(clearTurn(dir)).toBe(true);
    expect(rtcConfig(source).iceServers).toEqual(DEFAULT_STUN);
    expect(clearTurn(dir)).toBe(false);
  });

  it("VINE_ICE replaces the defaults and the setting, and status hides its password", () => {
    const dir = tempDir();
    saveTurn(dir, { host: "t.example", username: "u", password: "p" });
    process.env.VINE_ICE = "stun:stun.example:3478, turn:sam:hunter2@turn.example:3478";
    const { config, summary } = resolveIce(dir);
    expect(config.servers).toEqual(["stun:stun.example:3478", "turn:sam:hunter2@turn.example:3478"]);
    expect(summary).toEqual({ stun: ["stun:stun.example:3478"], turn: "turn:turn.example:3478", source: "env" });
    process.env.VINE_ICE = "";
    expect(resolveIce(dir).config.servers).toEqual([]);
  });

  it("ignores a file that isn't a setting", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "network.json"), '{"turn":{"host":"x"}}');
    expect(resolveIce(dir).summary.source).toBe("default");
    writeFileSync(join(dir, "network.json"), "not json");
    expect(resolveIce(dir).summary.source).toBe("default");
  });

  it("passes a fixed list and a relay-only policy through to the connection", () => {
    expect(rtcConfig([])).toEqual({ iceServers: [] });
    expect(rtcConfig(() => ({ servers: DEFAULT_STUN, policy: "relay" }))).toEqual({ iceServers: DEFAULT_STUN, iceTransportPolicy: "relay" });
  });

  it("reads host and host:port", () => {
    expect(parseHostPort("turn.example.org")).toEqual({ host: "turn.example.org" });
    expect(parseHostPort("turn.example.org:5349")).toEqual({ host: "turn.example.org", port: 5349 });
    expect(parseHostPort("[::1]:3478")).toEqual({ host: "::1", port: 3478 });
    expect(() => parseHostPort("turn:sam:pw@host:3478")).toThrow(/host:port/);
  });

  it("says so when there's nothing to check, or no password to check with", async () => {
    const dir = tempDir();
    expect(await checkStoredTurn(dir)).toMatchObject({ ok: false, turn: null });
    saveTurn(dir, { host: "t.example", username: "u", store: "env" });
    expect(await checkStoredTurn(dir)).toMatchObject({ ok: false, turn: "t.example:3478 (udp)", error: expect.stringContaining("VINE_TURN_PASSWORD") });
  });
});

describe("a link's route", () => {
  const pc = (pair: unknown) => ({ getSelectedCandidatePair: () => pair }) as unknown as PeerConnection;
  it("is relayed when either end of the pair is a TURN relay address, and direct otherwise", () => {
    expect(routeOf(pc({ local: { type: "relay" }, remote: { type: "host" } }))).toBe("relayed");
    expect(routeOf(pc({ local: { type: "prflx" }, remote: { type: "relay" } }))).toBe("relayed");
    expect(routeOf(pc({ local: { type: "host" }, remote: { type: "srflx" } }))).toBe("direct");
  });
  it("is unknown until a pair is chosen, or when the library can't say", () => {
    expect(routeOf(pc(null))).toBeUndefined();
    const broken = { getSelectedCandidatePair: () => { throw new Error("closed"); } } as unknown as PeerConnection;
    expect(routeOf(broken)).toBeUndefined();
  });
});

