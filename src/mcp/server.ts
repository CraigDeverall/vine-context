// The MCP server each agent session runs. It never opens a graph itself: it
// is a client of a host. By default that is this machine's host for the
// graph, which it starts if needed. After join_graph, it is another person's
// host, reached peer to peer. The model's tools come from whichever host is
// active, filtered by the role that host gave you, and are re-registered
// (with tools/list_changed) when the host or the role changes.

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inputShape, type Role, type Snapshot } from "../core/graph.js";
import { listPacks, loadPack, resolvePack } from "../core/pack.js";
import { defaultDataDir, userPacksDir } from "../core/paths.js";
import { validatePack } from "../core/validate.js";
import { fingerprint, type Identity } from "../core/identity.js";
import { packageInfo } from "../core/package-root.js";
import type { LocalHost } from "../host/client.js";
import { parseLink } from "../p2p/link.js";
import type { GraphDescription } from "../p2p/protocol.js";
import { RemoteHost } from "../p2p/remote.js";
import type { SignalFactory } from "../p2p/signal.js";
import { registerViews, uiMeta } from "./apps.js";

const RANK: Record<Role, number> = { reader: 0, contributor: 1, admin: 2 };

type Content = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const text = (value: unknown): Content => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }],
});
const failure = (message: string): Content => ({ ...text(message), isError: true });

export interface SessionOptions {
  /** Connects to (and if needed starts) this machine's host for the graph. */
  local: () => Promise<LocalHost>;
  identity: () => Identity;
  signal: SignalFactory;
  ice: string[];
  /** How long join_graph waits for the host's approval before returning. */
  joinWaitMs?: number;
  /** Connects to (and if needed starts) this machine's host for another graph: use_graph. */
  openLocal?: (graph: string, model?: string) => Promise<LocalHost>;
  /** Where graphs and installed packs live. */
  dataDir?: string;
  /** Starts (once) the localhost page that shows the views, and returns its link: browser_view. */
  browserView?: () => Promise<string>;
  log?(msg: string): void;
}

export class Session {
  readonly server: McpServer;
  private localHost?: LocalHost;
  private remote?: RemoteHost;
  private active?: GraphDescription;
  private modelTools = new Map<string, RegisteredTool>();

  constructor(private o: SessionOptions) {
    this.server = new McpServer(
      { name: "p2p-context-graph", version: packageInfo().version },
      {
        capabilities: { tools: { listChanged: true }, resources: {} },
        instructions:
          "This server holds a context graph: what a group knows, shared peer to peer. " +
          "Call model_guide once before you first write to it, and follow it. " +
          "To share your graph, use share_graph. To join someone else's, call join_graph with the p2pcg:// link they sent.",
      },
    );
    registerViews(this.server);
    this.registerSessionTools();
    this.registerAppTools();
  }

  private get dataDir(): string {
    return this.o.dataDir ?? defaultDataDir();
  }

  /** Disconnects from any joined graph and from the local host. */
  close(): void {
    this.remote?.close();
    this.remote = undefined;
    this.localHost?.close();
    void this.server.close().catch(() => undefined);
  }

  /** Connects to the local host and offers its graph's tools. */
  async start(): Promise<void> {
    await this.useLocal();
  }

  private async local(): Promise<LocalHost> {
    if (this.localHost && !this.localHost.closed) return this.localHost;
    this.localHost = await this.o.local();
    this.localHost.on("close", () => {
      this.o.log?.("local host connection closed");
    });
    return this.localHost;
  }

  private backend(): { request<T>(m: string, p?: unknown): Promise<T> } {
    if (this.remote) {
      const r = this.remote;
      return {
        request: async <T>(m: string, p?: unknown) => {
          if (r.state !== "active")
            throw new Error(
              `Not connected to ${r.hostName ?? "the host"}'s graph: ${r.reason ?? r.state}. ` +
                "Call join_graph with the link again, or leave_graph to go back to your own graph.",
            );
          return r.request<T>(m, p);
        },
      };
    }
    return { request: async <T>(m: string, p?: unknown) => (await this.local()).request<T>(m, p) };
  }

