// The MCP server each agent session runs. It never opens a context graph
// itself: it is a client of this machine's hosts (started if needed). Every
// context this machine is in, its own or one it joined, is a full local copy
// kept in step with the other members by its host, so reads and writes always
// work, offline too.
//
// A conversation can have several contexts attached (attach_context, or a
// folder's `.p2p-context` file). Reads run across all of them, each result
// saying which context it came from; a write goes to one: the one the call
// names (`context`), else the write context. Each context has a description,
// shown in the tools' descriptions, so the agent can tell where a claim goes.
//
// The model's tools are re-registered (with tools/list_changed) when the
// attached contexts or a role change.

import { spawn } from "node:child_process";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RANK } from "../core/changes.js";
import { inputShape, type Role, type Snapshot } from "../core/graph.js";
import { fingerprint, nameSource, setName, type Identity } from "../core/identity.js";
import { packageInfo } from "../core/package-root.js";
import { autoShare, defaultDataDir } from "../core/paths.js";
import type { LocalHost } from "../host/client.js";
import { placeReplica, readGroup } from "../host/host.js";
import { joinWithCode } from "../p2p/join.js";
import { parseCode } from "../p2p/link.js";
import type { GraphDescription } from "../p2p/protocol.js";
import type { SignalFactory } from "../p2p/signal.js";
import { registerViews, uiMeta } from "./apps.js";
import { FOLDER_FILE, findFolderFile, localContexts, readFolderFile, resolveFolder, writeFolderFile } from "./folder.js";

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

/** One line about a newcomer, for every agent in the graph. */
function joinNotice(p: Record<string, any>, where: string): string {
  const via = p.invite?.label ? ` with the invite '${p.invite.label}'` : p.invite?.id ? ` with invite ${p.invite.id}` : "";
  const agent = p.agent ? `${p.agent}${p.agent_version ? ` ${p.agent_version}` : ""}` : "an unknown agent";
  const extra = [p.platform ? `on ${p.platform}` : "", p.p2pcg ? `p2pcg ${p.p2pcg}` : ""].filter(Boolean).join(", ");
  const by = p.added_by ? `, let in by ${p.added_by}` : "";
  return `News: ${p.name} joined ${where} as ${p.role}${via}${by}, at ${p.joined_at}. Key fingerprint ${p.fingerprint}; ${agent}${extra ? ` (${extra})` : ""}.`;
}

/** Opens a URL in the default browser; false where that isn't possible or is turned off. */
function openInBrowser(url: string): boolean {
  if (process.env.P2PCG_NO_OPEN) return false;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
    return true;
  } catch {
    return false;
  }
}

export interface SessionOptions {
  /** Connects to (and if needed starts) this machine's host for the session's first context. */
  local: () => Promise<LocalHost>;
  /** Connects to (and if needed starts) this machine's host for a context by name. */
  openLocal?: (graph: string) => Promise<LocalHost>;
  identity: () => Identity;
  signal: SignalFactory;
  ice: string[];
  /** How long join_context waits for the person who made the code to answer. */
  joinWaitMs?: number;
  /** Where contexts live. */
  dataDir?: string;
  /** The folder the conversation started in: its `.p2p-context` (or a parent's) attaches contexts. Default: none read. */
  cwd?: string;
  /** Starts (once) the localhost page that shows the views, and returns its link: browser_view. */
  browserView?: () => Promise<string>;
  log?(msg: string): void;
}

const contextArg = z.string().regex(GRAPH_RE).optional();

export class Session {
  readonly server: McpServer;
  /** The attached contexts, in the order attached. */
  private contexts = new Map<string, Attached>();
  /** Where writes go unless a call names another context. */
  private writeTo?: string;
  private modelTools = new Map<string, RegisteredTool>();
  /** Notices not yet shown to the agent: they ride on its next tool result. */
  private news: string[] = [];
  /** What the folder's `.p2p-context` asked for, if there was one. */
  private folder?: { file: string; missing: { name: string; id?: string }[] };

