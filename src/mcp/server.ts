// The MCP server each agent session runs. It never opens a context graph
// itself: it is a client of this machine's hosts (started if needed). Every
// context this machine is in, its own or one it joined, is a full local copy
// kept in step with the other members by its host, so reads and writes always
// work, offline too.
//
// A chat usually uses one context, and can use several. Which ones is
// remembered on this machine under the chat's id (links.json in the data
// folder), so reopening the chat brings them back. A chat with none yet starts
// with the contexts linked to its folder, if the person linked any, or the one
// the agent's configuration names; else the agent asks (there's no default).
//
// With one context, the tools simply act on it. With several, reads run on
// all of them (each row saying which), each write goes to the context the call
// names or else the write context, and the tools say what each context is for
// so the agent can choose.
//
// The model's tools are re-registered (with tools/list_changed) when the
// contexts or a role change.

import { spawn } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Catalogue } from "../core/catalogue.js";
import { RANK } from "../core/changes.js";
import { inputShape, isoMoment, type Role, type Snapshot } from "../core/graph.js";
import { fingerprint, isGuessedName, nameSource, setName, type Identity } from "../core/identity.js";
import { claimsPack, type ToolSpec } from "../core/pack.js";
import { packageInfo } from "../core/package-root.js";
import { autoShare, defaultDataDir } from "../core/paths.js";
import { LocalHost } from "../host/client.js";
import { hostAlive, moveContext, placeReplica, readGroup } from "../host/host.js";
import { chatMarks, markSeen } from "../host/news.js";
import { socketPath } from "../host/state.js";
import { checkStoredTurn, clearTurn, readCloudflare, readTurn, saveTurn, type IceSource } from "../p2p/ice.js";
import { joinWithCode } from "../p2p/join.js";
import { parseCode } from "../p2p/link.js";
import type { GraphDescription } from "../p2p/protocol.js";
import type { SignalFactory } from "../p2p/signal.js";
import { registerViews, uiMeta } from "./apps.js";
import { chatLink, folderLink, forgetContext, localContexts, renameInLinks, resolveRef, setChatLink, setFolderLink, type Link, type Ref } from "./links.js";

type Content = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const text = (value: unknown): Content => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }],
});
const failure = (message: string): Content => ({ ...text(message), isError: true });

/** The views open_view shows. */
const OPEN_VIEWS = ["contexts", "console", "explorer"] as const;
type OpenView = (typeof OPEN_VIEWS)[number];

const OS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };
const GRAPH_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

type Description = GraphDescription & { graph_id?: string; creator?: boolean; member?: boolean; description?: string | null };

interface Attached {
  name: string;
  host: LocalHost;
  d: Description;
}

type Origin = "chat" | "folder" | "configured" | "chosen";

/** One line about a newcomer, for every agent in the graph. */
function joinNotice(p: Record<string, any>, where: string): string {
  const via = p.invite?.label ? ` with the invite '${p.invite.label}'` : p.invite?.id ? ` with invite ${p.invite.id}` : "";
  const agent = p.agent ? `${p.agent}${p.agent_version ? ` ${p.agent_version}` : ""}` : "an unknown agent";
  const extra = [p.platform ? `on ${p.platform}` : "", p.vine ? `vine ${p.vine}` : ""].filter(Boolean).join(", ");
  const by = p.added_by ? `, let in by ${p.added_by}` : "";
  return `News: ${p.name} joined ${where} as ${p.role}${via}${by}, at ${p.joined_at}. Key fingerprint ${p.fingerprint}; ${agent}${extra ? ` (${extra})` : ""}.`;
}

/** Opens a URL in the default browser; false where that isn't possible or is turned off. */
function openInBrowser(url: string): boolean {
  if (process.env.VINE_NO_OPEN) return false;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
    return true;
  } catch {
    return false;
  }
}

export interface SessionOptions {
  /** A context named for this session (the CLI's --context or VINE_CONTEXT), used when the chat has none yet. */
  local?: () => Promise<LocalHost>;
  /** Connects to (and if needed starts) this machine's host for a context by name. */
  openLocal?: (graph: string) => Promise<LocalHost>;
  identity: () => Identity;
  signal: SignalFactory;
  /** STUN/TURN servers for joining. Read when a join starts. */
  ice: IceSource;
  /** How long join_context waits for the person who made the code to answer. */
  joinWaitMs?: number;
  /** Where contexts live. */
  dataDir?: string;
  /** The chat's id (Claude Code's session id): its contexts are remembered under it. Without one, the choice lasts this session. */
  chat?: string;
  /** The folder the chat started in: contexts linked to it (or a parent) are where a new chat starts. */
  cwd?: string;
  /** Starts (once) the localhost page that shows the views, and returns its link: open_view with `browser`. */
  browserView?: () => Promise<string>;
  log?(msg: string): void;
}

const contextArg = z.string().regex(GRAPH_RE).optional();

export class Session {
  readonly server: McpServer;
  /** This chat's contexts, in the order added. Usually one. */
  private contexts = new Map<string, Attached>();
  /** Where writes go unless a call names another context. */
  private writeTo?: string;
  private modelTools = new Map<string, RegisteredTool>();
  /** The contexts on this machine, searchable: opened on the first find_context. */
  private catalogue?: Promise<Catalogue>;
  /** Notices not yet shown to the agent: they ride on its next tool result. */
  private news: string[] = [];
  /** Sync digests not yet shown to the agent. The agent hook may show one first: see withNews. */
  private digests: { context: string; at?: string; lines: string[] }[] = [];
  /** Where the contexts came from when the chat started. */
  private origin: Origin | null = null;

