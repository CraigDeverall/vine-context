// The MCP server each agent session runs. It never opens a graph itself: it
// is a client of this machine's host for the graph (started if needed).
// Every graph this machine is in, its own or one it joined, is a full local
// copy kept in step with the other members by its host, so the session always
// works on this machine: reads and writes work offline too.
//
// The model's tools come from the host, filtered by this machine's role in
// the graph, and are re-registered (with tools/list_changed) on a switch or a
// role change.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RANK } from "../core/changes.js";
import { inputShape, type Snapshot } from "../core/graph.js";
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

type Content = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const text = (value: unknown): Content => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }],
});
const failure = (message: string): Content => ({ ...text(message), isError: true });

const OS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };
const GRAPH_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

type Description = GraphDescription & { graph_id?: string; creator?: boolean; member?: boolean };

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
  /** Connects to (and if needed starts) this machine's host for the session's graph. */
  local: () => Promise<LocalHost>;
  /** Connects to (and if needed starts) this machine's host for another graph. */
  openLocal?: (graph: string) => Promise<LocalHost>;
  identity: () => Identity;
  signal: SignalFactory;
  ice: string[];
  /** How long join_graph waits for the person who made the code to answer. */
  joinWaitMs?: number;
  /** Where graphs live. */
  dataDir?: string;
  /** Starts (once) the localhost page that shows the views, and returns its link: browser_view. */
  browserView?: () => Promise<string>;
  log?(msg: string): void;
}

export class Session {
  readonly server: McpServer;
  private localHost?: LocalHost;
  private active?: Description;
  private modelTools = new Map<string, RegisteredTool>();
  /** Notices not yet shown to the agent: they ride on its next tool result. */
  private news: string[] = [];

