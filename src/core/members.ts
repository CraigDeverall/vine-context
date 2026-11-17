// Who is in a graph, worked out from its membership changes.
//
// Membership is changes in the same log as everything else, signed by an
// admin (or, for `rename`, by the member themselves). Every machine folds them
// in the same order (time, then author, then counter), checking each against
// the membership as it stood at that moment, so every machine agrees on who
// was a member, with which role, at any time. A data change is valid if its
// author was a member with a role that allows it at the change's time.
//
// Conflicts between admins: removal beats a later role change (a removed key
// stays out until it is added again); otherwise the later change wins. The
// graph's creator can't be removed or demoted, so a graph always has an admin.

import { compareChanges, RANK, ROLES, type Change, type Role } from "./changes.js";
import { fingerprint, NAME_RE } from "./identity.js";

export interface Member {
  key: string;
  name: string;
  role: Role;
  joined_at: string;
  added_by: string;
  invite?: { id: string; label: string | null };
  about?: Record<string, string>;
  creator: boolean;
  /** Set once removed; the member's later changes are refused. */
  removed_at?: string;
  /** When they took their current name: the earlier of two equal names keeps it. */
  named_at: string;
}

interface Span {
  from: number;
  role: Role | null;
}

export class Members {
  readonly graphId?: string;
  readonly graphName?: string;
  readonly createdAt?: string;
  private members = new Map<string, Member>();
  private spans = new Map<string, Span[]>();
  /** Membership changes that were refused, with why: shown in status, never applied. */
  readonly refused: { id: string; reason: string }[] = [];

  constructor(changes: Iterable<Change>) {
    const list = [...changes].filter((c) => c.kind === "create" || c.kind === "add_member" || c.kind === "set_role" || c.kind === "remove_member" || c.kind === "rename");
    list.sort(compareChanges);
    const create = list.find((c) => c.kind === "create" && c.id === c.graph);
    if (!create) return;
    this.graphId = create.graph;
    this.graphName = String(create.body.name ?? "graph");
    this.createdAt = create.at;
    for (const c of list) {
      const why = this.fold(c, create);
      if (why) this.refused.push({ id: c.id, reason: why });
    }
  }

  private fold(c: Change, create: Change): string | undefined {
    const t = Date.parse(c.at);
    const by = this.members.get(c.author);
    const isAdmin = by && !by.removed_at && by.role === "admin";
    const b = c.body;
    switch (c.kind) {
      case "create": {
        if (c !== create) return "a graph is created once";
        const name = cleanName(b.creator_name) ?? "creator";
        this.put({ key: c.author, name, role: "admin", joined_at: c.at, added_by: c.author, creator: true, named_at: c.at });
        this.span(c.author, t, "admin");
        return;
      }
      case "add_member": {
        if (!isAdmin) return "only an admin can add someone";
        const key = typeof b.key === "string" && b.key.length === 43 ? b.key : undefined;
        const name = cleanName(b.name);
        const role = ROLES.includes(b.role) ? (b.role as Role) : undefined;
        if (!key || !name || !role) return "bad add_member";
        const existing = this.members.get(key);
        if (existing && !existing.removed_at) return "already a member";
        this.put({
          key,
          name,
          role,
          joined_at: c.at,
          added_by: c.author,
          invite: b.invite && typeof b.invite.id === "string" ? { id: b.invite.id, label: typeof b.invite.label === "string" ? b.invite.label : null } : undefined,
          about: cleanAbout(b.about),
          creator: false,
          named_at: c.at,
        });
        this.span(key, t, role);
        return;
      }
      case "set_role": {
        if (!isAdmin) return "only an admin can change roles";
        const m = typeof b.key === "string" ? this.members.get(b.key) : undefined;
        if (!m || m.removed_at) return "not a member";
        if (!ROLES.includes(b.role)) return "bad role";
        if (m.creator && b.role !== "admin") return "the graph's creator stays an admin";
        m.role = b.role;
        this.span(m.key, t, b.role);
        return;
      }
      case "remove_member": {
        if (!isAdmin) return "only an admin can remove someone";
        const m = typeof b.key === "string" ? this.members.get(b.key) : undefined;
        if (!m || m.removed_at) return "not a member";
        if (m.creator) return "the graph's creator can't be removed";
        m.removed_at = c.at;
        this.span(m.key, t, null);
        return;
      }
      case "rename": {
        if (!by || by.removed_at) return "not a member";
        const name = cleanName(b.name);
        if (!name) return "bad name";
        by.name = name;
        by.named_at = c.at;
        return;
      }
    }
    return "not a membership change";
  }

  private put(m: Member) {
    this.members.set(m.key, m);
  }

  private span(key: string, from: number, role: Role | null) {
    const s = this.spans.get(key) ?? [];
    s.push({ from, role });
    this.spans.set(key, s);
  }

  /** The key's role at a moment, or null if it wasn't a member then. */
  roleAt(key: string, at: string): Role | null {
    const t = Date.parse(at);
    let role: Role | null = null;
    for (const s of this.spans.get(key) ?? []) if (s.from <= t) role = s.role;
    return role;
  }

  /** May this key make a change needing `needs` at that moment? */
  allows(key: string, at: string, needs: Role): boolean {
    const r = this.roleAt(key, at);
    return r !== null && RANK[r] >= RANK[needs];
  }

  get(key: string): Member | undefined {
    return this.members.get(key);
  }

  /** Current members (not removed). */
  current(): Member[] {
    return [...this.members.values()].filter((m) => !m.removed_at);
  }

  all(): Member[] {
    return [...this.members.values()];
  }

  isMember(key: string): boolean {
    const m = this.members.get(key);
    return Boolean(m && !m.removed_at);
  }

  byName(name: string): Member | undefined {
    return this.current().find((m) => m.name === name || this.displayName(m.key) === name);
  }

  /**
   * The name to show for a key. If two current members have the same name,
   * the one who took it first keeps it; the other is shown with their key
   * fingerprint after it until they rename.
   */
  displayName(key: string): string {
    const m = this.members.get(key);
    if (!m) return fingerprint(key);
    const clash = this.current().some((o) => o.key !== key && o.name === m.name && (o.named_at < m.named_at || (o.named_at === m.named_at && o.key < key)));
    return clash ? `${m.name} (${fingerprint(key)})` : m.name;
  }

  creator(): Member | undefined {
    return this.all().find((m) => m.creator);
  }
}

function cleanName(v: unknown): string | undefined {
  return typeof v === "string" && NAME_RE.test(v.trim()) ? v.trim() : undefined;
}

/** Keeps only short, printable strings from what a member said about their install. */
export function cleanAbout(a: unknown): Record<string, string> | undefined {
  if (!a || typeof a !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const k of ["agent", "agent_version", "p2pcg", "platform"]) {
    const v = (a as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) out[k] = v.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 60);
  }
  return Object.keys(out).length ? out : undefined;
}
