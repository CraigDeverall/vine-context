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
import { inputShape, type Role, type Snapshot } from "../core/graph.js";
import { fingerprint, isGuessedName, nameSource, setName, type Identity } from "../core/identity.js";
import { claimsPack } from "../core/pack.js";
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
  /** Starts (once) the localhost page that shows the views, and returns its link: browser_view. */
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
          "Every member keeps a full copy, so it works offline. A chat usually uses one context; use_context switches it, add_context adds another, remove_context drops one, and the chat keeps them when reopened. " +
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
      throw new Error(`This chat doesn't use '${name}': it uses ${[...this.contexts.keys()].map((n) => `'${n}'`).join(", ") || "no context"}. add_context adds one.`);
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

  /** Registers the model's tools for the chat's contexts, as far as this machine's roles allow. */
  private offer(): void {
    for (const t of this.modelTools.values()) t.remove();
    this.modelTools.clear();
    const all = [...this.contexts.values()];
    if (!all.length) {
      // No context yet: the model's tools are still offered, and say what to do first.
      for (const tool of claimsPack().tools) {
        const registered = this.server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: `${tool.description} This chat has no context yet: this tells you how to choose one.`,
            inputSchema: inputShape(tool.input),
            annotations: { readOnlyHint: tool.kind === "read", destructiveHint: false, idempotentHint: tool.kind === "read", openWorldHint: false },
          },
          async () => this.withNews(failure(this.noContext())),
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
      const registered = this.server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description + routing,
          inputSchema: {
            ...inputShape(tool.input),
            ...(many ? { context: contextArg.describe(tool.kind === "write" ? "The context to write to (default: the write context)" : "Only this context (default: all of this chat's)") } : {}),
          },
          annotations: { readOnlyHint: tool.kind === "read", destructiveHint: false, idempotentHint: tool.kind === "read", openWorldHint: false },
          ...(tool.view ? { _meta: uiMeta(tool.view) } : {}),
        },
        async (raw: Record<string, unknown>) => {
          const { context, ...args } = raw as Record<string, unknown> & { context?: string };
          try {
            await this.followRenames();
            if (tool.kind === "read" && !context && this.many) return this.withNews(await this.readAll(tool.name, args));
            const c = await this.target(context);
            let result = await this.request<Record<string, unknown>>("call", { tool: tool.name, args }, c.name);
            if (Array.isArray(result) && this.many) result = result.map((row) => ({ context: c.name, ...row })) as unknown as Record<string, unknown>;
            const out = text(result);
            const held =
              tool.kind === "write" && result && typeof result === "object" && result.shared_at
                ? ` It stays on this machine until ${result.shared_at}; until then take_back removes it without trace.`
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
                undo: tool.kind === "write" ? { take_back: true, withdraw: RANK[this.roleIn(c)] >= RANK.contributor } : null,
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
    const which = contextArg.describe("Which of this chat's contexts (default: the one writes go to)");
    const anyHere = contextArg.describe("Which context: one of this chat's (default: the one writes go to), or any other on this machine by name");

    this.server.registerTool(
      "context_info",
      {
        title: "Context info",
        description:
          "This chat's context: what it's for, your role, how much it holds, everyone in it and who is online, and the sharing state. Also the other contexts on this machine (your_contexts). " +
          "If the chat uses several, `contexts` lists them and `context` picks which one to detail.",
        inputSchema: { context: which },
        annotations: ro,
      },
      wrap(async ({ context }: { context?: string }) => {
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
            : "use_context switches this chat to another context; add_context adds one alongside (the chat keeps them when reopened).",
        };
      }),
    );

    this.server.registerTool(
      "find_context",
      {
        title: "Find a context",
        description:
          "Search the contexts on this machine (yours and ones you joined, whether or not this chat uses them) by name and what they are for, ranked by hybrid search (meaning plus keywords). " +
          "Use it to find the context a topic belongs in, and before starting a new one, so it isn't a duplicate. It searches contexts, not what's in them: for claims and questions, use search.",
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
            ? "Scores rank, they don't judge: read the descriptions. use_context switches this chat to one, add_context adds it alongside; if none fits, ask the person before starting a new one."
            : "No context here matches. If the person wants one for this, ask what it's for and start it with use_context or add_context and a description.",
        };
      }),
    );

    this.server.registerTool(
      "context_activity",
      {
        title: "Context activity",
        description:
          "What happened lately in one of this chat's contexts (default: the write context), newest first: who wrote what (yours and synced from others), what others' changes meant for you (the sync digest), joins and role changes, who is online, and (for an admin) the open join codes. " +
          "With snapshot, also its items and links. Read-only; it never uses up the notices meant for you (it's what the Claude Code mod's band and panel poll).",
        inputSchema: {
          limit: z.number().int().min(1).max(200).optional().describe("How many recent changes (default 30)"),
          snapshot: z.boolean().optional().describe("Also return the context as it stands now (items and links)"),
          context: which,
        },
        annotations: ro,
      },
      async (a: { limit?: number; snapshot?: boolean; context?: string }) => {
        try {
          if (!this.contexts.size) {
            const none = { using: "no context", context: null, contexts: [], your_contexts: this.localNames(), next: this.noContext() };
            return { ...text(none), structuredContent: none };
          }
          const out = await this.activity(a);
          return { ...text(out), structuredContent: out };
        } catch (e) {
          return failure((e as Error).message); // no withNews: this read never takes the agent's notices
        }
      },
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
      "describe_context",
      {
        title: "Describe a context",
        description:
          "Set what a context is for, in a sentence or two (you must be an admin): what goes in it and what doesn't. Every member's agent sees it. " +
          "Ask the person for it; don't invent it.",
        inputSchema: { description: z.string().min(1).max(500).describe("What the context is for"), context: anyHere },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async (a: { description: string; context?: string }) => {
        if (a.context && !this.contexts.has(a.context)) return this.onContext(a.context, (h) => h.request("describe_context", { description: a.description }));
        const c = await this.target(a.context);
        const r = await this.request("describe_context", { description: a.description }, c.name);
        await this.refresh(c.name);
        return r;
      }),
    );

    this.server.registerTool(
      "set_my_name",
      {
        title: "Set your name",
        description:
          "Set the name other people see for you in every context on this machine (for example 'Craig Deverall'). Ask the person what they want to be called; don't invent it. " +
          "You are your machine's key; the name is a label you can change. What you recorded before shows the new name too.",
        inputSchema: { name: z.string().min(1).max(40).describe("1–40 letters, digits, spaces, dots, dashes or underscores") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async ({ name }: { name: string }) => {
        if (process.env.VINE_USER) throw new Error(`Your name is set by VINE_USER ('${process.env.VINE_USER}') in this agent's configuration; change it there.`);
        const n = setName(this.dataDir, name);
        for (const c of this.contexts.values()) await this.request("rename", { name: n }, c.name);
        return { name: n, fingerprint: fingerprint(this.o.identity().publicKey), note: "This chat's contexts have it now; your other contexts take it when their hosts next start." };
      }),
    );

    this.server.registerTool(
      "set_turn_server",
      {
        title: "Set a TURN server",
        description:
          "Set the TURN server this machine's connections go through when two members' networks block a direct connection (a join that fails with 'could not connect', or members who never link). " +
          "Most people don't need one, and there is none by default. The person must have a server and a username on it: ask for them, never invent them. " +
          "Never ask for the server's password, and never accept one in the chat: this tool takes none. It saves the server and username only, and the password is read from the VINE_TURN_PASSWORD environment variable where vine runs. " +
          "To have vine keep the password instead (in a file only the person can read, or the OS keychain), the person runs the `terminal_command` from the result in their own terminal: it asks for the password there, unseen. " +
          "It applies to every context on this machine, from the next connection on, with nothing to restart. One of two members having a server is enough for that pair. The result says whether the server answered.",
        inputSchema: {
          host: z.string().min(1).max(255).describe("The server's host name or address, e.g. turn.example.org"),
          port: z.number().int().min(1).max(65535).optional().describe("Default 3478 (5349 for tls)"),
          username: z.string().min(1).max(255),
          transport: z.enum(["udp", "tcp", "tls"]).optional().describe("How to reach the server (default udp)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      wrap(async (a: { host: string; port?: number; username: string; transport?: "udp" | "tcp" | "tls" }) => {
        if (process.env.VINE_ICE !== undefined) throw new Error("VINE_ICE is set in this agent's configuration and replaces this setting; change it there, or remove it first.");
        // A server whose password vine keeps is left alone: saving from here would drop that password.
        if (readCloudflare(this.dataDir))
          throw new Error(
            "Cloudflare TURN is set up on this machine, and this tool would replace it. To change it, the person runs `vine turn set` in a terminal; or remove it first with remove_turn_server.",
          );
        const kept = readTurn(this.dataDir);
        if (kept && kept.store !== "env")
          throw new Error(
            `A TURN server is already set (${kept.host}:${kept.port}, user ${kept.username}) with its password kept by vine, and this tool can't replace it without losing that password. ` +
              "To change it, the person runs `vine turn set` in a terminal; or remove it first with remove_turn_server.",
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
      "remove_turn_server",
      {
        title: "Remove the TURN server",
        description: "Forget this machine's TURN server and its password. New connections are direct only; links already open stay as they are.",
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      wrap(async () => ({ removed: clearTurn(this.dataDir), note: "Members whose networks block direct connections can no longer reach this machine directly." })),
    );

    this.server.registerTool(
      "share_context",
      {
        title: "Invite someone",
        description:
          "Invite one person to a context (you must be an admin of it; default: the chat's context): makes a new join code (vine1_…) for that person. " +
          "Your machine answers the code, so it must be online when they use it. The first person to use it is let straight in with the code's role and gets a full copy; anyone else using it is turned away. " +
          "Everyone in the context is told when someone joins, with their name, key fingerprint and agent. remove_peer takes anyone out. " +
          "An unused code expires (default 24 hours). Call it once per person, and only when the person asks to invite someone. " +
          "Unless they already said, ask first what the person may do: read and add (contributor), only read (reader), or read, add and invite (admin). sharing_status lists invites; revoke_invite cancels one.",
        inputSchema: {
          label: z.string().max(60).optional().describe("Who it's for, e.g. 'for Sam': shown in sharing_status and in the join notice"),
          role: z.enum(["reader", "contributor", "admin"]).optional().describe("The role they get when they join: the person's choice (default contributor)"),
          expires_hours: z.number().positive().max(720).optional().describe("Hours until an unused code stops working (default 24)"),
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
      "revoke_invite",
      {
        title: "Cancel an invite",
        description: "Cancel a join code you made: it stops working. Use the invite id from sharing_status. To take someone out of a context, use remove_peer.",
        inputSchema: { id: z.string().describe("The invite id (inv_…), as sharing_status shows it"), context: which },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      wrap(({ context, ...a }) => this.request("revoke_invite", a, context)),
    );

    this.server.registerTool(
      "stop_sharing",
      {
        title: "Go offline",
        description:
          "Stop syncing a context with the other members, and stop answering your join codes for it, until you share again (start_sharing, or the console). " +
          "Your copy keeps working; what you write is sent when you're back. Sharing is on by default.",
        inputSchema: { context: anyHere },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(({ context }) => this.onContext(context, (h) => h.request("unshare"))),
    );

    this.server.registerTool(
      "start_sharing",
      {
        title: "Go online",
        description:
          "Start syncing a context with the other members again after stop_sharing, and answer your join codes for it. It makes no new join code (share_context does). Sharing is on by default, so this is only needed after going offline.",
        inputSchema: { context: anyHere },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(({ context }) => this.onContext(context, (h) => h.request("start_sharing"))),
    );

    this.server.registerTool(
      "sharing_status",
      {
        title: "Sharing status",
        description:
          "Whether a context is syncing, its invites (who each is for, open, used or expired), everyone in it (name, key fingerprint, role, agent, operating system, online), the links to other members, and the signalling relays' state.",
        inputSchema: { context: which },
        annotations: ro,
      },
      wrap(({ context }) => this.request("status", undefined, context)),
    );

    const roleSchema = z.enum(["reader", "contributor", "admin"]);
    this.server.registerTool(
      "set_peer_role",
      {
        title: "Change someone's role",
        description: "Change a member's role in a context (you must be an admin): reader, contributor or admin. Every member's machine applies it.",
        inputSchema: { name: z.string().describe("Their name"), role: roleSchema.describe("Their new role"), context: which },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(({ context, ...a }) => this.request("set_role", a, context)),
    );

    this.server.registerTool(
      "remove_peer",
      {
        title: "Remove someone",
        description:
          "Take a member out of a context (you must be an admin). Every member's machine stops syncing with them and refuses their later changes. Their past contributions stay. " +
          "They keep the copy they already had: removal can't take back what they received.",
        inputSchema: { name: z.string().describe("Their name"), context: which },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      wrap(({ context, ...a }) => this.request("remove", a, context)),
    );

    this.server.registerTool(
      "join_context",
      {
        title: "Join a shared context",
        description:
          "Join someone else's context with the join code they sent (vine1_…; it can be inside other text). Use it when the person pastes such a code. " +
          "The machine that made the code must be online. You are let in at once and get your own full copy, kept in step with the others; everyone is told you joined (your name, key fingerprint and agent). " +
          "It's added to this chat and writes go to it; the result includes a briefing (open questions, conflicts, latest). Other chats don't need the code: use_context with its name.",
        inputSchema: { code: z.string().describe("The vine1_… join code, exactly as sent") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      wrap(async ({ code }: { code: string }) => this.join(code)),
    );

    const nameArg = z.string().regex(GRAPH_RE).describe("Context name: lower-case letters, digits and dashes");
    const descriptionArg = z.string().max(500).optional().describe("For a new context: what it's for (what goes in it), in a sentence or two");

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
          (c.d.description ? "" : "Ask the person what this context is for and set it with describe_context. ") +
          "No one is invited yet and there is no join code. When the person wants someone in, ask who and what they may do (read and add, only read, or also invite), then call share_context for that one person. " +
          "Call model_guide before writing.",
      };
    };

    this.server.registerTool(
      "use_context",
      {
        title: "Use a context in this chat",
        description:
          "Make a context this chat's context, replacing the ones it had: one on this machine (yours, or one you joined; context_info lists your_contexts). The chat keeps it when reopened. " +
          "A name that isn't here yet starts a new context of your own: ask the person what it's for and give that as its description. To use another alongside, add_context.",
        inputSchema: { name: nameArg, description: descriptionArg },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async ({ name, description }: { name: string; description?: string }) => {
        const isNew = !this.localNames().includes(name);
        await this.attach(name, false);
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
      "add_context",
      {
        title: "Also use a context",
        description:
          "Add another context to this chat, alongside the ones it uses (most chats need one). Reads then search it too, and writes go to whichever context fits. A new name starts a new context of your own: ask what it's for. " +
          "With write_here, writes go to it unless a call names another.",
        inputSchema: { name: nameArg, description: descriptionArg, write_here: z.boolean().optional().describe("Make it where writes go by default") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async ({ name, description, write_here }: { name: string; description?: string; write_here?: boolean }) => {
        const isNew = !this.localNames().includes(name);
        await this.attach(name, false);
        if (write_here) this.writeTo = name;
        this.remember();
        this.offer();
        return {
          contexts: this.list(),
          write_to: this.writeTo,
          next: this.many ? "Call model_guide again: it says how to pick a context for each write." : "Call model_guide before writing.",
          ...(await created(name, isNew, description)),
        };
      }),
    );

    this.server.registerTool(
      "remove_context",
      {
        title: "Stop using a context",
        description:
          "Take a context out of this chat (nothing is deleted: it stays on this machine and keeps syncing). Without `name`, takes them all out, leaving the chat with no context.",
        inputSchema: { name: z.string().regex(GRAPH_RE).optional().describe("The context to take out (default: all of them)") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async ({ name }: { name?: string }) => {
        for (const n of name ? [name] : [...this.contexts.keys()]) this.detach(n);
        return { contexts: this.list(), write_to: this.writeTo ?? null, ...(this.contexts.size ? {} : { next: this.noContext() }) };
      }),
    );

    this.server.registerTool(
      "context_details",
      {
        title: "A context's details",
        description:
          "Everything about one context on this machine, whether or not this chat uses it: what it's for, its id, your role, who made it, how many members and items it has, whether it's syncing, and where it's stored. Read-only.",
        inputSchema: { name: nameArg },
        annotations: ro,
      },
      async ({ name }: { name: string }) => {
        try {
          const out = await this.details(name);
          return { ...text(out), structuredContent: out };
        } catch (e) {
          return failure((e as Error).message); // no withNews: the panel reads this too
        }
      },
    );

    this.server.registerTool(
      "rename_context",
      {
        title: "Rename a context on this machine",
        description:
          "Give a context on this machine (whether or not this chat uses it) a new name. The name is this machine's own label for it: other members keep theirs, and the context's id doesn't change. " +
          "Every chat and folder that uses it follows it to the new name. Only when the person asks: they choose the name.",
        inputSchema: { name: nameArg, to: z.string().regex(GRAPH_RE).describe("The new name: lower-case letters, digits and dashes") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async ({ name, to }: { name: string; to: string }) => ({ ...(await this.renameLocal(name, to)), note: "Renamed on this machine. Other members keep their own name for it." })),
    );

    this.server.registerTool(
      "delete_context",
      {
        title: "Delete a context from this machine",
        description:
          "Permanently delete this machine's copy of a context: its claims, questions and replies, its change log, the join codes made here, and every chat's and folder's link to it. It can't be undone. " +
          "Other members keep their own copies; with no other member, it is gone for good. Getting it back means joining again with a new code from an admin. " +
          "Only when the person asked to delete it: first tell them what it removes and ask them to confirm by name, then pass that name as `confirm`. To only stop using it in this chat, use remove_context.",
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
          "Make new chats started in this chat's folder (or below it) start with this chat's contexts, or with `off`, stop that. " +
          "With `name`, pin just that one context to the folder (any on this machine), or with `off` too, unpin it, leaving the folder's others as they are. " +
          "It's kept on this machine (nothing is written into the folder). Ask the person first.",
        inputSchema: {
          off: z.boolean().optional().describe("Stop linking the folder (or, with name, unpin that context)"),
          name: z.string().regex(GRAPH_RE).optional().describe("Pin or unpin only this context"),
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

    this.server.registerTool(
      "take_back",
      {
        title: "Take back a write",
        description:
          "Undo something you just wrote, while it is still only on this machine (for a few seconds after writing): it is removed and never reaches anyone. " +
          "Use it when something was recorded by mistake, such as personal details in the wrong chat. After that, use withdraw (which keeps it in the history).",
        inputSchema: { id: z.string().describe("The change id (change) or the item's id from the write's result"), context: contextArg.describe("The context it was written to (default: each of this chat's, in turn)") },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      wrap(async ({ id, context }: { id: string; context?: string }) => {
        if (context || !this.many) return this.request("take_back", { id }, context);
        let last: unknown;
        for (const c of this.contexts.values()) {
          try {
            return { context: c.name, ...((await this.request<Record<string, unknown>>("take_back", { id }, c.name)) as object) };
          } catch (e) {
            last = e;
            if (/already been shared/.test((e as Error).message)) throw e;
          }
        }
        throw last instanceof Error ? last : new Error(`No write ${id} from this machine.`);
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
    const which = contextArg.describe("Which of this chat's contexts (default: the one writes go to)");

    this.server.registerTool(
      "open_contexts",
      {
        title: "Open the contexts panel",
        description:
          "Show the person this chat's context in a panel: what needs them, its questions with their threads, its claims (with conflicts and history), its people and join codes, and the chat's contexts to turn on and off. " +
          "For the person to look at and steer from; to read the context yourself, use context_info and the model's search and read tools.",
        inputSchema: {},
        annotations: ro,
        _meta: uiMeta("contexts", { beside: true }),
      },
      run(async () => {
        if (!this.contexts.size) {
          const none = { using: "no context", context: null, contexts: [], your_contexts: this.localNames(), next: this.noContext() };
          return both(none, none);
        }
        const state = await this.activity({ limit: 40, snapshot: true });
        const snap = state.snapshot as Snapshot;
        // The agent gets a line about what the person now sees, not the whole context.
        return both({ showing: state.using, context: state.context, items: snap.nodes.length, note: "The person is looking at the contexts panel." }, state);
      }),
    );

    this.server.registerTool(
      "open_console",
      {
        title: "Open the sharing console",
        description:
          "Show the sharing console for a context: everyone in it (with key fingerprints, agents, roles and who is online), your join codes, and whether it is syncing. " +
          "An admin can make codes, change roles and remove people there.",
        inputSchema: { context: which },
        annotations: ro,
        _meta: uiMeta("console"),
      },
      run(async (a: { context?: string }) => {
        const state = await this.consoleState(a.context);
        return both(state, state);
      }),
    );

    this.server.registerTool(
      "explore_context",
      {
        title: "Explore a context",
        description:
          "Show a context as an interactive picture: its items and the links between them, as it stood at a moment (default now). " +
          "For the person to look at; to answer a question yourself, use the model's search and read tools.",
        inputSchema: {
          at: z.iso.datetime({ offset: true }).optional().describe("Show it as it stood at this time (ISO 8601). Default now."),
          limit: z.number().int().min(1).max(1000).default(200).describe("Most recent items to show"),
          context: which,
        },
        annotations: ro,
        _meta: uiMeta("explorer"),
      },
      run(async ({ context, ...a }: { at?: string; limit?: number; context?: string }) => {
        const c = await this.target(context);
        const snap = await this.request<Snapshot>("snapshot", a, c.name);
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
          { ...snap, where: this.where(c.name) } as unknown as Record<string, unknown>,
        );
      }),
    );

    if (this.o.browserView)
      this.server.registerTool(
        "browser_view",
        {
          title: "Open the views in a browser",
          description:
            "Get a link to the console and explorer in a browser tab on this machine, for when this agent can't show MCP App views itself. " +
            "Give the person the link to open; it works only on this machine and while this session runs.",
          annotations: ro,
        },
        run(async () => {
          const url = await this.o.browserView!();
          const opened = openInBrowser(url);
          return text({
            url,
            opened,
            note: opened
              ? "Opened in the default browser. If no tab appeared, open the link on this machine. Don't share it: it acts as you."
              : "Open it in a browser on this machine. Don't share it: it acts as you.",
          });
        }),
      );
  }

  /** What share_context says about a new invite. */
  /** What to tell the person about the name others see, when they didn't choose it themselves. */
  private nameNote(): { your_name?: string } {
    const source = nameSource(this.dataDir);
    const { name } = this.o.identity();
    if (source === "VINE_USER" || source === "set_my_name") return {};
    if (isGuessedName(source))
      return {
        your_name: `Others see this person as '${name}', which is ${source === "login" ? "only their login name" : "a made-up name"}. If this chat hasn't asked yet, ask what name they want and save it with set_my_name; if they'd rather not say, '${name}' stays.`,
      };
    return {
      your_name: `Others see this person as '${name}' (${source === "git" ? "from git's user.name" : "the full name on their computer account"}). If this chat hasn't told them yet, do, and offer set_my_name if they want another.`,
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
        "Each code is for one person: call share_context again for the next. remove_peer takes anyone out.",
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