  constructor(private o: SessionOptions) {
    this.server = new McpServer(
      { name: "p2p-context-graph", version: packageInfo().version },
      {
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
        instructions:
          "This server holds context graphs: what a group knows, as claims and questions, shared peer to peer. Every member keeps a full copy, so it works offline. " +
          "Call model_guide once before you first write to a graph, and follow it. " +
          "To invite someone, use share_graph: it makes a join code for one person. To join someone else's graph, call join_graph with the p2pcg1_ code they sent. " +
          "To switch to another graph on this machine (yours or one you joined), use use_graph.",
      },
    );
    registerViews(this.server);
    // A slash command for agents that have this server but not the plugin.
    this.server.registerPrompt(
      "join",
      {
        title: "Join a shared context graph",
        description: "Join someone's shared context graph with the join code (p2pcg1_…) they sent you",
        argsSchema: { code: z.string().describe("The p2pcg1_… join code") },
      },
      ({ code }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Join the shared context graph with this join code: ${code}\n\n` +
                "Call join_graph with the code exactly as given. When I'm in, tell me whose graph it is, my role, that I now have my own full copy, and that everyone in it has been told I joined (with my name and key fingerprint). " +
                "Then call model_guide before writing. If the person who made the code isn't online, tell me to try again later. If the code was already used on another machine, expired or was cancelled, tell me to ask for a new one (and, if it was already used and not by me, to warn them it may have leaked).",
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
    this.localHost?.close();
    void this.server.close().catch(() => undefined);
  }

  async start(): Promise<void> {
    await this.useLocal();
  }

  private watch(h: LocalHost): LocalHost {
    h.on("close", () => this.o.log?.("local host connection closed"));
    h.on("event", (e: { event: string; data: any }) => {
      if (this.localHost !== h) return;
      if (e.event === "joined") this.news.push(joinNotice(e.data, this.where()));
      if (e.event === "removed") {
        this.news.push(`News: ${e.data?.by ?? "An admin"} removed you from ${this.where()}. You keep your copy to read, but can't write to it any more.`);
        void this.useLocal().catch(() => undefined);
      }
      if (e.event === "role") {
        this.news.push(`News: your role in ${this.where()} is now ${e.data?.role}.`);
        void this.useLocal().catch(() => undefined);
      }
    });
    return h;
  }

  private async local(): Promise<LocalHost> {
    if (this.localHost && !this.localHost.closed) return this.localHost;
    this.localHost = this.watch(await this.o.local());
    return this.localHost;
  }

  private async request<T>(method: string, params?: unknown): Promise<T> {
    return (await this.local()).request<T>(method, params);
  }

  private async useLocal(): Promise<Description> {
    const d = await this.request<Description>("describe");
    this.offer(d);
    return d;
  }

  /** Replaces the model's tools with this graph's, as far as this machine's role allows. */
  private offer(d: Description): void {
    this.active = d;
    for (const t of this.modelTools.values()) t.remove();
    this.modelTools.clear();
    const role = d.member === false ? "reader" : d.you.role;
    for (const tool of d.tools) {
      if (RANK[role] < RANK[tool.role]) continue;
      if (tool.kind === "write" && d.member === false) continue;
      const canWithdraw = d.tools.some((t) => t.name === "withdraw") && RANK[role] >= RANK.contributor;
      const registered = this.server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: inputShape(tool.input),
          annotations: { readOnlyHint: tool.kind === "read", destructiveHint: false, idempotentHint: tool.kind === "read", openWorldHint: false },
          ...(tool.view ? { _meta: uiMeta(tool.view) } : {}),
        },
        async (args: Record<string, unknown>) => {
          try {
            const result = await this.request<Record<string, unknown>>("call", { tool: tool.name, args });
            const out = text(result);
            const held =
              tool.kind === "write" && result && typeof result === "object" && result.shared_at
                ? ` It stays on this machine until ${result.shared_at}; until then take_back removes it without trace.`
                : "";
            out.content.push({ type: "text", text: `(on ${this.where()})${held}` });
            if (tool.view)
              out.structuredContent = {
                view: tool.view,
                tool: tool.name,
                title: tool.title ?? tool.name,
                input: args,
                result,
                undo: tool.kind === "write" ? { take_back: true, withdraw: canWithdraw } : null,
                where: this.where(),
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

  /** Puts any notices in front of a tool result, once. */
  private withNews(out: Content): Content {
    if (!this.news.length) return out;
    const lines = this.news.splice(0);
    out.content.unshift({ type: "text", text: `${lines.join("\n")}\nTell the person this, in one line.` });
    return out;
  }

  private where(): string {
    const d = this.active;
    if (!d) return "no graph";
    if (d.creator) return `your graph '${d.graph}'`;
    return `'${d.graph}' (${d.host}'s graph${d.member === false ? "; you were removed" : `; you are a ${d.you.role}`})`;
  }

  private localGraphs(): string[] {
    const dir = join(this.dataDir, "graphs");
    return existsSync(dir) ? readdirSync(dir).filter((n) => GRAPH_RE.test(n)).sort() : [];
  }

  private async switchTo(name: string): Promise<Description> {
    if (!this.o.openLocal) throw new Error("This session can't switch graphs.");
    const host = await this.o.openLocal(name);
    const old = this.localHost;
    this.localHost = this.watch(host);
    this.o.local = () => this.o.openLocal!(name);
    if (old && old !== host) old.close();
    return this.useLocal();
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

    this.server.registerTool(
      "graph_info",
      {
        title: "Graph info",
        description:
          "Which graph this session is using, how many claims and questions it holds, your role, everyone in it (and who is online), and the graphs on this machine (your_graphs: switch with use_graph).",
        annotations: ro,
      },
      wrap(async () => ({ using: this.where(), ...(await this.request<Record<string, unknown>>("info")), your_graphs: this.localGraphs() })),
    );

    this.server.registerTool(
      "graph_activity",
      {
        title: "Graph activity",
        description:
          "What happened lately in the current graph, newest first: who wrote what (yours and synced from others), joins and role changes, plus who is online. " +
          "With snapshot, also the graph's items and links. Read-only; it never uses up the join notices meant for you (it's what the Claude Code mod's band and panel poll).",
        inputSchema: {
          limit: z.number().int().min(1).max(200).optional().describe("How many recent changes (default 30)"),
          snapshot: z.boolean().optional().describe("Also return the graph as it stands now (items and links)"),
        },
        annotations: ro,
      },
      async (a: { limit?: number; snapshot?: boolean }) => {
        try {
          const activity = await this.request<Record<string, unknown>>("activity", { limit: a.limit });
          const out: Record<string, unknown> = { using: this.where(), your_graphs: this.localGraphs(), ...activity };
          if (a.snapshot) out.snapshot = await this.request<Snapshot>("snapshot", { limit: 300 });
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
        description: "How to use the graph: what to record, when, and how to query it. Read it before writing.",
        annotations: ro,
      },
      wrap(async () => this.active?.guide ?? "No graph is connected."),
    );

    this.server.registerTool(
      "set_my_name",
      {
        title: "Set your name",
        description:
          "Set the name other people see for you in every graph on this machine (for example 'Craig Deverall'). Ask the person what they want to be called; don't invent it. " +
          "You are your machine's key; the name is a label you can change. What you recorded before shows the new name too.",
        inputSchema: { name: z.string().min(1).max(40).describe("1–40 letters, digits, spaces, dots, dashes or underscores") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async ({ name }: { name: string }) => {
        if (process.env.P2PCG_USER) throw new Error(`Your name is set by P2PCG_USER ('${process.env.P2PCG_USER}') in this agent's configuration; change it there.`);
        const n = setName(this.dataDir, name);
        await this.request("rename", { name: n });
        return { name: n, fingerprint: fingerprint(this.o.identity().publicKey), note: "Each of your graphs takes the new name when its host next starts; this one has it now." };
      }),
    );

    this.server.registerTool(
      "share_graph",
      {
        title: "Invite someone",
        description:
          "Invite one person to the current graph (you must be an admin of it): makes a new join code (p2pcg1_…) for that person. " +
          "Your machine answers the code, so it must be online when they use it. The first person to use it is let straight in with the code's role and gets a full copy of the graph; anyone else using it is turned away. " +
          "Everyone in the graph is told when someone joins, with their name, key fingerprint and agent. remove_peer takes anyone out. " +
          "An unused code expires (default 24 hours). Call it once per person. sharing_status lists invites; revoke_invite cancels one.",
        inputSchema: {
          label: z.string().max(60).optional().describe("Who it's for, e.g. 'for Sam': shown in sharing_status and in the join notice"),
          role: z.enum(["reader", "contributor", "admin"]).optional().describe("The role they get when they join (default contributor)"),
          expires_hours: z.number().positive().max(720).optional().describe("Hours until an unused code stops working (default 24)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      wrap(async (a) => this.invited(await this.request<Record<string, any>>("share", a))),
    );

    this.server.registerTool(
      "revoke_invite",
      {
        title: "Cancel an invite",
        description: "Cancel a join code you made: it stops working. Use the invite id from sharing_status. To take someone out of the graph, use remove_peer.",
        inputSchema: { id: z.string().describe("The invite id (inv_…), as sharing_status shows it") },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      wrap((a) => this.request("revoke_invite", a)),
    );

    this.server.registerTool(
      "stop_sharing",
      {
        title: "Go offline",
        description:
          "Stop syncing this graph with the other members, and stop answering your join codes, until you share again (share_graph, or open the console). " +
          "Your copy keeps working; what you write is sent when you're back. Sharing is on by default.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(() => this.request("unshare")),
    );

    this.server.registerTool(
      "sharing_status",
      {
        title: "Sharing status",
        description:
          "Whether this graph is syncing, its invites (who each is for, open, used or expired), everyone in it (name, key fingerprint, role, agent, operating system, online), the links to other members, and the signalling relays' state.",
        annotations: ro,
      },
      wrap(() => this.request("status")),
    );

    const roleSchema = z.enum(["reader", "contributor", "admin"]);
    this.server.registerTool(
      "set_peer_role",
      {
        title: "Change someone's role",
        description: "Change a member's role (you must be an admin): reader, contributor or admin. Every member's machine applies it.",
        inputSchema: { name: z.string().describe("Their name"), role: roleSchema.describe("Their new role") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap((a) => this.request("set_role", a)),
    );

    this.server.registerTool(
      "remove_peer",
      {
        title: "Remove someone",
        description:
          "Take a member out of the graph (you must be an admin). Every member's machine stops syncing with them and refuses their later changes. Their past contributions stay. " +
          "They keep the copy they already had: removal can't take back what they received.",
        inputSchema: { name: z.string().describe("Their name") },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      wrap((a) => this.request("remove", a)),
    );

    this.server.registerTool(
      "join_graph",
      {
        title: "Join a shared graph",
        description:
          "Join someone else's graph with the join code they sent (p2pcg1_…; it can be inside other text). Use it when the person pastes such a code. " +
          "The machine that made the code must be online. You are let in at once and get your own full copy of the graph, kept in step with the others; everyone is told you joined (your name, key fingerprint and agent). " +
          "This session then works on that graph. Later sessions don't need the code: use use_graph with its name.",
        inputSchema: { code: z.string().describe("The p2pcg1_… join code, exactly as sent") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      wrap(async ({ code }: { code: string }) => this.join(code)),
    );

    this.server.registerTool(
      "use_graph",
      {
        title: "Switch graphs",
        description:
          "Switch this session to another graph on this machine: one of yours, or one you joined (graph_info lists your_graphs). A name that isn't here yet starts a new graph of your own.",
        inputSchema: { name: z.string().regex(GRAPH_RE).describe("Graph name: lower-case letters, digits and dashes") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async ({ name }: { name: string }) => {
        const isNew = !this.localGraphs().includes(name);
        await this.switchTo(name);
        if (isNew && autoShare())
          return {
            created: this.where(),
            ...this.invited(await this.request<Record<string, any>>("share")),
            next:
              "Show the person this join code now, and say: send it privately to one person; whoever uses it first is let in at once and gets a full copy, and everyone is told who joined. " +
              "Call share_graph for a code for each other person. Then call model_guide before writing.",
          };
        return { using: this.where(), next: "Call model_guide before writing to it." };
      }),
    );

    this.server.registerTool(
      "take_back",
      {
        title: "Take back a write",
        description:
          "Undo something you just wrote, while it is still only on this machine (for a few seconds after writing): it is removed and never reaches anyone. " +
          "Use it when something was recorded by mistake, such as personal details in the wrong chat. After that, use withdraw (which keeps it in the history).",
        inputSchema: { id: z.string().describe("The change id (change) or the item's id from the write's result") },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      wrap((a) => this.request("take_back", a)),
    );
  }

  /** What the console shows. */
  private async consoleState(): Promise<Record<string, unknown>> {
    const status = await this.request<Record<string, any>>("status");
    return {
      using: this.where(),
      ...status,
      you: { ...status.you, name_from: nameSource(this.dataDir) },
      graphs: this.localGraphs(),
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

    this.server.registerTool(
      "open_console",
      {
        title: "Open the sharing console",
        description:
          "Show the sharing console: everyone in the graph (with key fingerprints, agents, roles and who is online), your join codes, and whether this graph is syncing. " +
          "An admin can make codes, change roles and remove people there.",
        annotations: ro,
        _meta: uiMeta("console"),
      },
      run(async () => {
        const state = await this.consoleState();
        return both(state, state);
      }),
    );

    this.server.registerTool(
      "explore_graph",
      {
        title: "Explore the graph",
        description:
          "Show the graph as an interactive picture: its items and the links between them, as it stood at a moment (default now). " +
          "For the person to look at; to answer a question yourself, use the model's search and read tools.",
        inputSchema: {
          at: z.iso.datetime({ offset: true }).optional().describe("Show the graph as it stood at this time (ISO 8601). Default now."),
          limit: z.number().int().min(1).max(1000).default(200).describe("Most recent items to show"),
        },
        annotations: ro,
        _meta: uiMeta("explorer"),
      },
      run(async (a: { at?: string; limit?: number }) => {
        const snap = await this.request<Snapshot>("snapshot", a);
        const counts: Record<string, number> = {};
        for (const n of snap.nodes) counts[n.label] = (counts[n.label] ?? 0) + 1;
        return both(
          {
            showing: this.where(),
            at: snap.at,
            nodes: counts,
            links: snap.edges.length,
            truncated: snap.truncated,
            note: "The explorer shows the picture to the person; this summary is all you get here.",
          },
          { ...snap, where: this.where() } as unknown as Record<string, unknown>,
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

  /** What share_graph says about a new invite. */
  private invited(r: Record<string, any>) {
    const identity = this.o.identity();
    return {
      code: r.code,
      send: `Join my context graph: /p2p-context-graph:join ${r.code}`,
      invite: { id: r.id, label: r.label, role: r.role, expires_at: r.expires_at },
      shared_as: { name: identity.name, fingerprint: fingerprint(identity.publicKey) },
      next:
        "Give the person the 'send' line to pass on privately (not in a public channel). Agents without the plugin command can be told: join the context graph with this code. " +
        "This machine answers the code, so it must be online when they use it. Whoever uses it first is let in at once and gets a full copy, and everyone in the graph is told who joined (name, key fingerprint, agent). " +
        "Each code is for one person: call share_graph again for the next. remove_peer takes anyone out.",
    };
  }

  /** Joins a graph with a code: gets its whole log from the machine that made the code, and keeps a copy here. */
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
    let name: string | undefined;
    for (let i = 1; i < 100 && !name; i++) {
      const candidate = i === 1 ? base : `${base}-${i}`.slice(0, 63);
      const group = readGroup(this.dataDir, candidate);
      if (group?.id === welcome.graph.id) name = candidate; // already here: its host syncs it
      else if (!group && !this.localGraphs().includes(candidate)) {
        if (placeReplica(this.dataDir, candidate, welcome.graph, welcome.changes)) name = candidate;
      }
    }
    if (!name) throw new Error("Couldn't find a free name for this graph on this machine.");
    const d = await this.switchTo(name);
    return {
      joined: `${welcome.host || d.host}'s graph '${welcome.graph.name}'`,
      here_as: name,
      role: d.you.role,
      as: d.you.id,
      your_fingerprint: fingerprint(identity.publicKey),
      copy: `You have your own full copy (${welcome.changes.length} changes), kept in step with the other members whenever you're both online. It works offline too.`,
      told: "Everyone in this graph has been told you joined, with your name, key fingerprint and agent.",
      next: `Call model_guide before writing. In later sessions, use_graph '${name}' (no code needed).`,
    };
  }
}
