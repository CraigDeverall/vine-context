// Cloudflare Realtime TURN: minting short-lived credentials from a TURN key,
// caching them until near expiry, refreshing, and creating a key with an API
// token. Cloudflare's API is mocked; the keychain is too, so nothing real is
// touched.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keychain = new Map<string, string>();
vi.mock("../src/core/secret.js", async (orig) => ({
  ...(await orig<typeof import("../src/core/secret.js")>()),
  keychainTool: () => "security",
  keychainSet: (service: string, account: string, password: string) => void keychain.set(`${service}/${account}`, password),
  keychainGet: (service: string, account: string) => keychain.get(`${service}/${account}`),
  keychainDelete: (service: string, account: string) => void keychain.delete(`${service}/${account}`),
}));

const cf = await import("../src/p2p/cloudflare.js");
const ice = await import("../src/p2p/ice.js");
const { tempDir } = await import("./helpers.js");

const KEY_ID = "0123456789abcdef0123456789abcdef";
const SECRET = "s".repeat(64);
const ACCOUNT = "fedcba9876543210fedcba9876543210";

/** A Cloudflare answer like the docs' example. */
const iceAnswer = (n: number) => ({
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: `user-${n}`,
      credential: `cred-${n}`,
    },
  ],
});

type Call = { url: string; init: RequestInit };
let calls: Call[];
let reply: (call: Call) => Response;

beforeEach(() => {
  calls = [];
  keychain.clear();
  ice.forgetMinted();
  reply = () => new Response(JSON.stringify(iceAnswer(calls.length)), { status: 201 });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return reply(call);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.VINE_ICE;
  delete process.env[ice.CLOUDFLARE_SECRET_ENV];
});

describe("Cloudflare's TURN URLs", () => {
  it("become node-datachannel servers: UDP 3478 first, then TLS on 443; port 53 and STUN left out", () => {
    const servers = cf.pickServers(iceAnswer(1).iceServers[1]!.urls, "u", "c");
    expect(servers.map((s) => `${s.relayType}:${s.port}`)).toEqual(["TurnUdp:3478", "TurnTls:443", "TurnTcp:3478"]);
    expect(servers[0]).toEqual({ hostname: "turn.cloudflare.com", port: 3478, username: "u", password: "c", relayType: "TurnUdp" });
    expect(cf.toIceServer("turn:turn.cloudflare.com:53?transport=udp", "u", "c")).toBeUndefined();
    expect(cf.toIceServer("stun:stun.cloudflare.com:3478", "u", "c")).toBeUndefined();
  });
});

describe("minting credentials", () => {
  it("posts the ttl to the generate-ice-servers endpoint, with the key secret only in the Authorization header", async () => {
    const m = await cf.mintCredentials(KEY_ID, SECRET, { ttl: 3600, now: () => 1_000_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ttl: 3600 });
    expect(calls[0]!.url).not.toContain(SECRET);
    expect(m).toMatchObject({ username: "user-1", expiresAt: 1_000_000 + 3600_000 });
    expect(m.servers[0]).toMatchObject({ password: "cred-1" });
  });

  it("explains a refused key", async () => {
    reply = () => new Response(JSON.stringify({ errors: [{ message: "Unauthorized" }] }), { status: 401 });
    await expect(cf.mintCredentials(KEY_ID, SECRET)).rejects.toThrow(/HTTP 401.*Unauthorized.*copied whole/);
  });

  it("refuses an answer with no credentials", async () => {
    reply = () => new Response(JSON.stringify({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] }), { status: 201 });
    await expect(cf.mintCredentials(KEY_ID, SECRET)).rejects.toThrow(/no TURN credentials/);
  });
});