  constructor(private o: SessionOptions) {
    this.server = new McpServer(
      { name: "p2p-context-graph", version: packageInfo().version },
      {
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
        instructions:
          "This server holds context graphs (contexts): what a group knows, as claims and questions, shared peer to peer. Every member keeps a full copy, so it works offline. " +
          "A conversation can have several contexts attached: reads search all of them; each write goes to one, so pick it by the contexts' descriptions (context_info lists them). " +
          "Call model_guide once before you first write, and follow it. " +
          "To invite someone, use share_context: it makes a join code for one person. To join someone else's context, call join_context with the p2pcg1_ code they sent. " +
          "attach_context, detach_context and use_context change which contexts this conversation uses.",
      },
    );
    registerViews(this.server);
    // A slash command for agents that have this server but not the plugin.
    this.server.registerPrompt(
      "join",
      {
        title: "Join a shared context",
        description: "Join someone's shared context with the join code (p2pcg1_…) they sent you",
        argsSchema: { code: z.string().describe("The p2pcg1_… join code") },
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

  /** Attaches the folder's contexts (`.p2p-context`), else the session's default context. */
  async start(): Promise<void> {
    const file = this.o.cwd ? findFolderFile(this.o.cwd) : undefined;
    if (file && this.o.openLocal) {
      try {
        const r = resolveFolder(readFolderFile(file), this.dataDir);
        this.folder = { file, missing: r.missing };
        for (const f of r.found) await this.attach(f.local, false);
        if (r.write_to) this.writeTo = r.write_to;
        for (const m of r.missing)
          this.news.push(
            `News: this folder's ${FOLDER_FILE} asks for the context '${m.name}'${m.id ? ` (id ${m.id})` : ""}, which isn't on this machine. Ask one of its members for a join code (join_context).`,
          );
      } catch (e) {
        this.news.push(`News: couldn't read ${file}: ${(e as Error).message}`);
      }
    }
    if (!this.contexts.size) {
      const host = await this.o.local();
      const d = await host.request<Description>("describe");
      this.add(d.graph, host, d);
    }
    this.offer();
  }

  // ---- Attached contexts -------------------------------------------------

  private add(name: string, host: LocalHost, d: Description) {
    this.contexts.set(name, { name, host, d });
    this.writeTo ??= name;
    host.on("close", () => this.o.log?.(`local host connection for '${name}' closed`));
    host.on("event", (e: { event: string; data: any }) => {
      if (this.contexts.get(name)?.host !== host) return;
      const where = this.where(name);
      if (e.event === "joined") this.news.push(joinNotice(e.data, where));
      if (e.event === "digest" && Array.isArray(e.data?.lines)) for (const l of e.data.lines) this.news.push(`News (${name}): ${l}`);
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

  private async connect(name: string): Promise<LocalHost> {
    if (!this.o.openLocal) throw new Error("This session can't open other contexts.");
    return this.o.openLocal(name);
  }

  /** Attaches a context on this machine (starting it if new), and re-offers the tools. */
  private async attach(name: string, offer = true): Promise<Attached> {
    const existing = this.contexts.get(name);
    if (existing && !existing.host.closed) return existing;
    const host = await this.connect(name);
    const d = await host.request<Description>("describe");
    this.add(name, host, d);
    if (offer) this.offer();
    return this.contexts.get(name)!;
  }

  private detach(name: string) {
    const c = this.contexts.get(name);
    if (!c) throw new Error(`'${name}' isn't attached to this conversation.`);
    if (this.contexts.size === 1) throw new Error("It's the only context attached; attach another first, or use use_context to switch.");
    c.host.close();
    this.contexts.delete(name);
    if (this.writeTo === name) this.writeTo = [...this.contexts.keys()][0];
    this.offer();
  }

  /** The context a call acts on: the one it names (attached on the way if it's on this machine), else the write context. */
  private async target(name?: string): Promise<Attached> {
    if (name) {
      const c = this.contexts.get(name);
      if (c && !c.host.closed) return c;
      if (c) return this.attach(name, false);
      if (!localContexts(this.dataDir).some((x) => x.name === name)) throw new Error(`There's no context '${name}' on this machine. context_info lists them (your_contexts).`);
      return this.attach(name);
    }
    const w = this.writeTo && this.contexts.get(this.writeTo);
    if (w && !w.host.closed) return w;
    if (w) return this.attach(w.name, false);
    const first = [...this.contexts.values()][0];
    if (!first) throw new Error("No context is attached.");
    return first;
  }

  private async request<T>(method: string, params?: unknown, name?: string): Promise<T> {
    const c = await this.target(name);
    try {
      return await c.host.request<T>(method, params);
    } catch (e) {
      if (!c.host.closed) throw e;
      // The host restarted: reconnect once.
      const again = await this.attach(c.name, false);
      return again.host.request<T>(method, params);
    }
  }

  private where(name?: string): string {
    const c = name ? this.contexts.get(name) : this.contexts.get(this.writeTo ?? "");
    if (!c) return name ? `'${name}'` : "no context";
    const d = c.d;
    if (d.creator) return `your context '${c.name}'`;
    return `'${c.name}' (${d.host}'s context${d.member === false ? "; you were removed" : `; you are a ${d.you.role}`})`;
  }

  private roleIn(c: Attached): Role {
    return c.d.member === false ? "reader" : c.d.you.role;
  }

  /** A line per attached context, for tool descriptions: name, what it's for, and the write context. */
  private contextsLine(): string {
    if (this.contexts.size <= 1) return "";
    const parts = [...this.contexts.values()].map(
      (c) => `'${c.name}'${c.name === this.writeTo ? " (writes go here by default)" : ""}: ${c.d.description ?? "no description yet"}`,
    );
    return ` Attached contexts: ${parts.join("; ")}.`;
  }

  /** Registers the model's tools for the attached contexts, as far as this machine's roles allow. */
  private offer(): void {
    for (const t of this.modelTools.values()) t.remove();
    this.modelTools.clear();
    const all = [...this.contexts.values()];
    const first = all[0];
    if (!first) return;
    const many = all.length > 1;
    for (const tool of first.d.tools) {
      const allowed = all.filter((c) => RANK[this.roleIn(c)] >= RANK[tool.role] && !(tool.kind === "write" && c.d.member === false));
      if (!allowed.length) continue;
      const routing =
        tool.kind === "write"
          ? many
            ? ` Goes to the context named in \`context\`, else '${this.writeTo}'. Pick the context whose description fits.${this.contextsLine()}`
            : ""
          : many
            ? ` Without \`context\`, it runs on every attached context and each result says which one it came from.${this.contextsLine()}`
            : "";
      const registered = this.server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description + routing,
          inputSchema: { ...inputShape(tool.input), context: contextArg.describe(tool.kind === "write" ? "The context to write to (default: the write context)" : "Only this context (default: all attached)") },
          annotations: { readOnlyHint: tool.kind === "read", destructiveHint: false, idempotentHint: tool.kind === "read", openWorldHint: false },
          ...(tool.view ? { _meta: uiMeta(tool.view) } : {}),
        },
        async (raw: Record<string, unknown>) => {
          const { context, ...args } = raw as Record<string, unknown> & { context?: string };
          try {
            if (tool.kind === "read" && !context && this.contexts.size > 1) return this.withNews(await this.readAll(tool.name, args));
            const c = await this.target(context);
            let result = await this.request<Record<string, unknown>>("call", { tool: tool.name, args }, c.name);
            // With several contexts attached, every row says which one it's from.
            if (Array.isArray(result) && this.contexts.size > 1) result = result.map((row) => ({ context: c.name, ...row })) as unknown as Record<string, unknown>;
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

  /** A read across every attached context: lists are merged, each row saying its context; one item is looked for in each. */
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
    // One item (history): the context that has it.
    const hit = ok[0]!;
    const out = text(hit.value);
    out.content.push({ type: "text", text: `(from ${this.where(hit.name)})` });
    return out;
  }

  /** Puts any notices in front of a tool result, once. */
  private withNews(out: Content): Content {
    if (!this.news.length) return out;
    const lines = this.news.splice(0);
    out.content.unshift({ type: "text", text: `${lines.join("\n")}\nTell the person this, briefly.` });
    return out;
  }

  private localNames(): string[] {
    return localContexts(this.dataDir).map((c) => c.name);
  }

  /** What context_info says about each attached context. */
  private async attachedInfo() {
    const out = [];
    for (const c of this.contexts.values()) {
      let holds: unknown = null;
      try {
        holds = ((await this.request<Record<string, unknown>>("info", undefined, c.name)) as { nodes?: unknown }).nodes ?? null;
      } catch {
        // its host is restarting
      }
      out.push({
        context: c.name,
        id: c.d.graph_id ?? null,
        where: this.where(c.name),
        description: c.d.description ?? null,
        role: c.d.member === false ? null : c.d.you.role,
        writes_here: c.name === this.writeTo,
        holds,
      });
    }
    return out;
  }

  private registerSessionTools(): void {
    const ro = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
    const wrap = (fn: (args: any) => Promise<unknown>) => async (args: any) => {
      try {
        return this.withNews(text(await fn(args)));
      } catch (e) {
        return this.withNews(failure((e as Error).message));
      }
    };
    const which = contextArg.describe("Which context (default: the write context)");

    this.server.registerTool(
      "context_info",
      {
        title: "Context info",
        description:
          "The contexts attached to this conversation (what each is for, your role, how much each holds, which one writes go to), the contexts on this machine (your_contexts), and this folder's .p2p-context if it has one. " +
          "With `context`, the details of one: everyone in it, who is online, and the sharing state.",
        inputSchema: { context: contextArg.describe("One context's details") },
        annotations: ro,
      },
      wrap(async ({ context }: { context?: string }) => {
        if (context) return { context, where: this.where(context), ...(await this.request<Record<string, unknown>>("info", undefined, context)) };
        return {
          using: this.where(),
          attached: await this.attachedInfo(),
          write_to: this.writeTo,
          your_contexts: this.localNames(),
          folder: this.folder ? { file: this.folder.file, missing: this.folder.missing } : null,
          next:
            this.contexts.size > 1
              ? "Reads search every attached context; for each write, pick the context whose description fits (the `context` argument), or it goes to write_to."
              : "attach_context adds another context to this conversation.",
        };
      }),
    );

    this.server.registerTool(
      "context_activity",
      {
        title: "Context activity",
        description:
          "What happened lately in a context, newest first: who wrote what (yours and synced from others), what others' changes meant for you (the sync digest: your claims replaced, your questions answered, new conflicts, possible overlaps), joins and role changes, and who is online. " +
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
          const c = await this.target(a.context);
          const activity = await this.request<Record<string, unknown>>("activity", { limit: a.limit }, c.name);
          const out: Record<string, unknown> = {
            using: this.where(c.name),
            context: c.name,
            attached: [...this.contexts.values()].map((x) => ({ name: x.name, description: x.d.description ?? null, writes_here: x.name === this.writeTo })),
            your_contexts: this.localNames(),
            ...activity,
          };
          if (a.snapshot) out.snapshot = await this.request<Snapshot>("snapshot", { limit: 300 }, c.name);
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
        if (!first) return "No context is attached.";
        return first.d.guide + (this.contexts.size > 1 ? `\n\n## Several contexts\n\nThis conversation has ${this.contexts.size} contexts attached.${this.contextsLine()} Reads search all of them. Put each write in the context whose description fits (the \`context\` argument); if none clearly fits, ask the person.` : "");
      }),
    );

    this.server.registerTool(
      "describe_context",
      {
        title: "Describe a context",
        description:
          "Set what a context is for, in a sentence or two (you must be an admin): what goes in it and what doesn't. Every member's agent sees it and uses it to decide which context a claim belongs in. " +
          "Ask the person for it; don't invent it.",
        inputSchema: { description: z.string().min(1).max(500).describe("What the context is for"), context: which },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async (a: { description: string; context?: string }) => {
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
        if (process.env.P2PCG_USER) throw new Error(`Your name is set by P2PCG_USER ('${process.env.P2PCG_USER}') in this agent's configuration; change it there.`);
        const n = setName(this.dataDir, name);
        for (const c of this.contexts.values()) await this.request("rename", { name: n }, c.name);
        return { name: n, fingerprint: fingerprint(this.o.identity().publicKey), note: "The attached contexts have it now; your other contexts take it when their hosts next start." };
      }),
    );

    this.server.registerTool(
      "share_context",
      {
        title: "Invite someone",
        description:
          "Invite one person to a context (you must be an admin of it): makes a new join code (p2pcg1_…) for that person. " +
          "Your machine answers the code, so it must be online when they use it. The first person to use it is let straight in with the code's role and gets a full copy; anyone else using it is turned away. " +
          "Everyone in the context is told when someone joins, with their name, key fingerprint and agent. remove_peer takes anyone out. " +
          "An unused code expires (default 24 hours). Call it once per person. sharing_status lists invites; revoke_invite cancels one.",
        inputSchema: {
          label: z.string().max(60).optional().describe("Who it's for, e.g. 'for Sam': shown in sharing_status and in the join notice"),
          role: z.enum(["reader", "contributor", "admin"]).optional().describe("The role they get when they join (default contributor)"),
          expires_hours: z.number().positive().max(720).optional().describe("Hours until an unused code stops working (default 24)"),
          context: which,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      wrap(async ({ context, ...a }) => this.invited(await this.request<Record<string, any>>("share", a, context), context)),
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
          "Stop syncing a context with the other members, and stop answering your join codes for it, until you share again (share_context, or the console). " +
          "Your copy keeps working; what you write is sent when you're back. Sharing is on by default.",
        inputSchema: { context: which },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(({ context }) => this.request("unshare", undefined, context)),
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
          "Join someone else's context with the join code they sent (p2pcg1_…; it can be inside other text). Use it when the person pastes such a code. " +
          "The machine that made the code must be online. You are let in at once and get your own full copy, kept in step with the others; everyone is told you joined (your name, key fingerprint and agent). " +
          "It is attached to this conversation and writes go to it; the result includes a briefing (open questions, conflicts, latest). Later sessions don't need the code: attach_context or use_context with its name.",
        inputSchema: { code: z.string().describe("The p2pcg1_… join code, exactly as sent") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      wrap(async ({ code }: { code: string }) => this.join(code)),
    );

    this.server.registerTool(
      "use_context",
      {
        title: "Switch to one context",
        description:
          "Make this conversation use just one context on this machine (yours, or one you joined; context_info lists your_contexts), detaching the others. A name that isn't here yet starts a new context of your own: give it a description of what it's for.",
        inputSchema: {
          name: z.string().regex(GRAPH_RE).describe("Context name: lower-case letters, digits and dashes"),
          description: z.string().max(500).optional().describe("For a new context: what it's for (what goes in it), in a sentence or two"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async ({ name, description }: { name: string; description?: string }) => {
        const isNew = !this.localNames().includes(name);
        const c = await this.attach(name, false);
        for (const other of [...this.contexts.keys()]) if (other !== name) (this.contexts.get(other)!.host.close(), this.contexts.delete(other));
        this.writeTo = name;
        if (isNew && description) {
          await this.request("describe_context", { description }, name);
          c.d = await c.host.request<Description>("describe");
        }
        this.offer();
        if (isNew && autoShare())
          return {
            created: this.where(name),
            description: c.d.description ?? null,
            ...this.invited(await this.request<Record<string, any>>("share", {}, name), name),
            next:
              (c.d.description ? "" : "Ask the person what this context is for and set it with describe_context. ") +
              "Show the person this join code now, and say: send it privately to one person; whoever uses it first is let in at once and gets a full copy, and everyone is told who joined. " +
              "Call share_context for a code for each other person. Then call model_guide before writing.",
          };
        return { using: this.where(name), description: c.d.description ?? null, next: "Call model_guide before writing to it." };
      }),
    );

    this.server.registerTool(
      "attach_context",
      {
        title: "Attach a context",
        description:
          "Add another context on this machine to this conversation (context_info lists your_contexts). Reads then search it too; with write_here, writes go to it by default.",
        inputSchema: { name: z.string().regex(GRAPH_RE).describe("The context's name"), write_here: z.boolean().optional().describe("Make it where writes go by default") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async ({ name, write_here }: { name: string; write_here?: boolean }) => {
        if (!this.localNames().includes(name)) throw new Error(`There's no context '${name}' on this machine. To start one, use use_context; to join someone's, join_context with their code.`);
        await this.attach(name, false);
        if (write_here) this.writeTo = name;
        this.offer();
        return { attached: [...this.contexts.keys()], write_to: this.writeTo, next: "Reads now search all attached contexts. Call model_guide again: it lists them." };
      }),
    );

    this.server.registerTool(
      "detach_context",
      {
        title: "Detach a context",
        description: "Remove a context from this conversation (nothing is deleted; it stays on this machine and keeps syncing).",
        inputSchema: { name: z.string().regex(GRAPH_RE).describe("The context's name") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async ({ name }: { name: string }) => {
        this.detach(name);
        return { attached: [...this.contexts.keys()], write_to: this.writeTo };
      }),
    );

    this.server.registerTool(
      "save_folder_contexts",
      {
        title: "Use these contexts in this folder",
        description:
          `Write this conversation's attached contexts (and the write context) to a ${FOLDER_FILE} file in the folder the conversation started in, so every new conversation there starts with them. ` +
          "It holds context names and ids, no secrets, so it can be committed for the team. Ask the person first.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async () => {
        if (!this.o.cwd) throw new Error("This session doesn't know which folder it started in.");
        const list = [...this.contexts.values()].map((c) => ({ name: c.name, ...(c.d.graph_id ? { id: c.d.graph_id } : {}) }));
        const file = writeFolderFile(this.o.cwd, list, this.writeTo);
        this.folder = { file, missing: [] };
        return { wrote: file, contexts: list, write_to: this.writeTo, note: "New conversations in this folder start with these contexts. Teammates who aren't in one are told to ask for a join code." };
      }),
    );

    this.server.registerTool(
      "take_back",
      {
        title: "Take back a write",
        description:
          "Undo something you just wrote, while it is still only on this machine (for a few seconds after writing): it is removed and never reaches anyone. " +
          "Use it when something was recorded by mistake, such as personal details in the wrong chat. After that, use withdraw (which keeps it in the history).",
        inputSchema: { id: z.string().describe("The change id (change) or the item's id from the write's result"), context: contextArg.describe("The context it was written to (default: each attached, in turn)") },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      wrap(async ({ id, context }: { id: string; context?: string }) => {
        if (context) return this.request("take_back", { id }, context);
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
      attached: [...this.contexts.keys()],
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
    const which = contextArg.describe("Which context (default: the write context)");

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
  private invited(r: Record<string, any>, context?: string) {
    const identity = this.o.identity();
    return {
      context: context ?? this.writeTo,
      code: r.code,
      send: `Join my context graph: /p2p-context-graph:join ${r.code}`,
      invite: { id: r.id, label: r.label, role: r.role, expires_at: r.expires_at },
      shared_as: { name: identity.name, fingerprint: fingerprint(identity.publicKey) },
      next:
        "Give the person the 'send' line to pass on privately (not in a public channel). Agents without the plugin command can be told: join the context with this code. " +
        "This machine answers the code, so it must be online when they use it. Whoever uses it first is let in at once and gets a full copy, and everyone in the context is told who joined (name, key fingerprint, agent). " +
        "Each code is for one person: call share_context again for the next. remove_peer takes anyone out.",
    };
  }

  /** Joins a context with a code: gets its whole log from the machine that made the code, keeps a copy here, attaches it and briefs the agent. */
  private async join(codeText: string): Promise<unknown> {
    const link = parseCode(codeText);
    const identity = this.o.identity();
    const client = this.server.server.getClientVersion();
    const about = {
      agent: client?.name,
      agent_version: client?.version,
      p2pcg: packageInfo().version,
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
    this.offer();
    const brief = await this.request<Record<string, unknown>>("briefing", undefined, name).catch(() => null);
    return {
      joined: `${welcome.host || c.d.host}'s context '${welcome.graph.name}'`,
      here_as: name,
      description: c.d.description ?? null,
      role: c.d.you.role,
      as: c.d.you.id,
      your_fingerprint: fingerprint(identity.publicKey),
      attached: [...this.contexts.keys()],
      copy: `You have your own full copy (${welcome.changes.length} changes), kept in step with the other members whenever you're both online. It works offline too.`,
      briefing: brief,
      told: "Everyone in this context has been told you joined, with your name, key fingerprint and agent.",
      next: `Tell the person what it's for and give them the briefing in a few lines. Call model_guide before writing. In later sessions, attach_context or use_context '${name}' (no code needed).`,
    };
  }
}