  constructor(private o: SessionOptions) {
    this.server = new McpServer(
      { name: "vine-context", version: packageInfo().version },
      {
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
        // Some agents read only the start of this (Codex: the first 512 characters), so that much stands alone.
        instructions:
          "Vine Context holds shared contexts: what a group knows, as dated claims and open questions, synced peer to peer between its members' agents. " +
          "Use it during ordinary work, not only when asked: when this chat reaches a decision, establishes a fact or leaves a question open that fits its context's purpose, record it (add_claim, ask_question; search first), " +
          "and look there (search, open_questions) before answering what the group may already know. context_info says which context this chat uses and what it is for. " +
          "Every member keeps a full copy, so it works offline. A chat usually uses one context; use_context switches it (or, with `mode`, adds or drops one), and the chat keeps them when reopened. " +
          "find_context searches this machine's contexts by what they are for: use it to pick one, and before starting a new one. " +
          "Call model_guide once before you first write, and follow it. " +
          "To invite someone, use share_context: it makes a join code for one person. To join someone else's context, call join_context with the vine1_ code they sent.",
      },
    );
    registerViews(this.server);
    // A slash command for agents that have this server but not the plugin.
    this.server.registerPrompt(
      "join",
      {
        title: "Join a shared context",
        description: "Join someone's shared context with the join code (vine1_…) they sent you",
        argsSchema: { code: z.string().describe("The vine1_… join code") },
      },
      ({ code }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Join the shared context with this join code: ${code}\n\n` +
                "Call join_context with the code exactly as given. When I'm in, tell me whose context it is, what it's for, my role, that I now have my own full copy, and that everyone in it has been told I joined (with my name and key fingerprint). " +
                "Then give me the short briefing it returns (open questions, conflicts, latest), and call model_guide before writing. If the person who made the code isn't online, tell me to try again later. If the code was already used on another machine, expired or was cancelled, tell me to ask for a new one (and, if it was already used and not by me, to warn them it may have leaked).",
            },
          },
        ],
      }),
    );
    this.registerSessionTools();
    this.registerAppTools();
  }

  private get dataDir(): string {
    return this.o.dataDir ?? defaultDataDir();
  }

  close(): void {
    for (const c of this.contexts.values()) c.host.close();
    void this.server.close().catch(() => undefined);
  }

  /** Picks up the chat's contexts: the ones it used before, else its folder's, else the configured one; else none until one is chosen. */
  async start(): Promise<void> {
    const remembered = this.o.chat ? chatLink(this.dataDir, this.o.chat) : undefined;
    const folder = !remembered && this.o.cwd ? folderLink(this.dataDir, this.o.cwd) : undefined;
    const link: Link | undefined = remembered ?? folder;
    if (link && this.o.openLocal) {
      const origin: Origin = remembered ? "chat" : "folder";
      for (const ref of link.contexts) {
        const name = resolveRef(this.dataDir, ref);
        if (!name) {
          this.news.push(
            `News: this ${origin} uses the context '${ref.name}'${ref.id ? ` (id ${ref.id})` : ""}, which isn't on this machine. Ask one of its members for a join code (join_context), or use another.`,
          );
          continue;
        }
        try {
          await this.attach(name, false);
          this.origin = origin;
        } catch (e) {
          this.news.push(`News: couldn't open the context '${name}': ${(e as Error).message}`);
        }
      }
      const w = link.write_to && link.contexts.find((r) => r.name === link.write_to);
      const local = w ? resolveRef(this.dataDir, w) : undefined;
      if (local && this.contexts.has(local)) this.writeTo = local;
    }
    if (!this.contexts.size && this.o.local) {
      const host = await this.o.local();
      const d = await host.request<Description>("describe");
      this.add(d.graph, host, d);
      this.origin = "configured";
    }
    this.remember();
    this.offer();
  }

  // ---- The chat's contexts -----------------------------------------------

  /** Saves the chat's contexts under its id, so reopening the chat brings them back. */
  private remember() {
    if (!this.o.chat || !this.contexts.size) return;
    setChatLink(this.dataDir, this.o.chat, this.link());
  }

  private link(): Omit<Link, "at"> {
    return {
      contexts: [...this.contexts.values()].map((c) => ({ name: c.name, ...(c.d.graph_id ? { id: c.d.graph_id } : {}) })),
      ...(this.writeTo ? { write_to: this.writeTo } : {}),
    };
  }

  private add(name: string, host: LocalHost, d: Description) {
    this.contexts.get(name)?.host.close();
    this.contexts.set(name, { name, host, d });
    this.writeTo ??= name;
    // News starts from when the chat first has the context: whichever of this server and the agent hook tells it first moves the marker on.
    if (this.o.chat && !chatMarks(this.dataDir, this.o.chat).seen[name]) markSeen(this.dataDir, this.o.chat, name, new Date().toISOString());
    host.on("close", () => this.o.log?.(`local host connection for '${name}' closed`));
    host.on("event", (e: { event: string; data: any }) => {
      if (this.contexts.get(name)?.host !== host) return;
      const where = this.where(name);
      const tag = this.contexts.size > 1 ? ` (${name})` : "";
      if (e.event === "joined") this.news.push(joinNotice(e.data, where));
      if (e.event === "digest" && Array.isArray(e.data?.lines)) {
        this.digests.push({ context: name, at: typeof e.data.at === "string" ? e.data.at : undefined, lines: e.data.lines.map((l: string) => `News${tag}: ${l}`) });
      }
      if (e.event === "unreachable" && typeof e.data?.message === "string") this.news.push(`News${tag}: ${e.data.message}`);
      if (e.event === "removed") {
        this.news.push(`News: ${e.data?.by ?? "An admin"} removed you from ${where}. You keep your copy to read, but can't write to it any more.`);
        void this.refresh(name);
      }
      if (e.event === "role") {
        this.news.push(`News: your role in ${where} is now ${e.data?.role}.`);
        void this.refresh(name);
      }
    });
  }

  private async refresh(name: string) {
    const c = this.contexts.get(name);
    if (!c) return;
    try {
      c.d = await c.host.request<Description>("describe");
      this.offer();
    } catch {
      // the host went away; the next call reconnects
    }
  }

  /** Adds a context on this machine (starting it if new) to the chat. */
  private async attach(name: string, offer = true): Promise<Attached> {
    const existing = this.contexts.get(name);
    if (existing && !existing.host.closed) return existing;
    if (!this.o.openLocal) throw new Error("This session can't open other contexts.");
    const host = await this.o.openLocal(name);
    const d = await host.request<Description>("describe");
    this.add(name, host, d);
    if (offer) {
      this.remember();
      this.offer();
    }
    return this.contexts.get(name)!;
  }

  private detach(name: string) {
    const c = this.contexts.get(name);
    if (!c) throw new Error(`This chat doesn't use '${name}'.`);
    c.host.close();
    this.contexts.delete(name);
    if (this.writeTo === name) this.writeTo = [...this.contexts.keys()][0];
    if (this.o.chat) setChatLink(this.dataDir, this.o.chat, this.contexts.size ? this.link() : null);
    this.offer();
  }

  /** The context a call acts on: the one it names (if this chat uses it), else the write context. */
  private async target(name?: string): Promise<Attached> {
    const c = name ? this.contexts.get(name) : this.writeTo ? this.contexts.get(this.writeTo) : undefined;
    if (name && !c)
      throw new Error(`This chat doesn't use '${name}': it uses ${[...this.contexts.keys()].map((n) => `'${n}'`).join(", ") || "no context"}. use_context with mode 'add' adds one.`);
    if (!c) throw new Error(this.noContext());
    if (!c.host.closed) return c;
    // Renamed (by another chat): follow it to its new name, by its id.
    if (!this.localNames().includes(c.name) && c.d.graph_id) {
      const moved = localContexts(this.dataDir).find((l) => l.id === c.d.graph_id);
      if (moved) {
        const again = await this.reattach(c.name, moved.name);
        this.remember();
        this.offer();
        if (name && name !== moved.name) this.o.log?.(`'${name}' was renamed to '${moved.name}' on this machine`);
        return again;
      }
    }
    // Deleted from this machine (by another chat): reopening it would start an empty context under its name.
    if (!this.localNames().includes(c.name)) {
      this.contexts.delete(c.name);
      if (this.writeTo === c.name) this.writeTo = [...this.contexts.keys()][0];
      if (this.o.chat) setChatLink(this.dataDir, this.o.chat, this.contexts.size ? this.link() : null);
      this.offer();
      throw new Error(`The context '${c.name}' was deleted from this machine, so this chat no longer uses it.`);
    }
    c.host = await this.o.openLocal!(c.name);
    c.d = await c.host.request<Description>("describe");
    return c;
  }

  /** What to do when the chat has no context: there's no default, so the agent asks the person. */
  private noContext(): string {
    const mine = this.localNames();
    return (
      "This chat has no context yet, and there's no default. Ask the person which context this chat is for" +
      (mine.length ? ` (on this machine: ${mine.map((n) => `'${n}'`).join(", ")}), then use_context it.` : ", then start one with use_context.") +
      " use_context with a new name starts one (ask what it's for); join_context joins someone else's with their code. The chat keeps its context when reopened."
    );
  }

  private async request<T>(method: string, params?: unknown, name?: string): Promise<T> {
    const c = await this.target(name);
    try {
      return await c.host.request<T>(method, params);
    } catch (e) {
      if (!c.host.closed) throw e;
      // The host restarted: reconnect once.
      const again = await this.target(c.name);
      return again.host.request<T>(method, params);
    }
  }

  private where(name?: string): string {
    const c = this.contexts.get(name ?? this.writeTo ?? "");
    if (!c) return name ? `'${name}'` : "no context";
    if (c.d.creator) return `your context '${c.name}'`;
    return `'${c.name}' (${c.d.host}'s context${c.d.member === false ? "; you were removed" : `; you are a ${c.d.you.role}`})`;
  }

  private roleIn(c: Attached): Role {
    return c.d.member === false ? "reader" : c.d.you.role;
  }

  private get many(): boolean {
    return this.contexts.size > 1;
  }

  /** The chat's contexts, for tool descriptions: name, what it's for, and the write context. */
  private contextsLine(): string {
    const parts = [...this.contexts.values()].map((c) => `'${c.name}'${c.name === this.writeTo ? " (writes go here by default)" : ""}: ${c.d.description ?? "no description yet"}`);
    return ` This chat's contexts: ${parts.join("; ")}.`;
  }

  /**
   * What this server adds to two of the model's tools. `recent` can also give
   * the context's activity (what the panels poll), and `withdraw` first undoes
   * a write that is still only on this machine.
   */
  private modelTool(tool: Pick<ToolSpec, "name" | "description" | "input">): { description: string; shape: Record<string, z.ZodType> } {
    const shape = inputShape(tool.input, true);
    if (tool.name === "recent")
      return {
        description:
          tool.description +
          " With `activity`, one context's latest activity instead (no `since` needed): who wrote what, what others' changes meant for you, joins and role changes, who is online.",
        shape: {
          ...shape,
          since: z.string().meta({ format: "date-time" }).optional().describe("Changes after this time (ISO 8601). Required unless activity."),
          activity: z.boolean().optional(),
          snapshot: z.boolean().optional().describe("With activity: also its items and links"),
          context: contextArg,
        },
      };
    if (tool.name === "withdraw")
      return {
        description:
          tool.description +
          " A write still only on this machine (for a few seconds after it is made) is undone without trace instead and never reaches anyone: the result then says taken_back.",
        shape: {
          ...shape,
          id: z.string().describe("The claim, question or reply; or, to undo a write just made, its `change` id"),
          undo_only: z.boolean().optional().describe("Fail if it was already shared, rather than withdraw"),
        },
      };
    return { description: tool.description, shape };
  }

  /** The `activity` form of `recent`. It never takes the agent's notices: the panels poll it. */
  private async activityCall(a: { limit?: number; snapshot?: boolean; context?: string }): Promise<Content> {
    try {
      if (!this.contexts.size) {
        const none = { using: "no context", context: null, contexts: [], your_contexts: this.localNames(), next: this.noContext() };
        return { ...text(none), structuredContent: none };
      }
      const out = await this.activity(a);
      return { ...text(out), structuredContent: out };
    } catch (e) {
      return failure((e as Error).message);
    }
  }

  /**
   * Undoes a write that is still only on this machine: it is removed and never
   * reaches anyone. Null when there is nothing to undo (it was shared already),
   * unless `must`, which fails instead. Without `must`, an item's own id only
   * undoes the write that made it (so withdrawing twice doesn't undo the
   * withdrawal), and only while nothing else links to it; a change id undoes
   * that change, whatever it was.
   */
  private async takeBack(id: string, context: string | undefined, must: boolean): Promise<Record<string, unknown> | null> {
    const names: (string | undefined)[] = context || !this.many ? [context] : [...this.contexts.keys()];
    let last: Error | undefined;
    for (const n of names) {
      try {
        const r = await this.request<Record<string, unknown>>("take_back", { id, new_only: !must }, n);
        return { ...(this.many ? { context: n ?? this.writeTo } : {}), ...r, note: "Undone before it was shared: it never left this machine and leaves no trace." };
      } catch (e) {
        last = e as Error;
        if (/already been shared/.test(last.message)) break;
      }
    }
    if (must) throw last ?? new Error(`No write ${id} from this machine.`);
    return null;
  }

  /** Registers the model's tools for the chat's contexts, as far as this machine's roles allow. */
  private offer(): void {
    for (const t of this.modelTools.values()) t.remove();
    this.modelTools.clear();
    const all = [...this.contexts.values()];
    if (!all.length) {
      // No context yet: the model's tools are still offered, and say what to do first.
      for (const tool of claimsPack().tools) {
        const { description, shape } = this.modelTool(tool);
        const registered = this.server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: `${description} This chat has no context yet: this tells you how to choose one.`,
            inputSchema: shape,
            annotations: { readOnlyHint: tool.kind === "read", destructiveHint: false, idempotentHint: tool.kind === "read", openWorldHint: false },
          },
          async (raw: Record<string, unknown>) => (tool.name === "recent" && raw?.activity ? this.activityCall({}) : this.withNews(failure(this.noContext()))),
        );
        this.modelTools.set(tool.name, registered);
      }
      if (this.server.isConnected()) this.server.sendToolListChanged();
      return;
    }
    const many = this.many;
    for (const tool of all[0]!.d.tools) {
      const allowed = all.filter((c) => RANK[this.roleIn(c)] >= RANK[tool.role] && !(tool.kind === "write" && c.d.member === false));
      if (!allowed.length) continue;
      // With one context, nothing about routing: the tool just acts on it.
      const routing = !many
        ? ""
        : tool.kind === "write"
          ? ` Goes to the context named in \`context\`, else '${this.writeTo}'. Pick the context whose description fits; if none clearly does, ask the person.${this.contextsLine()}`
          : ` Without \`context\`, it runs on each of this chat's contexts and every result says which one it came from.${this.contextsLine()}`;
      const { description, shape } = this.modelTool(tool);
      const registered = this.server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: description + routing,
          inputSchema: {
            ...shape,
            ...(many ? { context: contextArg.describe(tool.kind === "write" ? "The context to write to (default: the write context)" : "Only this context (default: all of this chat's)") } : {}),
          },
          annotations: { readOnlyHint: tool.kind === "read", destructiveHint: false, idempotentHint: tool.kind === "read", openWorldHint: false },
          ...(tool.view ? { _meta: uiMeta(tool.view) } : {}),
        },
        async (raw: Record<string, unknown>) => {
          const { context, ...args } = raw as Record<string, unknown> & { context?: string };
          if (tool.name === "recent") {
            const { activity, snapshot } = args as { activity?: boolean; snapshot?: boolean };
            if (activity) return this.activityCall({ limit: args.limit as number | undefined, snapshot, context });
            delete args.activity;
            delete args.snapshot;
          }
          try {
            await this.followRenames();
            if (tool.name === "recent" && !args.since) throw new Error("Give `since` (ISO 8601, for example 2026-03-01T09:00:00Z), or set `activity` for the context's latest activity.");
            if (tool.name === "withdraw") {
              const must = Boolean(args.undo_only);
              delete args.undo_only;
              const undone = await this.takeBack(String(args.id), context, must);
              if (undone) return this.withNews(text(undone));
            }
            if (tool.kind === "read" && !context && this.many) return this.withNews(await this.readAll(tool.name, args));
            const c = await this.target(context);
            let result = await this.request<Record<string, unknown>>("call", { tool: tool.name, args }, c.name);
            if (Array.isArray(result) && this.many) result = result.map((row) => ({ context: c.name, ...row })) as unknown as Record<string, unknown>;
            const out = text(result);
            const held =
              tool.kind === "write" && result && typeof result === "object" && result.shared_at
                ? tool.name === "withdraw"
                  ? ` Withdrawn: it stays in the history. The withdrawal itself stays on this machine until ${result.shared_at}; until then withdraw with its \`change\` id undoes it.`
                  : ` It stays on this machine until ${result.shared_at}; until then withdraw removes it without trace.`
                : "";
            out.content.push({ type: "text", text: `(${tool.kind === "write" ? "in" : "from"} ${this.where(c.name)})${held}` });
            if (tool.view)
              out.structuredContent = {
                view: tool.view,
                tool: tool.name,
                title: tool.title ?? tool.name,
                input: args,
                result,
                context: c.name,
                undo: tool.kind === "write" ? { held: true, withdraw: RANK[this.roleIn(c)] >= RANK.contributor } : null,
                where: this.where(c.name),
              };
            return this.withNews(out);
          } catch (e) {
            return this.withNews(failure((e as Error).message));
          }
        },
      );
      this.modelTools.set(tool.name, registered);
    }
    if (this.server.isConnected()) this.server.sendToolListChanged();
  }

  /** A read across the chat's contexts: lists are merged, each row saying its context; one item is looked for in each. */
  private async readAll(tool: string, args: Record<string, unknown>): Promise<Content> {
    const results: { name: string; value?: unknown; error?: string }[] = [];
    for (const c of this.contexts.values()) {
      try {
        results.push({ name: c.name, value: await this.request("call", { tool, args }, c.name) });
      } catch (e) {
        results.push({ name: c.name, error: (e as Error).message });
      }
    }
    const ok = results.filter((r) => r.error === undefined);
    if (!ok.length) return failure(results.map((r) => `${r.name}: ${r.error}`).join("\n"));
    if (ok.every((r) => Array.isArray(r.value))) {
      let rows: Record<string, unknown>[] = ok.flatMap((r) => (r.value as Record<string, unknown>[]).map((row) => ({ context: r.name, ...row })));
      if (rows.some((r) => typeof r.score === "number")) rows = rows.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
      const out = text(rows);
      out.content.push({ type: "text", text: `(from ${ok.length} contexts: ${ok.map((r) => r.name).join(", ")})` });
      return out;
    }
    // One item (history, thread): the context that has it.
    const hit = ok[0]!;
    const out = text(hit.value);
    out.content.push({ type: "text", text: `(from ${this.where(hit.name)})` });
    return out;
  }

  /** Puts any notices in front of a tool result, once. */
  private withNews(out: Content): Content {
    const lines = [...this.news.splice(0), ...this.freshDigests()];
    if (!lines.length) return out;
    out.content.unshift({ type: "text", text: `${lines.join("\n")}\nTell the person this, briefly.` });
    return out;
  }

  /**
   * The digest lines the agent hasn't been given yet. The agent hook (`vine hook`)
   * gives the same digests beside the person's next prompt, so each one is
   * checked against the chat's marker, and the marker is moved past the ones
   * given here.
   */
  private freshDigests(): string[] {
    const waiting = this.digests.splice(0);
    if (!waiting.length) return [];
    const chat = this.o.chat;
    const seen = chat ? chatMarks(this.dataDir, chat).seen : {};
    const lines: string[] = [];
    for (const d of waiting) {
      if (d.at && seen[d.context] && d.at <= seen[d.context]!) continue;
      lines.push(...d.lines);
      if (chat && d.at) markSeen(this.dataDir, chat, d.context, d.at);
    }
    return lines;
  }

  /** One of this machine's contexts in full, whether or not the chat uses it: what the panel's details show. */
  private async details(name: string): Promise<Record<string, unknown>> {
    if (!this.localNames().includes(name)) throw new Error(`There's no context '${name}' on this machine.`);
    const attached = this.contexts.has(name);
    // One the chat doesn't use is opened just for this read.
    const host = attached ? (await this.target(name)).host : await this.o.openLocal!(name);
    try {
      const d = await host.request<Description>("describe");
      const info = await host.request<Record<string, any>>("info");
      const role: Role | null = d.member === false ? null : d.you.role;
      const people = ((info.people ?? []) as { role: Role | null; online?: boolean; you?: boolean }[]).filter((p) => p.role);
      let invites: number | null = null;
      if (role === "admin") {
        const s = await host.request<{ invites?: { state: string }[] }>("status");
        invites = (s.invites ?? []).filter((i) => i.state === "open").length;
      }
      return {
        name,
        id: d.graph_id ?? null,
        description: d.description ?? null,
        role,
        yours: Boolean(d.creator),
        created_by: info.created_by ?? null,
        in_chat: attached,
        writes_here: attached && this.writeTo === name,
        sharing: Boolean(info.sharing?.sharing),
        members: people.length,
        online: people.filter((p) => p.online && !p.you).length,
        items: info.nodes ?? {},
        changes: info.log?.changes ?? 0,
        held: info.log?.held ?? 0,
        open_invites: invites,
        stored_at: join(this.dataDir, "graphs", name),
      };
    } finally {
      if (!attached) host.close();
    }
  }

  /** Deletes this machine's copy of a context: its items, change log, join codes and every link to it. */
  private async deleteLocal(name: string): Promise<Record<string, unknown>> {
    if (!this.localNames().includes(name)) throw new Error(`There's no context '${name}' on this machine.`);
    const id = readGroup(this.dataDir, name)?.id;
    if (this.contexts.has(name)) this.detach(name);
    // Out of the list first, so no chat on this machine reopens it (which would start an empty one) while its host stops.
    const store = join(this.dataDir, "graphs", name);
    let doomed = store;
    try {
      const aside = join(this.dataDir, "graphs", `.deleting-${name}-${Date.now()}`);
      renameSync(store, aside);
      doomed = aside;
    } catch {
      // Windows won't move a folder with open files: it goes once the host has stopped.
    }
    const sock = socketPath(this.dataDir, name);
    if (!(await this.stopHost(name))) {
      if (doomed !== store) renameSync(doomed, store);
      throw new Error(`The host for '${name}' didn't stop, so nothing was deleted. Try again in a moment.`);
    }
    const rm = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rm(doomed);
    rm(join(this.dataDir, "hosts", name));
    if (process.platform !== "win32" && existsSync(sock)) rmSync(sock, { force: true });
    forgetContext(this.dataDir, name, id);
    return { deleted: name, id: id ?? null, contexts: this.list(), write_to: this.writeTo ?? null, your_contexts: this.localNames() };
  }

  /** Stops a context's host, if one runs (every chat's connection to it closes). False if it wouldn't stop. */
  private async stopHost(name: string): Promise<boolean> {
    const sock = socketPath(this.dataDir, name);
    if (!(await hostAlive(sock))) return true;
    try {
      const h = await LocalHost.connect(sock);
      await h.request("shutdown").catch(() => undefined);
      h.close();
    } catch {
      // it stopped by itself
    }
    for (let i = 0; i < 40 && (await hostAlive(sock)); i++) await new Promise((r) => setTimeout(r, 150));
    if (await hostAlive(sock)) return false;
    await new Promise((r) => setTimeout(r, 200)); // let the host's process exit
    return true;
  }

  /** Gives a context on this machine a new local name: its store, its host's files, and every chat's and folder's link move with it. */
  private async renameLocal(from: string, to: string): Promise<Record<string, unknown>> {
    if (!this.localNames().includes(from)) throw new Error(`There's no context '${from}' on this machine.`);
    if (from === to) return { renamed: from, to, contexts: this.list() };
    if (this.localNames().includes(to)) throw new Error(`There's already a context '${to}' on this machine.`);
    const id = readGroup(this.dataDir, from)?.id;
    const attached = this.contexts.get(from);
    if (attached) attached.host.close();
    if (!(await this.stopHost(from))) throw new Error(`The host for '${from}' didn't stop, so it wasn't renamed. Try again in a moment.`);
    const sock = socketPath(this.dataDir, from);
    moveContext(this.dataDir, from, to);
    if (process.platform !== "win32" && existsSync(sock)) rmSync(sock, { force: true });
    renameInLinks(this.dataDir, from, to, id);
    if (attached) {
      await this.reattach(from, to);
      this.remember();
      this.offer();
    }
    return { renamed: from, to, id: id ?? null, contexts: this.list(), write_to: this.writeTo ?? null, your_contexts: this.localNames() };
  }

  /** Picks up contexts another chat renamed: their host stopped, and they're here under a new name with the same id. */
  private async followRenames(): Promise<void> {
    for (const c of [...this.contexts.values()]) {
      if (!c.host.closed || !c.d.graph_id || this.localNames().includes(c.name)) continue;
      const moved = localContexts(this.dataDir).find((l) => l.id === c.d.graph_id);
      if (!moved) continue;
      await this.reattach(c.name, moved.name);
      this.remember();
      this.offer();
    }
  }

  /** Reopens one of the chat's contexts under its new name, in its old place in the chat's list. */
  private async reattach(from: string, to: string): Promise<Attached> {
    const order = [...this.contexts.keys()].map((k) => (k === from ? to : k));
    this.contexts.delete(from);
    if (this.writeTo === from) this.writeTo = to;
    const c = await this.attach(to, false);
    const all = new Map(this.contexts);
    this.contexts.clear();
    for (const k of order) if (all.has(k)) this.contexts.set(k, all.get(k)!);
    return c;
  }

  /** Runs `fn` on a context's host: this chat's own connection if it uses it, else one opened just for this. */
  private async onContext<T>(name: string | undefined, fn: (host: LocalHost, name: string) => Promise<T>): Promise<T> {
    if (!name || this.contexts.has(name)) {
      const c = await this.target(name);
      try {
        return await fn(c.host, c.name);
      } catch (e) {
        if (!c.host.closed) throw e;
        // The host restarted: reconnect once.
        const again = await this.target(c.name);
        return fn(again.host, again.name);
      }
    }
    if (!this.localNames().includes(name)) throw new Error(`There's no context '${name}' on this machine.`);
    if (!this.o.openLocal) throw new Error("This session can't open other contexts.");
    const host = await this.o.openLocal(name);
    try {
      return await fn(host, name);
    } finally {
      host.close();
    }
  }

  /** The catalogue of this machine's contexts. Relate and the embedder load on the first search, not when the chat starts. */
  private openCatalogue(): Promise<Catalogue> {
    this.catalogue ??= import("../core/catalogue.js").then(({ Catalogue }) => Catalogue.open(this.dataDir, { log: this.o.log }));
    this.catalogue.catch(() => (this.catalogue = undefined)); // a failed open is tried again next time
    return this.catalogue;
  }

  private localNames(): string[] {
    return localContexts(this.dataDir).map((c) => c.name);
  }

  /** The chat's contexts, briefly. */
  private list() {
    return [...this.contexts.values()].map((c) => ({ name: c.name, description: c.d.description ?? null, role: c.d.member === false ? null : c.d.you.role, writes_here: c.name === this.writeTo }));
  }

  /** Whether the folder this chat started in (or a parent) starts new chats with exactly this chat's contexts. */
  private folderState(): { folder: string; linked: boolean; pinned: string[] } | null {
    if (!this.o.cwd) return null;
    const f = folderLink(this.dataDir, this.o.cwd);
    const mine = [...this.contexts.keys()].sort().join(",");
    const theirs = f ? f.contexts.map((r) => resolveRef(this.dataDir, r) ?? "?").sort().join(",") : "";
    const pinned = f ? f.contexts.map((r) => resolveRef(this.dataDir, r)).filter((n): n is string => !!n) : [];
    return { folder: f?.folder ?? this.o.cwd, linked: !!f && !!mine && mine === theirs, pinned };
  }

  /** One of this chat's contexts as the panels show it: recent changes, people, join codes and (with snapshot) its items. */
  private async activity(a: { limit?: number; snapshot?: boolean; context?: string }): Promise<Record<string, unknown>> {
    // A context the chat no longer uses falls back to the write context (the panel may ask for one just removed).
    const c = await this.target(a.context && this.contexts.has(a.context) ? a.context : undefined);
    const activity = await this.request<Record<string, unknown>>("activity", { limit: a.limit }, c.name);
    const out: Record<string, unknown> = {
      using: this.where(c.name),
      context: c.name,
      contexts: this.list(),
      your_contexts: this.localNames(),
      folder: this.folderState(),
      ...activity,
    };
    // An admin's open join codes (who each is for, its role, when it expires): the panel lists them, to send or cancel.
    if ((activity.you as { role?: string } | undefined)?.role === "admin") {
      const s = await this.request<{ invites?: { state: string }[] }>("status", undefined, c.name);
      out.invites = (s.invites ?? []).filter((i) => i.state === "open");
    }
    if (a.snapshot) out.snapshot = await this.request<Snapshot>("snapshot", { limit: 300 }, c.name);
    return out;
  }

  private registerSessionTools(): void {
    const ro = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
    const wrap = (fn: (args: any) => Promise<unknown>) => async (args: any) => {
      try {
        await this.followRenames();
        return this.withNews(text(await fn(args)));
      } catch (e) {
        return this.withNews(failure((e as Error).message));
      }
    };
    const which = contextArg.describe("One of this chat's contexts (default: where writes go)");
    const anyHere = contextArg.describe("Any context on this machine (default: where the chat's writes go)");

    this.server.registerTool(
      "context_info",
      {
        title: "Context info",
        description:
          "This chat's context: what it's for, your role, how much it holds, who is in it and online, and the sharing state; also the other contexts on this machine (your_contexts). " +
          "With `details`, a summary of any one context on this machine instead: id, who made it, members, items, whether it's syncing, where it's stored.",
        inputSchema: {
          context: contextArg.describe("One of this chat's contexts (default: where writes go); with details, any on this machine"),
          details: z.boolean().optional(),
        },
        annotations: ro,
      },
      async ({ context, details }: { context?: string; details?: boolean }) => {
        // The summary of one context: the panels read it too, so it never takes the agent's notices.
        if (details || (context && !this.contexts.has(context) && this.localNames().includes(context))) {
          try {
            const name = context ?? this.writeTo;
            if (!name) throw new Error(this.noContext());
            const out = await this.details(name);
            return { ...text(out), structuredContent: out };
          } catch (e) {
            return failure((e as Error).message);
          }
        }
        return wrap(async () => {
          if (!this.contexts.size) return { using: "no context", context: null, contexts: [], your_contexts: this.localNames(), next: this.noContext() };
          const c = await this.target(context);
          return {
            using: this.where(c.name),
            context: c.name,
            id: c.d.graph_id ?? null,
            description: c.d.description ?? null,
            role: c.d.member === false ? null : c.d.you.role,
            ...(await this.request<Record<string, unknown>>("info", undefined, c.name)),
            contexts: this.list(),
            write_to: this.writeTo,
            your_contexts: this.localNames(),
            folder: this.folderState(),
            started_from: this.origin,
            next: this.many
              ? "Reads search every context in this chat; put each write in the one whose description fits (the `context` argument), else it goes to write_to."
              : "use_context switches this chat to another context, or with mode 'add' adds one alongside (the chat keeps them when reopened).",
          };
        })({});
      },
    );

    this.server.registerTool(
      "find_context",
      {
        title: "Find a context",
        description:
          "Search the contexts on this machine (whether or not this chat uses them) by name and what they are for. " +
          "Use it to find the context a topic belongs in, and before starting a new one. It searches contexts, not their contents: for claims and questions, use search.",
        inputSchema: {
          query: z.string().min(1).max(500).describe("What the context would be about"),
          limit: z.number().int().min(1).max(50).default(10).describe("How many contexts"),
        },
        annotations: ro,
      },
      wrap(async ({ query, limit }: { query: string; limit?: number }) => {
        const names = this.localNames();
        if (!names.length) return { found: [], your_contexts: [], next: this.noContext() };
        const cat = await this.openCatalogue();
        await cat.sync(names);
        const found = (await cat.find(query, limit ?? 10)).map((h) => ({ ...h, in_chat: this.contexts.has(h.name), writes_here: this.writeTo === h.name }));
        return {
          found,
          searched: names.length,
          next: found.length
            ? "Scores rank, they don't judge: read the descriptions. use_context switches this chat to one, or with mode 'add' adds it alongside; if none fits, ask the person before starting a new one."
            : "No context here matches. If the person wants one for this, ask what it's for and start it with use_context and a description.",
        };
      }),
    );

    this.server.registerTool(
      "model_guide",
      {
        title: "Model guide",
        description: "How to use a context: what to record, when, and how to query it. Read it before writing.",
        annotations: ro,
      },
      wrap(async () => {
        const first = [...this.contexts.values()][0];
        if (!first) return `${this.noContext()} Then call model_guide again.`;
        return (
          first.d.guide +
          (this.many
            ? `\n\n## Several contexts\n\nThis chat uses ${this.contexts.size} contexts.${this.contextsLine()} Reads search all of them. Put each write in the context whose description fits (the \`context\` argument); if none clearly fits, ask the person. Links (supports, answers, replies) stay inside one context.`
            : "")
        );
      }),
    );

    this.server.registerTool(
      "update_context",
      {
        title: "Change a context's purpose or name, or your name",
        description:
          "Change what a context is for (`purpose`; admins only; every member's agent sees it), this machine's own name for it (`rename_to`; other members keep theirs), " +
          "or the name others see for you in every context on this machine (`my_name`). Ask the person for each; don't invent them.",
        inputSchema: {
          purpose: z.string().min(1).max(500).optional().describe("A sentence or two: what goes in it and what doesn't"),
          rename_to: contextArg.describe("Lower-case letters, digits and dashes"),
          my_name: z.string().min(1).max(40).optional().describe("Letters, digits, spaces, dots, dashes or underscores"),
          context: anyHere,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async (a: { purpose?: string; rename_to?: string; my_name?: string; context?: string }) => {
        if (!a.purpose && !a.rename_to && !a.my_name) throw new Error("Nothing to change: give `purpose`, `rename_to` or `my_name`.");
        if (a.my_name && process.env.VINE_USER) throw new Error(`Your name is set by VINE_USER ('${process.env.VINE_USER}') in this agent's configuration; change it there.`);
        const out: Record<string, unknown> = {};
        if (a.my_name) {
          const n = setName(this.dataDir, a.my_name);
          for (const c of this.contexts.values()) await this.request("rename", { name: n }, c.name);
          out.my_name = { name: n, fingerprint: fingerprint(this.o.identity().publicKey), note: "This chat's contexts have it now; your other contexts take it when their hosts next start." };
        }
        if (a.purpose) {
          if (a.context && !this.contexts.has(a.context)) out.purpose = await this.onContext(a.context, (h) => h.request("describe_context", { description: a.purpose }));
          else {
            const c = await this.target(a.context);
            out.purpose = await this.request("describe_context", { description: a.purpose }, c.name);
            await this.refresh(c.name);
          }
        }
        if (a.rename_to) {
          const from = a.context ?? this.writeTo;
          if (!from) throw new Error(this.noContext());
          out.renamed = { ...(await this.renameLocal(from, a.rename_to)), note: "Renamed on this machine. Other members keep their own name for it." };
        }
        return out;
      }),
    );

    this.server.registerTool(
      "turn_server",
      {
        title: "Set or forget the TURN server",
        description:
          "Set (`set`) or forget (`clear`) the TURN server this machine's connections use when two members' networks block a direct connection (a join that fails with 'could not connect', or members who never link). " +
          "Most people need none. For `set`, ask the person for the server and their username on it; never invent them. " +
          "Never ask for the server's password or accept one in the chat: this tool takes none. It is read from VINE_TURN_PASSWORD where vine runs, or the person runs the result's `terminal_command` in their own terminal so vine keeps it.",
        inputSchema: {
          action: z.enum(["set", "clear"]),
          host: z.string().min(1).max(255).optional().describe("For set, e.g. turn.example.org"),
          port: z.number().int().min(1).max(65535).optional().describe("Default 3478 (5349 for tls)"),
          username: z.string().min(1).max(255).optional().describe("For set"),
          transport: z.enum(["udp", "tcp", "tls"]).optional().describe("Default udp"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      wrap(async (a: { action: "set" | "clear"; host?: string; port?: number; username?: string; transport?: "udp" | "tcp" | "tls" }) => {
        if (a.action === "clear") return { removed: clearTurn(this.dataDir), note: "Members whose networks block direct connections can no longer reach this machine directly. Links already open stay as they are." };
        if (!a.host || !a.username) throw new Error("To set a TURN server, give its `host` and the person's `username` on it.");
        if (process.env.VINE_ICE !== undefined) throw new Error("VINE_ICE is set in this agent's configuration and replaces this setting; change it there, or remove it first.");
        // A server whose password vine keeps is left alone: saving from here would drop that password.
        if (readCloudflare(this.dataDir))
          throw new Error(
            "Cloudflare TURN is set up on this machine, and this tool would replace it. To change it, the person runs `vine turn set` in a terminal; or remove it first with turn_server and the action 'clear'.",
          );
        const kept = readTurn(this.dataDir);
        if (kept && kept.store !== "env")
          throw new Error(
            `A TURN server is already set (${kept.host}:${kept.port}, user ${kept.username}) with its password kept by vine, and this tool can't replace it without losing that password. ` +
              "To change it, the person runs `vine turn set` in a terminal; or remove it first with turn_server and the action 'clear'.",
          );
        const t = saveTurn(this.dataDir, { host: a.host, port: a.port, username: a.username, transport: a.transport, store: "env" });
        const check = await checkStoredTurn(this.dataDir);
        const flag = t.transport === "udp" ? "" : ` --${t.transport}`;
        return {
          turn: `${t.host}:${t.port} (${t.transport})`,
          username: t.username,
          password_store: t.store,
          answered: check.ok,
          ...(check.ok ? {} : { problem: check.error }),
          terminal_command: `vine turn set ${t.host}:${t.port} --user ${t.username}${flag}`,
          note: check.ok
            ? "Saved, and the server answered with the password from VINE_TURN_PASSWORD. New connections use it when a direct one isn't possible; if a join failed, try it again."
            : "Saved, but the server hasn't answered yet. If VINE_TURN_PASSWORD isn't set where vine runs, give the person the terminal_command to run themselves: it asks for the password privately and keeps it. Don't ask them for the password.",
        };
      }),
    );

    this.server.registerTool(
      "share_context",
      {
        title: "Invite someone",
        description:
          "Invite one person to a context (admins only; default: the chat's context): makes a join code (vine1_…) that lets the first person to use it in, with the code's role and a full copy. " +
          "Your machine answers the code, so it must be online when they use it. Call it once per person, and only when the person asks to invite someone. " +
          "Unless they already said, ask first what the invitee may do: read and add (contributor), only read (reader), or read, add and invite (admin).",
        inputSchema: {
          label: z.string().max(60).optional().describe("Who it's for, e.g. 'for Sam'"),
          role: z.enum(["reader", "contributor", "admin"]).optional().describe("Default contributor"),
          expires_hours: z.number().positive().max(720).optional().describe("How long an unused code works (default 24)"),
          context: anyHere,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      wrap(async ({ context, ...a }) => {
        if (context && !this.contexts.has(context)) return this.onContext(context, async (h, n) => this.invited(await h.request<Record<string, any>>("share", a), n));
        const c = await this.target(context);
        return this.invited(await this.request<Record<string, any>>("share", a, c.name), c.name);
      }),
    );

    this.server.registerTool(
      "sharing",
      {
        title: "Sharing: status, go offline, go online",
        description:
          "`status`: whether a context is syncing, its invites (who each is for; open, used or expired), its members (name, key fingerprint, role, agent, online) and the links to them. " +
          "`off`: stop syncing it and answering its join codes until `on`; your copy keeps working and what you write is sent when you're back. Sharing is on by default.",
        inputSchema: { action: z.enum(["status", "on", "off"]), context: anyHere },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(({ action, context }: { action: "status" | "on" | "off"; context?: string }) =>
        this.onContext(context, (h) => h.request(action === "status" ? "status" : action === "on" ? "start_sharing" : "unshare")),
      ),
    );

    this.server.registerTool(
      "manage_member",
      {
        title: "Change a role, remove someone, cancel an invite",
        description:
          "For an admin of a context. `set_role`: change a member's role. " +
          "`remove`: take a member out; every machine stops syncing with them and refuses their later changes, but they keep the copy they already had. " +
          "`revoke_invite`: cancel a join code.",
        inputSchema: {
          action: z.enum(["set_role", "remove", "revoke_invite"]),
          name: z.string().optional().describe("The member (set_role, remove)"),
          role: z.enum(["reader", "contributor", "admin"]).optional(),
          invite: z.string().optional().describe("Invite id (inv_…) from sharing status"),
          context: which,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      wrap(({ action, name, role, invite, context }: { action: "set_role" | "remove" | "revoke_invite"; name?: string; role?: Role; invite?: string; context?: string }) => {
        if (action === "revoke_invite") {
          if (!invite) throw new Error("To cancel an invite, give its id as `invite` (inv_…, from sharing with the action 'status').");
          return this.request("revoke_invite", { id: invite }, context);
        }
        if (!name) throw new Error("Give the member's `name`.");
        if (action === "remove") return this.request("remove", { name }, context);
        if (!role) throw new Error("Give their new `role`: reader, contributor or admin.");
        return this.request("set_role", { name, role }, context);
      }),
    );

    this.server.registerTool(
      "join_context",
      {
        title: "Join a shared context",
        description:
          "Join someone else's context with the join code they sent (vine1_…; it can be inside other text). Use it when the person pastes such a code. " +
          "The machine that made the code must be online. You get your own full copy, kept in step with the others, and everyone is told you joined. " +
          "It's added to this chat and writes go to it; the result includes a briefing. Other chats don't need the code: use_context with its name.",
        inputSchema: { code: z.string().describe("The vine1_… join code, exactly as sent") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      wrap(async ({ code }: { code: string }) => this.join(code)),
    );

    const nameArg = z.string().regex(GRAPH_RE).describe("Lower-case letters, digits and dashes");
    const descriptionArg = z.string().max(500).optional().describe("For a new context: what goes in it, in a sentence or two");

    /** Starts a context of one's own if the name is new: describes it, and puts it online if sharing is on by default. It makes no join code: inviting is the person's step. */
    const created = async (name: string, isNew: boolean, description?: string) => {
      const c = this.contexts.get(name)!;
      if (isNew && description) {
        await this.request("describe_context", { description }, name);
        c.d = await c.host.request<Description>("describe");
        this.offer();
      }
      if (!isNew) return {};
      if (autoShare()) await this.request("start_sharing", undefined, name);
      return {
        created: this.where(name),
        next:
          (c.d.description ? "" : "Ask the person what this context is for and set it with update_context (`purpose`). ") +
          "No one is invited yet and there is no join code. When the person wants someone in, ask who and what they may do (read and add, only read, or also invite), then call share_context for that one person. " +
          "Call model_guide before writing.",
      };
    };

    this.server.registerTool(
      "use_context",
      {
        title: "Choose this chat's contexts",
        description:
          "Make a context on this machine (context_info lists your_contexts) this chat's context, replacing the ones it had; the chat keeps it when reopened. " +
          "A name that isn't here yet starts a new context of your own: ask the person what it's for and pass that as `description`. " +
          "Mode `add` uses it alongside the chat's others (most chats need one). Mode `remove` takes it out of the chat (without a name, all of them); nothing is deleted.",
        inputSchema: {
          name: contextArg.describe("Lower-case letters, digits and dashes"),
          mode: z.enum(["replace", "add", "remove"]).default("replace"),
          description: descriptionArg,
          write_here: z.boolean().optional().describe("With add: writes go to it by default"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async ({ name, mode, description, write_here }: { name?: string; mode?: "replace" | "add" | "remove"; description?: string; write_here?: boolean }) => {
        if (mode === "remove") {
          for (const n of name ? [name] : [...this.contexts.keys()]) this.detach(n);
          return { contexts: this.list(), write_to: this.writeTo ?? null, ...(this.contexts.size ? {} : { next: this.noContext() }) };
        }
        if (!name) throw new Error("Give the context's `name`.");
        const isNew = !this.localNames().includes(name);
        await this.attach(name, false);
        if (mode === "add") {
          if (write_here) this.writeTo = name;
          this.remember();
          this.offer();
          return {
            contexts: this.list(),
            write_to: this.writeTo,
            next: this.many ? "Call model_guide again: it says how to pick a context for each write." : "Call model_guide before writing.",
            ...(await created(name, isNew, description)),
          };
        }
        for (const other of [...this.contexts.keys()]) if (other !== name) (this.contexts.get(other)!.host.close(), this.contexts.delete(other));
        this.writeTo = name;
        this.origin = "chosen";
        this.remember();
        this.offer();
        const c = this.contexts.get(name)!;
        return { using: this.where(name), description: c.d.description ?? null, next: "Call model_guide before writing to it.", ...(await created(name, isNew, description)) };
      }),
    );

    this.server.registerTool(
      "delete_context",
      {
        title: "Delete a context from this machine",
        description:
          "Permanently delete this machine's copy of a context: its claims, questions and replies, its change log, its join codes, and every chat's and folder's link to it. It can't be undone. " +
          "Other members keep their copies; with none, it is gone for good. " +
          "Only when the person asked to delete it: first tell them what it removes and ask them to confirm by name, then pass that name as `confirm`. To only stop using it in this chat, use_context with mode `remove`.",
        inputSchema: { name: nameArg, confirm: z.string().describe("The context's name again, as the person confirmed it") },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      wrap(async ({ name, confirm }: { name: string; confirm: string }) => {
        if (confirm !== name) throw new Error(`Not deleted: to confirm, pass the context's name ('${name}') as \`confirm\`, exactly.`);
        const r = await this.deleteLocal(name);
        return { ...r, note: "Deleted from this machine. Other members keep their copies.", ...(this.contexts.size ? {} : { next: this.noContext() }) };
      }),
    );

    this.server.registerTool(
      "link_folder",
      {
        title: "Start this folder's chats here",
        description:
          "Make new chats started in this chat's folder (or below it) start with this chat's contexts; with `off`, stop that. " +
          "With `name`, pin (or with `off`, unpin) just that context, leaving the folder's others as they are. Kept on this machine, not in the folder. Ask the person first.",
        inputSchema: {
          off: z.boolean().optional(),
          name: contextArg,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async ({ off, name }: { off?: boolean; name?: string }) => {
        if (!this.o.cwd) throw new Error("This session doesn't know which folder it started in.");
        if (name) {
          if (!this.localNames().includes(name)) throw new Error(`There's no context '${name}' on this machine.`);
          // The folder's own link, or the one it gets from a parent folder.
          const f = folderLink(this.dataDir, this.o.cwd);
          const folder = f?.folder ?? this.o.cwd;
          const id = readGroup(this.dataDir, name)?.id;
          const rest: Ref[] = (f?.contexts ?? []).filter((r) => resolveRef(this.dataDir, r) !== name);
          const contexts: Ref[] = off ? rest : [...rest, { name, ...(id ? { id } : {}) }];
          const write_to = f?.write_to && contexts.some((r) => r.name === f.write_to) ? { write_to: f.write_to } : {};
          setFolderLink(this.dataDir, folder, contexts.length ? { contexts, ...write_to } : null);
          return {
            folder,
            pinned: contexts.map((r) => r.name),
            note: off ? `New chats in this folder no longer start with '${name}'.` : `New chats started in this folder, or below it, start with '${name}'.`,
          };
        }
        if (off) {
          const f = folderLink(this.dataDir, this.o.cwd);
          if (f) setFolderLink(this.dataDir, f.folder, null);
          return { folder: f?.folder ?? this.o.cwd, linked: null };
        }
        if (!this.contexts.size) throw new Error(this.noContext());
        setFolderLink(this.dataDir, this.o.cwd, this.link());
        return { folder: this.o.cwd, linked: [...this.contexts.keys()], note: "New chats started in this folder, or below it, start with these contexts." };
      }),
    );

  }

  /** What the console shows. */
  private async consoleState(context?: string): Promise<Record<string, unknown>> {
    const c = await this.target(context);
    const status = await this.request<Record<string, any>>("status", undefined, c.name);
    return {
      using: this.where(c.name),
      ...status,
      you: { ...status.you, name_from: nameSource(this.dataDir) },
      graphs: this.localNames(),
    };
  }

  private registerAppTools(): void {
    const ro = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
    const run = (fn: (args: any) => Promise<Content>) => async (args: any) => {
      try {
        return this.withNews(await fn(args));
      } catch (e) {
        return this.withNews(failure((e as Error).message));
      }
    };
    const both = (summary: unknown, structured: Record<string, unknown>): Content => ({ ...text(summary), structuredContent: structured });
    const which = contextArg.describe("One of this chat's contexts (default: where writes go)");

    this.server.registerTool(
      "open_view",
      {
        title: "Show a view of a context",
        description:
          "Show the person a view of this chat's context: `contexts` (the panel: what needs them, questions and threads, claims, people and join codes, and the chat's contexts), " +
          "`console` (sharing: members, key fingerprints, roles, who is online, join codes) or `explorer` (a picture of its items and links, as it stood `at` a moment). " +
          "For the person to look at and steer from; to read the context yourself, use search and the other read tools." +
          (this.o.browserView ? " If this agent can't show views, pass `browser` for a link to them in a browser tab." : ""),
        inputSchema: {
          view: z.enum(OPEN_VIEWS).default("contexts"),
          at: z.string().meta({ format: "date-time" }).optional().describe("Explorer: ISO 8601, default now"),
          limit: z.number().int().min(1).max(1000).optional().describe("Explorer: most recent items (default 200)"),
          ...(this.o.browserView ? { browser: z.boolean().optional() } : {}),
          context: which,
        },
        annotations: ro,
        _meta: uiMeta("view", { beside: true }),
      },
      run(async ({ view = "contexts", at, limit, browser, context }: { view?: OpenView; at?: string; limit?: number; browser?: boolean; context?: string }) => {
        if (browser && this.o.browserView) {
          const url = await this.o.browserView();
          const opened = openInBrowser(url);
          const out = {
            url,
            opened,
            note: opened
              ? "Opened in the default browser. If no tab appeared, open the link on this machine. Don't share it: it acts as you. It works only on this machine and while this session runs."
              : "Open it in a browser on this machine. Don't share it: it acts as you. It works only on this machine and while this session runs.",
          };
          return both(out, { view: "browser", ...out });
        }
        if (view === "console") {
          const state = await this.consoleState(context);
          return both(state, { view, ...state });
        }
        if (view === "explorer") {
          if (at !== undefined) {
            const ok = isoMoment().safeParse(at);
            if (!ok.success) throw new Error(`Invalid input:\n- at: ${ok.error.issues[0]?.message}`);
          }
          const c = await this.target(context);
          const snap = await this.request<Snapshot>("snapshot", { ...(at ? { at } : {}), limit: limit ?? 200 }, c.name);
          const counts: Record<string, number> = {};
          for (const n of snap.nodes) counts[n.label] = (counts[n.label] ?? 0) + 1;
          return both(
            {
              showing: this.where(c.name),
              at: snap.at,
              nodes: counts,
              links: snap.edges.length,
              truncated: snap.truncated,
              note: "The explorer shows the picture to the person; this summary is all you get here.",
            },
            { view, ...snap, where: this.where(c.name) } as unknown as Record<string, unknown>,
          );
        }
        if (!this.contexts.size) {
          const none = { using: "no context", context: null, contexts: [], your_contexts: this.localNames(), next: this.noContext() };
          return both(none, { view, ...none });
        }
        const state = await this.activity({ limit: 40, snapshot: true, context });
        const snap = state.snapshot as Snapshot;
        // The agent gets a line about what the person now sees, not the whole context.
        return both({ showing: state.using, context: state.context, items: snap.nodes.length, note: "The person is looking at the contexts panel." }, { view, ...state });
      }),
    );
  }

  /** What share_context says about a new invite. */
  /** What to tell the person about the name others see, when they didn't choose it themselves. */
  private nameNote(): { your_name?: string } {
    const source = nameSource(this.dataDir);
    const { name } = this.o.identity();
    if (source === "VINE_USER" || source === "chosen") return {};
    if (isGuessedName(source))
      return {
        your_name: `Others see this person as '${name}', which is ${source === "login" ? "only their login name" : "a made-up name"}. If this chat hasn't asked yet, ask what name they want and save it with update_context (my_name); if they'd rather not say, '${name}' stays.`,
      };
    return {
      your_name: `Others see this person as '${name}' (${source === "git" ? "from git's user.name" : "the full name on their computer account"}). If this chat hasn't told them yet, do, and offer update_context (my_name) if they want another.`,
    };
  }

  private invited(r: Record<string, any>, context: string) {
    const identity = this.o.identity();
    return {
      context,
      code: r.code,
      send: `Join my context graph: /vine-context:join ${r.code}`,
      invite: { id: r.id, label: r.label, role: r.role, expires_at: r.expires_at },
      shared_as: { name: identity.name, fingerprint: fingerprint(identity.publicKey) },
      ...this.nameNote(),
      next:
        "Give the person the 'send' line to pass on privately (not in a public channel). Agents without the plugin command can be told: join the context with this code. " +
        "This machine answers the code, so it must be online when they use it. Whoever uses it first is let in at once and gets a full copy, and everyone in the context is told who joined (name, key fingerprint, agent). " +
        "Each code is for one person: call share_context again for the next. manage_member takes anyone out.",
    };
  }

  /** Joins a context with a code: gets its whole log from the machine that made the code, keeps a copy here, adds it to this chat (writes go to it) and briefs the agent. */
  private async join(codeText: string): Promise<unknown> {
    const link = parseCode(codeText);
    const identity = this.o.identity();
    const client = this.server.server.getClientVersion();
    const about = {
      agent: client?.name,
      agent_version: client?.version,
      vine: packageInfo().version,
      platform: `${OS[process.platform] ?? process.platform} ${process.arch}`,
    };
    const welcome = await joinWithCode(link, identity, { signal: this.o.signal, ice: this.o.ice, about, timeoutMs: this.o.joinWaitMs ?? 30_000, log: this.o.log });

    // Put it on this machine: under its own name if that's free, else name-2, name-3 …
    const base = GRAPH_RE.test(welcome.graph.name) ? welcome.graph.name : "shared";
    const here = this.localNames();
    let name: string | undefined;
    for (let i = 1; i < 100 && !name; i++) {
      const candidate = i === 1 ? base : `${base}-${i}`.slice(0, 63);
      const group = readGroup(this.dataDir, candidate);
      if (group?.id === welcome.graph.id) name = candidate; // already here: its host syncs it
      else if (!group && !here.includes(candidate)) {
        if (placeReplica(this.dataDir, candidate, welcome.graph, welcome.changes)) name = candidate;
      }
    }
    if (!name) throw new Error("Couldn't find a free name for this context on this machine.");
    const c = await this.attach(name, false);
    this.writeTo = name;
    this.remember();
    this.offer();
    const brief = await this.request<Record<string, unknown>>("briefing", undefined, name).catch(() => null);
    return {
      joined: `${welcome.host || c.d.host}'s context '${welcome.graph.name}'`,
      here_as: name,
      description: c.d.description ?? null,
      role: c.d.you.role,
      as: c.d.you.id,
      your_fingerprint: fingerprint(identity.publicKey),
      ...this.nameNote(),
      contexts: this.list(),
      copy: `You have your own full copy (${welcome.changes.length} changes), kept in step with the other members whenever you're both online. It works offline too.`,
      briefing: brief,
      told: "Everyone in this context has been told you joined, with your name, key fingerprint and agent.",
      next: `Tell the person what it's for and give them the briefing in a few lines. Call model_guide before writing. It's in this chat now (and stays when the chat is reopened); in other chats, use_context '${name}' (no code needed).`,
    };
  }
}
