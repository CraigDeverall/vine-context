// The join codes this install has used, kept beside its identity so later
// sessions can rejoin: a code is bound to this machine's key once the host
// approves it, so the same code lets this machine back in without approval.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatCode, parseCode, type Link } from "./link.js";

export interface JoinedGraph {
  code: string;
  host: string | null;
  graph: string | null;
  last_used: string;
}

export class JoinedStore {
  private file: string;

  constructor(private dataDir: string) {
    this.file = join(dataDir, "joined.json");
  }

  all(): JoinedGraph[] {
    if (!existsSync(this.file)) return [];
    try {
      return (JSON.parse(readFileSync(this.file, "utf8")) as JoinedGraph[]).sort((a, b) => b.last_used.localeCompare(a.last_used));
    } catch {
      return [];
    }
  }

  last(): JoinedGraph | undefined {
    return this.all()[0];
  }

  remember(link: Link, info: { host?: string | null; graph?: string | null } = {}): void {
    const code = formatCode(link);
    const old = this.all().find((j) => j.code === code);
    const entry: JoinedGraph = { code, host: info.host ?? old?.host ?? null, graph: info.graph ?? old?.graph ?? null, last_used: new Date().toISOString() };
    this.save([entry, ...this.all().filter((j) => j.code !== code)].slice(0, 50));
  }

  forget(link: Link): void {
    const room = link.room;
    this.save(this.all().filter((j) => parseCode(j.code).room !== room));
  }

  private save(list: JoinedGraph[]): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 1) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}