  private async useLocal(): Promise<void> {
    const d = await (await this.local()).request<GraphDescription>("describe");
    this.offer(d);
  }

  private async useRemote(): Promise<GraphDescription> {
    const d = await this.remote!.request<GraphDescription>("describe");
    this.offer(d);
    return d;
  }

  /** Replaces the model's tools with this host's, as far as the role allows. */
  private offer(d: GraphDescription): void {
    this.active = d;
    for (const t of this.modelTools.values()) t.remove();
    this.modelTools.clear();
    for (const tool of d.tools) {
      if (RANK[d.you.role] < RANK[tool.role]) continue;
      // An undo that this role can't call isn't offered on the receipt.
      const undoTool = tool.undo && d.tools.find((t) => t.name === tool.undo!.tool);
      const undo = undoTool && RANK[d.you.role] >= RANK[undoTool.role] ? tool.undo : undefined;
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
            const result = await this.backend().request("call", { tool: tool.name, args });
            const out = text(result);
            if (tool.view)
              out.structuredContent = { view: tool.view, tool: tool.name, title: tool.title ?? tool.name, input: args, result, undo: undo ?? null, where: this.where() };
            return out;
          } catch (e) {
            return failure((e as Error).message);
          }
        },
      );
      this.modelTools.set(tool.name, registered);
    }
    if (this.server.isConnected()) this.server.sendToolListChanged();
  }

  private where(): string {
    if (!this.active) return "no graph";
    return this.remote ? `${this.active.host}'s graph '${this.active.graph}' (joined as ${this.active.you.role})` : `your graph '${this.active.graph}'`;
  }

  private registerSessionTools(): void {
    const ro = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
    const admin = async <T>(method: string, params?: unknown) => (await this.local()).request<T>(method, params);
    const wrap = (fn: (args: any) => Promise<unknown>) => async (args: any) => {
      try {
        return text(await fn(args));
      } catch (e) {
        return failure((e as Error).message);
      }
    };

    this.server.registerTool(
      "graph_info",
      {
        title: "Graph info",
        description: "Which graph this session is using (yours, or one you joined), its model, how many of each node it holds, and your role.",
        annotations: ro,
      },
      wrap(async () => {
        const r = this.remote;
        if (r && r.state !== "active") {
          const host = r.hostName ?? "the host";
          return {
            using: r.state === "pending" ? `joining ${host}'s graph: waiting for ${host} to approve you` : `not connected to ${host}'s graph`,
            state: r.state,
            reason: r.reason,
            next: r.state === "pending" ? "Wait for approval; the graph tools switch automatically." : "Call join_graph with the link again, or leave_graph.",
          };
        }
        return { using: this.where(), ...((await this.backend().request("info")) as object), you: this.active?.you };
      }),
    );

    this.server.registerTool(
      "model_guide",
      {
        title: "Model guide",
        description: "How to use the current graph's model: what to record, when, and how to query it. Read it before writing.",
        annotations: ro,
      },
      wrap(async () => this.active?.guide ?? "No graph is connected."),
    );

    this.server.registerTool(
      "share_graph",
      {
        title: "Share your graph",
        description:
          "Start sharing YOUR graph (on this machine) peer to peer, and get a p2pcg:// join link to send to the people you want to work with. " +
          "Anyone with the link can ask to join; you approve each person with approve_peer. Sharing lasts until stop_sharing or until this machine's host stops.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      wrap(async () => {
        const r = await admin<{ link: string; already: boolean }>("share");
        return {
          link: r.link,
          already_sharing: r.already,
          next: "Send the link privately (not in a public channel). When someone joins, approve them with approve_peer; sharing_status shows who is waiting.",
        };
      }),
    );

    this.server.registerTool(
      "stop_sharing",
      {
        title: "Stop sharing",
        description: "Stop sharing your graph: disconnect everyone and make the link stop working. Approved people can rejoin when you share again.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(() => admin("unshare")),
    );

    this.server.registerTool(
      "sharing_status",
      {
        title: "Sharing status",
        description: "Whether your graph is shared, its link, who is connected, who is waiting for approval (with key fingerprints), and who is approved.",
        annotations: ro,
      },
      wrap(() => admin("status")),
    );

    const roleSchema = z.enum(["reader", "contributor", "admin"]);
    this.server.registerTool(
      "approve_peer",
      {
        title: "Approve someone",
        description:
          "Let a person who is waiting join your graph, with a role: reader (search and read), contributor (also add and link), or admin (also withdraw anyone's items). " +
          "Check their key fingerprint with them first, by a channel you trust. Approved people rejoin later sessions without asking.",
        inputSchema: { name: z.string().describe("Their name, as sharing_status shows it"), role: roleSchema.default("contributor").describe("Their role") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      wrap((a) => admin("approve", a)),
    );

    this.server.registerTool(
      "set_peer_role",
      {
        title: "Change someone's role",
        description: "Change the role of a person you approved: reader, contributor or admin. Takes effect at once if they are connected.",
        inputSchema: { name: z.string().describe("Their name"), role: roleSchema.describe("Their new role") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap((a) => admin("set_role", a)),
    );

    this.server.registerTool(
      "remove_peer",
      {
        title: "Remove someone",
        description: "Disconnect a person and forget their approval, or refuse someone who is waiting. Their past contributions stay in the graph.",
        inputSchema: { name: z.string().describe("Their name") },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      wrap((a) => admin("remove", a)),
    );

    this.server.registerTool(
      "join_graph",
      {
        title: "Join a shared graph",
        description:
          "Join someone else's shared graph with the p2pcg://join/... link they sent. Use it when the person pastes such a link. " +
          "After the host approves you, this session's graph tools act on their graph until leave_graph.",
        inputSchema: { link: z.string().describe("The p2pcg://join/... link, exactly as sent") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      wrap(async ({ link }: { link: string }) => this.join(link)),
    );

    this.server.registerTool(
      "leave_graph",
      {
        title: "Leave the joined graph",
        description: "Disconnect from the graph you joined and go back to your own graph.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap(async () => {
        if (!this.remote) return "You are not in someone else's graph; you are using your own.";
        const host = this.remote.hostName;
        this.remote.close();
        this.remote = undefined;
        await this.useLocal();
        return `Left ${host ?? "the host"}'s graph. You are back on ${this.where()}.`;
      }),
    );
  }

  /** What the console shows: your sharing, or the graph you joined. */
  private async consoleState(): Promise<Record<string, unknown>> {
    const r = this.remote;
    if (r) {
      const identity = this.o.identity();
      return {
        mode: "peer",
        using: this.where(),
        host: r.hostName ?? null,
        graph: this.active?.graph ?? null,
        state: r.state,
        reason: r.reason ?? null,
        role: r.state === "active" ? (this.active?.you.role ?? null) : null,
        you: { name: identity.name, fingerprint: fingerprint(identity.publicKey) },
      };
    }
    return { mode: "host", using: this.where(), ...((await (await this.local()).request("status")) as object) };
  }

  private localGraphs(): string[] {
    const dir = join(this.dataDir, "graphs");
    return existsSync(dir) ? readdirSync(dir).filter((n) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(n)).sort() : [];
  }

  private studioState(): Record<string, unknown> {
    const d = this.active;
    return {
      using: this.where(),
      mode: this.remote ? "peer" : "host",
      can_manage: !this.remote,
      graph: d?.graph ?? null,
      model: d ? { ...d.model, schema: d.schema, tools: d.tools.map(({ name, title, kind, role, description }) => ({ name, title, kind, role, description })) } : null,
      guide: d?.guide ?? null,
      packs: this.remote
        ? []
        : listPacks(this.dataDir).map((p) => {
            try {
              const pack = loadPack(p.dir);
              return { name: p.name, source: p.source, title: pack.model.title, description: pack.model.description, version: pack.model.version, tools: pack.tools.length };
            } catch (e) {
              return { name: p.name, source: p.source, error: (e as Error).message };
            }
          }),
      graphs: this.remote ? [] : this.localGraphs(),
    };
  }

  private registerAppTools(): void {
    const ro = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
    const run = (fn: (args: any) => Promise<Content>) => async (args: any) => {
      try {
        return await fn(args);
      } catch (e) {
        return failure((e as Error).message);
      }
    };
    const both = (summary: unknown, structured: Record<string, unknown>): Content => ({ ...text(summary), structuredContent: structured });

    this.server.registerTool(
      "open_console",
      {
        title: "Open the sharing console",
        description:
          "Show the sharing console: your graph's join link, who is waiting with their key fingerprints, who is connected, and their roles; or, if you joined someone's graph, your connection to it. " +
          "The person can share, approve, change roles and remove people there themselves.",
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
        const snap = await this.backend().request<Snapshot>("snapshot", a);
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

    this.server.registerTool(
      "model_studio",
      {
        title: "Open the model studio",
        description:
          "Show the model studio: the current graph's model (its node types, relationships and tools), the model packs you can use, and your graphs. " +
          "The person can check a new pack, install it, and switch to a graph there.",
        annotations: ro,
        _meta: uiMeta("studio"),
      },
      run(async () => {
        const state = this.studioState();
        return both(
          { using: state.using, model: this.active?.model.name, packs: (state.packs as { name: string }[]).map((p) => p.name), graphs: state.graphs },
          state,
        );
      }),
    );

    if (this.o.browserView)
      this.server.registerTool(
        "browser_view",
        {
          title: "Open the views in a browser",
          description:
            "Get a link to the console, explorer and model studio in a browser tab on this machine, for when this agent can't show MCP App views itself. " +
            "Give the person the link to open; it works only on this machine and while this session runs. The browser page shows your own graph, not one you joined.",
          annotations: ro,
        },
        run(async () => text({ url: await this.o.browserView!(), note: "Open it in a browser on this machine. Don't share it: it acts as you." })),
      );

    this.server.registerTool(
      "validate_model",
      {
        title: "Check a model pack",
        description:
          "Check a model pack folder (model.yaml, tools.yaml, instructions.md): its files against the pack format, then a trial run of every tool on a scratch graph. " +
          "Use it after writing or changing a pack, and fix what it reports before install_model.",
        inputSchema: { path: z.string().min(1).describe("The pack folder, as an absolute path") },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      run(async ({ path }: { path: string }) => {
        const report = await validatePack(path);
        return both(report, report as unknown as Record<string, unknown>);
      }),
    );

    this.server.registerTool(
      "install_model",
      {
        title: "Install a model pack",
        description:
          "Install a checked model pack folder, so new graphs can use it by name (use_graph with model). It checks the pack first and refuses one that fails. " +
          "Installing a newer version of an installed pack replaces it; graphs that use it get its new migrations when they next open.",
        inputSchema: { path: z.string().min(1).describe("The pack folder, as an absolute path") },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      run(async ({ path }: { path: string }) => {
        const report = await validatePack(path);
        if (!report.ok) return { ...text({ installed: false, report }), isError: true };
        const pack = loadPack(path);
        const name = pack.model.name;
        if (listPacks(this.dataDir).some((p) => p.name === name && p.source === "built-in"))
          throw new Error(`'${name}' is a built-in pack's name. Rename the pack (model.yaml name) to install it.`);
        const dest = join(userPacksDir(this.dataDir), name);
        let previous: number | undefined;
        if (existsSync(join(dest, "model.yaml"))) {
          try {
            previous = loadPack(dest).model.version;
          } catch {
            previous = undefined;
          }
          rmSync(dest, { recursive: true, force: true });
        }
        // Copy only the pack's own files.
        mkdirSync(join(dest, "migrations"), { recursive: true });
        for (const f of ["model.yaml", "tools.yaml", "instructions.md"])
          if (existsSync(join(pack.dir, f))) copyFileSync(join(pack.dir, f), join(dest, f));
        for (const m of pack.migrations) copyFileSync(join(pack.dir, "migrations", m.name), join(dest, "migrations", m.name));
        return text({
          installed: name,
          version: pack.model.version,
          replaced_version: previous ?? null,
          next: `Start a graph with it: use_graph with name and model '${name}'.`,
        });
      }),
    );

    this.server.registerTool(
      "use_graph",
      {
        title: "Switch to another of your graphs",
        description:
          "Switch this session to another graph on this machine, creating it if it doesn't exist. A new graph uses `model` (a pack name; default temporal-claims); an existing graph keeps the model it was made with. " +
          "Leave a joined graph first.",
        inputSchema: {
          name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).describe("Graph name: lower-case letters, digits and dashes"),
          model: z.string().optional().describe("Model pack for a new graph"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      run(async ({ name, model }: { name: string; model?: string }) => {
        if (this.remote) throw new Error("You are in someone else's graph. Call leave_graph first.");
        if (!this.o.openLocal) throw new Error("This session can't switch graphs.");
        if (model) resolvePack(model, this.dataDir); // fails early with the list of packs
        const host = await this.o.openLocal(name, model);
        const d = await host.request<{ model: { name: string } }>("describe");
        if (model && d.model.name !== resolvePack(model, this.dataDir).model.name) {
          host.close();
          throw new Error(`Graph '${name}' already exists with the model '${d.model.name}'. Pick another name for a '${model}' graph.`);
        }
        const old = this.localHost;
        this.localHost = host;
        this.o.local = () => this.o.openLocal!(name);
        old?.close();
        await this.useLocal();
        return text({ using: this.where(), model: this.active?.model.title, next: "Call model_guide before writing to it." });
      }),
    );
  }

  private async join(linkText: string): Promise<unknown> {
    const link = parseLink(linkText);
    if (this.remote) this.remote.close();
    const identity = this.o.identity();
    const remote = new RemoteHost(link, identity, { signal: this.o.signal, ice: this.o.ice, log: this.o.log });
    this.remote = remote;

    // Approval that arrives after join_graph returned (it was still waiting).
    let returned = false;
    remote.on("state", (s) => {
      if (this.remote !== remote || !returned) return;
      if (s === "active") void this.useRemote().catch((e) => this.o.log?.(`describe failed: ${e.message}`));
    });
    remote.on("event", (e: { event: string }) => {
      if (this.remote === remote && e.event === "role") void this.useRemote().catch(() => undefined);
    });

    const outcome = await Promise.race([
      remote.admitted,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), this.o.joinWaitMs ?? 25_000).unref()),
    ]);
    returned = true;
    const fp = fingerprint(identity.publicKey);
    if (outcome === "active") {
      const d = await this.useRemote();
      return {
        joined: `${d.host}'s graph '${d.graph}'`,
        model: d.model.title,
        role: d.you.role,
        as: d.you.id,
        next: "Call model_guide before writing. Your graph tools now act on this graph until leave_graph.",
      };
    }
    if (outcome === "pending" || (outcome === "timeout" && remote.state === "pending")) {
      return {
        waiting: `Connected to ${remote.hostName ?? "the host"}; waiting for them to approve you.`,
        your_name: identity.name,
        your_fingerprint: fp,
        next: `Tell ${remote.hostName ?? "the host"} your name and fingerprint so they can check it is you. The graph tools switch to their graph as soon as they approve; call graph_info to check.`,
      };
    }
    if (outcome === "timeout") {
      return {
        waiting: "Still connecting to the host (it can take a while across some networks).",
        next: "Call graph_info in a moment to check. If it doesn't connect, the host may need to share again, or a TURN server may be needed (P2PCG_ICE).",
      };
    }
    this.remote = undefined;
    throw new Error(remote.reason ?? "Could not join.");
  }
}
