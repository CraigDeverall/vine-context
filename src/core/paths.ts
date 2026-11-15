import { homedir } from "node:os";
import { join } from "node:path";

/** Where graphs, hosts, identities and installed model packs live. */
export function defaultDataDir(): string {
  return process.env.P2PCG_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "p2p-context-graph");
}

/** Model packs the person installed (model studio, or `p2pcg model install`). */
export function userPacksDir(dataDir = defaultDataDir()): string {
  return join(dataDir, "models");
}
