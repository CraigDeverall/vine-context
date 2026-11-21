// A graph's change log on this machine: every change it has seen, in the
// order they arrived, one JSON line each. Plus the changes this machine made
// that are still held (not yet numbered, signed or sent).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Change, Have, Unsigned } from "./changes.js";

export interface Held {
  change: Unsigned;
  /** When it is released (numbered, signed and sent), ms since the epoch. */
  until: number;
}

export class ChangeLog {
  private file: string;
  private heldFile: string;
  private byId = new Map<string, Change>();
  private order: Change[] = [];
  /** seqs seen per author. */
  private seqs = new Map<string, Set<number>>();
  private held: Held[] = [];

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "changes.jsonl");
    this.heldFile = join(dir, "held.json");
    if (existsSync(this.file))
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.remember(JSON.parse(line) as Change);
        } catch {
          // a torn last line after a crash: skip it; the change comes back from another member
        }
      }
    if (existsSync(this.heldFile)) {
      try {
        this.held = JSON.parse(readFileSync(this.heldFile, "utf8")) as Held[];
      } catch {
        this.held = [];
      }
    }
  }

  private remember(c: Change): boolean {
    if (this.byId.has(c.id)) return false;
    const s = this.seqs.get(c.author) ?? new Set<number>();
    if (s.has(c.seq)) return false; // a second change with the same number from one author: keep the first
    s.add(c.seq);
    this.seqs.set(c.author, s);
    this.byId.set(c.id, c);
    this.order.push(c);
    return true;
  }

  /** Adds a change; false if it was already here. */
  add(c: Change): boolean {
    if (!this.remember(c)) return false;
    appendFileSync(this.file, JSON.stringify(c) + "\n", { mode: 0o600 });
    return true;
  }

  has(id: string): boolean {
    return this.byId.has(id) || this.held.some((h) => h.change.id === id);
  }

  get(id: string): Change | undefined {
    return this.byId.get(id);
  }

  all(): Change[] {
    return this.order;
  }

  get size(): number {
    return this.order.length;
  }

  /** For each author, the highest number up to which this machine has every change. */
  have(): Have {
    const out: Have = {};
    for (const [author, s] of this.seqs) {
      let n = 0;
      while (s.has(n + 1)) n++;
      out[author] = n;
    }
    return out;
  }

  /** The changes the other side lacks, given what it has, in each author's order. */
  missing(theirs: Have): Change[] {
    return this.order
      .filter((c) => c.seq > (theirs[c.author] ?? 0))
      .sort((a, b) => (a.author === b.author ? a.seq - b.seq : a.author < b.author ? -1 : 1));
  }

  /** The next number for this author's own changes. */
  nextSeq(author: string): number {
    const s = this.seqs.get(author);
    return s ? Math.max(...s) + 1 : 1;
  }

  // Held changes: made here, applied here, not yet sent.

  hold(change: Unsigned, until: number): void {
    this.held.push({ change, until });
    this.saveHeld();
  }

  heldChanges(): Held[] {
    return this.held;
  }

  /** Removes a held change (taken back, or released). */
  unhold(id: string): Held | undefined {
    const i = this.held.findIndex((h) => h.change.id === id);
    if (i < 0) return undefined;
    const [h] = this.held.splice(i, 1);
    this.saveHeld();
    return h;
  }

  private saveHeld() {
    const tmp = `${this.heldFile}.tmp`;
    mkdirSync(dirname(tmp), { recursive: true });
    writeFileSync(tmp, JSON.stringify(this.held) + "\n", { mode: 0o600 });
    renameSync(tmp, this.heldFile);
  }
}
