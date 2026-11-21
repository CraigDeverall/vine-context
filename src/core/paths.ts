import { homedir } from "node:os";
import { join } from "node:path";

/** Where graphs, their change logs and this machine's identity live. */
export function defaultDataDir(): string {
  return process.env.VINE_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "vine-context");
}

/** Graphs are shared by default (that's the point); VINE_AUTO_SHARE=off turns the default off. */
export const autoShare = () => !/^(0|off|false|no)$/i.test(process.env.VINE_AUTO_SHARE ?? "");