describe("the Cloudflare TURN setting", () => {
  it("keeps the key's secret in the keychain, never in network.json", () => {
    const dir = tempDir();
    ice.saveCloudflareTurn(dir, { keyId: KEY_ID, secret: SECRET, name: "vine-test" });
    const file = readFileSync(join(dir, "network.json"), "utf8");
    expect(file).not.toContain(SECRET);
    expect(JSON.parse(file).turn).toEqual({ provider: "cloudflare", keyId: KEY_ID, store: "keychain", name: "vine-test" });
    expect(keychain.get(`vine-context-turn/cloudflare:${KEY_ID}`)).toBe(SECRET);
    // Not a server of your own, so the custom-server reader doesn't see it.
    expect(ice.readTurn(dir)).toBeUndefined();
    expect(ice.readCloudflare(dir)).toMatchObject({ keyId: KEY_ID });
  });

  it("mints at connect time (prepare), caches until near expiry, and mints again after", async () => {
    const dir = tempDir();
    ice.saveCloudflareTurn(dir, { keyId: KEY_ID, secret: SECRET });
    const source = ice.storedIce(dir) as Exclude<import("../src/p2p/ice.js").IceSource, unknown[]>;
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    await ice.prepareIce(source);
    expect(calls).toHaveLength(1);
    const first = source().servers;
    expect(first.slice(0, 2)).toEqual(ice.DEFAULT_STUN);
    expect(first[2]).toMatchObject({ hostname: "turn.cloudflare.com", username: "user-1", password: "cred-1" });
    expect(ice.resolveIce(dir).summary).toMatchObject({ provider: "cloudflare", turn: ice.CLOUDFLARE_LABEL, expires: new Date(now + cf.CREDENTIAL_TTL * 1000).toISOString() });
    expect(JSON.stringify(ice.resolveIce(dir).summary)).not.toContain("cred-1");

    // Reconnects while they're fresh use the cache.
    now += 3600_000;
    await ice.prepareIce(source);
    await ice.prepareIce(source);
    expect(calls).toHaveLength(1);

    // Within the last hour: the next connection mints new ones.
    now += (cf.CREDENTIAL_TTL - 3600 - 600) * 1000;
    await ice.prepareIce(source);
    expect(calls).toHaveLength(2);
    expect(source().servers[2]).toMatchObject({ username: "user-2" });
  });

  it("asks once when several links want credentials at the same moment", async () => {
    const dir = tempDir();
    ice.saveCloudflareTurn(dir, { keyId: KEY_ID, secret: SECRET });
    await Promise.all([ice.refreshIce(dir), ice.refreshIce(dir), ice.refreshIce(dir)]);
    expect(calls).toHaveLength(1);
  });

  it("falls back to STUN only, says why, and waits before asking again when Cloudflare refuses", async () => {
    const dir = tempDir();
    ice.saveCloudflareTurn(dir, { keyId: KEY_ID, secret: SECRET });
    reply = () => new Response("{}", { status: 403 });
    await ice.refreshIce(dir);
    expect(ice.resolveIce(dir).config.servers).toEqual(ice.DEFAULT_STUN);
    expect(ice.resolveIce(dir).summary.problem).toMatch(/HTTP 403/);
    await ice.refreshIce(dir);
    expect(calls).toHaveLength(1);
    // Forced (vine turn test): asks again.
    reply = () => new Response(JSON.stringify(iceAnswer(9)), { status: 201 });
    await ice.refreshIce(dir, { force: true });
    expect(ice.resolveIce(dir).config.servers).toHaveLength(ice.DEFAULT_STUN.length + 3);
  });

  it("drops credentials that have expired, even if a refresh hasn't happened", async () => {
    const dir = tempDir();
    ice.saveCloudflareTurn(dir, { keyId: KEY_ID, secret: SECRET });
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await ice.refreshIce(dir);
    reply = () => new Response("{}", { status: 500 });
    now += cf.CREDENTIAL_TTL * 1000;
    expect(ice.resolveIce(dir).config.servers).toEqual(ice.DEFAULT_STUN);
  });

  it("with the env store, reads VINE_CLOUDFLARE_TURN_SECRET and keeps nothing", async () => {
    const dir = tempDir();
    expect(() => ice.saveCloudflareTurn(dir, { keyId: KEY_ID, secret: SECRET, store: "env" })).toThrow(/VINE_CLOUDFLARE_TURN_SECRET/);
    ice.saveCloudflareTurn(dir, { keyId: KEY_ID, store: "env" });
    expect(keychain.size).toBe(0);
    await ice.refreshIce(dir, { force: true });
    expect(calls).toHaveLength(0);
    expect(ice.resolveIce(dir).summary.problem).toMatch(/VINE_CLOUDFLARE_TURN_SECRET/);
    process.env[ice.CLOUDFLARE_SECRET_ENV] = SECRET;
    await ice.refreshIce(dir, { force: true });
    expect(calls).toHaveLength(1);
  });

  it("is replaced cleanly: switching to your own server, or clearing, removes the key's secret from the keychain", () => {
    const dir = tempDir();
    ice.saveCloudflareTurn(dir, { keyId: KEY_ID, secret: SECRET });
    ice.saveTurn(dir, { host: "turn.example.org", username: "sam", password: "pw", store: "keychain" });
    expect(keychain.has(`vine-context-turn/cloudflare:${KEY_ID}`)).toBe(false);
    ice.saveCloudflareTurn(dir, { keyId: KEY_ID, secret: SECRET });
    expect(keychain.has("vine-context-turn/sam@turn.example.org:3478")).toBe(false);
    expect(ice.clearTurn(dir)).toBe(true);
    expect(keychain.size).toBe(0);
  });

  it("is replaced by VINE_ICE, which mints nothing", async () => {
    const dir = tempDir();
    ice.saveCloudflareTurn(dir, { keyId: KEY_ID, secret: SECRET });
    process.env.VINE_ICE = "stun:stun.example:3478";
    await ice.refreshIce(dir);
    expect(calls).toHaveLength(0);
    expect(ice.resolveIce(dir).summary.source).toBe("env");
  });
});

