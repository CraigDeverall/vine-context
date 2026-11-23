// Where a password this machine needs (today: the TURN server's) is kept.
//
//   file      beside the setting that uses it, in a file only the owner can read
//   keychain  the OS keychain: macOS Keychain (`security`), or the Linux secret
//             service (`secret-tool`)
//   env       nowhere: read from an environment variable when it's needed
//
// The keychain is reached through the OS's own command-line tools, and the
// password goes to them on stdin, never as a command argument (which other
// users of the machine could see in the process list).

import { spawnSync } from "node:child_process";

export type SecretStore = "file" | "keychain" | "env";
export const SECRET_STORES: SecretStore[] = ["file", "keychain", "env"];

const run = (cmd: string, args: string[], input?: string) =>
  spawnSync(cmd, args, { input, encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });

const has = (cmd: string) => run(cmd, cmd === "security" ? ["help"] : ["--help"]).error === undefined;

type Tool = "security" | "secret-tool";

/** The OS keychain tool on this machine, if there is one. */
export function keychainTool(platform = process.platform): Tool | undefined {
  if (platform === "darwin") return has("security") ? "security" : undefined;
  if (platform === "linux") return has("secret-tool") ? "secret-tool" : undefined;
  return undefined;
}

const NO_KEYCHAIN = "This machine has no keychain Vine can use (macOS Keychain, or secret-tool on Linux). Choose the file or env store instead.";

/** `security -i` reads one command per line: quote the value, and escape what the quoting uses. */
const quoted = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function keychainSet(service: string, account: string, password: string): void {
  if (/[\r\n]/.test(password)) throw new Error("A password can't contain a line break.");
  const tool = keychainTool();
  if (!tool) throw new Error(NO_KEYCHAIN);
  const r =
    tool === "security"
      ? run("security", ["-i"], `add-generic-password -U -s ${quoted(service)} -a ${quoted(account)} -w ${quoted(password)}\n`)
      : run("secret-tool", ["store", `--label=${service}`, "service", service, "account", account], password);
  if (r.status !== 0 || r.error) throw new Error(`The keychain refused the password (${tool} exited ${r.status ?? "early"}).`);
}

export function keychainGet(service: string, account: string): string | undefined {
  const tool = keychainTool();
  if (!tool) return undefined;
  const r =
    tool === "security"
      ? run("security", ["find-generic-password", "-s", service, "-a", account, "-w"])
      : run("secret-tool", ["lookup", "service", service, "account", account]);
  if (r.status !== 0 || r.error) return undefined;
  const out = r.stdout.replace(/\r?\n$/, "");
  return out === "" ? undefined : out;
}

export function keychainDelete(service: string, account: string): void {
  const tool = keychainTool();
  if (!tool) return;
  if (tool === "security") run("security", ["delete-generic-password", "-s", service, "-a", account]);
  else run("secret-tool", ["clear", "service", service, "account", account]);
}
