import { homedir } from "node:os";
import { join } from "node:path";

/** Where graphs, their change logs and this machine's identity live. */
export function defaultDataDir(): string {
  return process.env.P2PCG_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "p2p-context-graph");
}

/** Graphs are shared by default (that's the point); P2PCG_AUTO_SHARE=off turns the default off. */
export const autoShare = () => !/^(0|off|false|no)$/i.test(process.env.P2PCG_AUTO_SHARE ?? "");
