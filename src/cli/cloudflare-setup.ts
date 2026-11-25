// Setting up Cloudflare Realtime TURN on this machine, for `vine setup` and
// `vine turn set --provider cloudflare`.
//
// Two ways in:
//   token  the person makes an API token that may create TURN keys; Vine
//          creates a key with it (named after this machine) and forgets the
//          token. Fewest steps.
//   key    the person creates a TURN key in the dashboard, and pastes its id
//          and secret.
// Either way the key's secret goes only to the OS keychain (or, with the env
// store, nowhere: the person sets VINE_CLOUDFLARE_TURN_SECRET). It is typed
// unseen, and never put in a command line, a file, a log or the output.

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import type { Prompter } from "./prompt.js";

export interface CloudflareSetupOptions {
  dataDir: string;
  prompt: Prompter;
  say(line: string): void;
  /** Skip the question of which way in. */
  via?: "token" | "key";
  keyId?: string;
  accountId?: string;
  store?: "keychain" | "env";
  /** Open dashboard pages in the browser (default: when interactive). */
  openPages?: boolean;
  /** Only say what would be done. */
  dryRun?: boolean;
  fetch?: typeof fetch;
  /** The relay check (tests stand in for the real TURN server). */
  checkTurn?: typeof import("../p2p/ice.js").checkTurn;
}

export interface CloudflareSetupResult {
  ok: boolean;
  keyId?: string;
  /** A key was created through the API. */
  created?: boolean;
  /** The relay check after saving. */
  relay?: string;
  error?: string;
  /** With dryRun: what would have been done. */
  wouldDo?: string[];
}

/** Opens a URL in the person's browser, best effort. Always prints it too. */
export function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {
    // printed anyway
  }
}

const tail = (s: string) => `…${s.slice(-4)}`;

export async function setupCloudflare(o: CloudflareSetupOptions): Promise<CloudflareSetupResult> {
  const cf = await import("../p2p/cloudflare.js");
  const ice = await import("../p2p/ice.js");
  const { keychainTool } = await import("../core/secret.js");
  const say = o.say;
  const store = o.store ?? (keychainTool() ? "keychain" : "env");
  const open = o.openPages ?? o.prompt.interactive;
  const page = (url: string) => {
    say(`  ${url}`);
    if (open && !o.dryRun) openUrl(url);
  };

  if (store === "keychain" && !keychainTool())
    return { ok: false, error: "This machine has no keychain Vine can use (macOS Keychain, or secret-tool on Linux). Use --store env and set VINE_CLOUDFLARE_TURN_SECRET instead." };

  let via = o.via ?? (o.keyId ? "key" : o.accountId ? "token" : undefined);
  // Creating a key hands Vine its secret: with nowhere to keep it, the person must create it and keep it themselves.
  if (store === "env") via = "key";
  if (!via) {
    const i = await o.prompt.choose(
      "How do you want to give Vine a Cloudflare TURN key?",
      ["Make an API token, and let Vine create the key (fewest steps)", "I'll create the TURN key in the dashboard and paste it"],
      0,
    );
    via = i === 0 ? "token" : "key";
  }

  if (o.dryRun) {
    const wouldDo =
      via === "token"
        ? [
            `open ${cf.CLOUDFLARE_TOKENS_PAGE}`,
            "ask (unseen) for your Cloudflare account id and an API token with the Realtime Admin (or Calls Write) permission",
            `POST ${cf.CLOUDFLARE_API}/accounts/<account id>/calls/turn_keys {"name":"vine-${hostname()}"}`,
            `save the key's secret in the ${store === "keychain" ? "OS keychain" : "environment (you set VINE_CLOUDFLARE_TURN_SECRET)"}; forget the token`,
            "write {provider: cloudflare, keyId} to network.json",
            `POST ${cf.CLOUDFLARE_RTC}/turn/keys/<key id>/credentials/generate-ice-servers, then check a relay address (vine turn test)`,
          ]
        : [
            `open ${cf.CLOUDFLARE_TURN_KEYS_PAGE}`,
            "ask for the TURN key id, and (unseen) its secret",
            `save the secret in the ${store === "keychain" ? "OS keychain" : "environment (you set VINE_CLOUDFLARE_TURN_SECRET)"}`,
            "write {provider: cloudflare, keyId} to network.json",
            `POST ${cf.CLOUDFLARE_RTC}/turn/keys/<key id>/credentials/generate-ice-servers, then check a relay address (vine turn test)`,
          ];
    for (const w of wouldDo) say(`  would ${w}`);
    return { ok: true, wouldDo };
  }

  let keyId = o.keyId;
  let secret: string | undefined;
  let created = false;
  let name: string | undefined;
  try {
    if (via === "token") {
      say("Make an API token on your Cloudflare account that may create TURN keys:");
      page(cf.CLOUDFLARE_TOKENS_PAGE);
      say('  Create Token → Custom token → Permissions: Account · Realtime Admin · Edit (some accounts call it "Calls"). Vine uses it once and doesn\'t keep it.');
      say("  Your account id is on the dashboard's home page (Account details), and in its address: dash.cloudflare.com/<account id>.");
      const accountId = o.accountId ?? (await o.prompt.hidden("Cloudflare account id (typed unseen)"));
      if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new Error("That doesn't look like a Cloudflare account id (32 hex characters).");
      say(`  account ${tail(accountId)}`);
      const token = await o.prompt.hidden("API token (typed unseen)");
      if (!cf.looksLikeSecret(token)) throw new Error("That doesn't look like an API token.");
      const k = await cf.createTurnKey(accountId, token, `vine-${hostname().split(".")[0]}`.slice(0, 60), o.fetch);
      ({ keyId, secret, name } = k);
      created = true;
      say(`  Created TURN key "${k.name}" (${tail(k.keyId)}).`);
    } else {
      say("Create a TURN key on your Cloudflare account (Realtime → TURN Server → Create), then copy its id and secret:");
      page(cf.CLOUDFLARE_TURN_KEYS_PAGE);
      keyId ??= await o.prompt.hidden("TURN key id (typed unseen)");
      if (!cf.looksLikeKeyId(keyId)) throw new Error("That doesn't look like a TURN key id.");
      say(`  key ${tail(keyId)}`);
      if (store === "keychain") {
        secret = await o.prompt.hidden("TURN key secret (typed unseen)");
        if (!cf.looksLikeSecret(secret)) throw new Error("That doesn't look like a TURN key secret.");
      }
    }
    ice.saveCloudflareTurn(o.dataDir, { keyId: keyId!, store, ...(store === "keychain" ? { secret } : {}), ...(name ? { name } : {}) });
  } catch (e) {
    return { ok: false, keyId, created, error: (e as Error).message };
  } finally {
    secret = undefined;
  }
  say(
    store === "keychain"
      ? "  Saved. The key's secret is in your keychain; network.json only says to use Cloudflare."
      : `  Saved. Set ${ice.CLOUDFLARE_SECRET_ENV} to the key's secret wherever vine runs (your agent's MCP config, and your shell for \`vine up\`).`,
  );
  const r = await ice.checkStoredTurn(o.dataDir, undefined, o.checkTurn);
  return r.ok ? { ok: true, keyId, created, relay: r.relay } : { ok: false, keyId, created, error: r.error };
}