describe("creating a TURN key with an API token", () => {
  it("posts to the account's turn_keys and returns the key; the token is only in the header", async () => {
    reply = () => new Response(JSON.stringify({ success: true, result: { uid: KEY_ID, secret: SECRET, name: "vine-mac" } }), { status: 200 });
    const k = await cf.createTurnKey(ACCOUNT, "tok".repeat(10), "vine-mac");
    expect(k).toEqual({ keyId: KEY_ID, secret: SECRET, name: "vine-mac" });
    expect(calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/calls/turn_keys`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: "vine-mac" });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${"tok".repeat(10)}`);
  });

  it("says which permission a refused token lacks", async () => {
    reply = () => new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), { status: 403 });
    await expect(cf.createTurnKey(ACCOUNT, "tok".repeat(10), "x")).rejects.toThrow(/Realtime or Calls Write/);
  });
});

describe("the setup flow (vine turn set --provider cloudflare)", () => {
  const prompter = (answers: string[]) => ({
    interactive: true,
    ask: async () => answers.shift() ?? "",
    hidden: async () => answers.shift() ?? "",
    choose: async () => 0,
    confirm: async () => true,
  });

  it("with a token: creates the key, keeps only its secret (in the keychain), and checks a relay", async () => {
    const { setupCloudflare } = await import("../src/cli/cloudflare-setup.js");
    const dir = tempDir();
    const TOKEN = "t".repeat(40);
    reply = (c) =>
      c.url.includes("/turn_keys")
        ? new Response(JSON.stringify({ result: { uid: KEY_ID, secret: SECRET, name: "vine-x" } }), { status: 200 })
        : new Response(JSON.stringify(iceAnswer(1)), { status: 201 });
    const said: string[] = [];
    // The relay check needs a real TURN server: stand in for it, and see what it's given.
    const checked: unknown[] = [];
    const checkTurn = async (s: unknown) => (checked.push(s), { ok: true, relay: "203.0.113.5:40000" });
    const r = await setupCloudflare({ dataDir: dir, prompt: prompter([ACCOUNT, TOKEN]), say: (l) => said.push(l), via: "token", openPages: false, checkTurn });
    expect(r).toMatchObject({ ok: true, relay: "203.0.113.5:40000" });
    expect(checked[0]).toMatchObject({ hostname: "turn.cloudflare.com", port: 3478, relayType: "TurnUdp", username: "user-1" });
    expect(r.keyId).toBe(KEY_ID);
    expect(r.created).toBe(true);
    expect(keychain.get(`vine-context-turn/cloudflare:${KEY_ID}`)).toBe(SECRET);
    expect([...keychain.values()]).not.toContain(TOKEN);
    const everything = said.join("\n") + readFileSync(join(dir, "network.json"), "utf8") + JSON.stringify(r);
    for (const secret of [SECRET, TOKEN, ACCOUNT]) expect(everything).not.toContain(secret);
    expect(calls.map((c) => c.url.replace(/\/[0-9a-f]{32}\//g, "/ID/"))).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/ID/calls/turn_keys",
      "https://rtc.live.cloudflare.com/v1/turn/keys/ID/credentials/generate-ice-servers",
    ]);
  });

  it("in a dry run, asks for nothing and calls nothing", async () => {
    const { setupCloudflare } = await import("../src/cli/cloudflare-setup.js");
    const dir = tempDir();
    const r = await setupCloudflare({ dataDir: dir, prompt: prompter([]), say: () => {}, via: "token", dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.wouldDo?.join("\n")).toMatch(/turn_keys/);
    expect(calls).toHaveLength(0);
    expect(keychain.size).toBe(0);
    expect(ice.readTurnSetting(dir)).toBeUndefined();
  });
});
