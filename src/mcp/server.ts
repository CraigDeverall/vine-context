// The MCP server each agent session runs. It never opens a graph itself: it
// is a client of a host. By default that is this machine's host for the
// graph, which it starts if needed. After join_graph, it is another person's
// host, reached peer to peer. The model's tools come from whichever host is
// active, filtered by the role that host gave you, and are re-registered
// (with tools/list_changed) when the host or the role changes.

import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inputShape, type Role } from "../core/graph.js";
import { fingerprint, type Identity } from "../core/identity.js";
import { packageInfo } from "../core/package-root.js";
import type { LocalHost } from "../host/client.js";
import { parseLink } from "../p2p/link.js";
import type { GraphDescription } from "../p2p/protocol.js";
import { RemoteHost } from "../p2p/remote.js";
import type { SignalFactory } from "../p2p/signal.js";

const RANK: Record<Role, number> = { reader: 0, contributor: 1, admin: 2 };

type Content = { content: { type: "text"; text: string }[]; isError?: boolean };
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
        capabilities: { tools: { listChanged: true } },
        instructions:
          "This server holds a context graph: what a group knows, shared peer to peer. " +
          "Call model_guide once before you first write to it, and follow it. " +
          "To share your graph, use share_graph. To join someone else's, call join_graph with the p2pcg:// link they sent.",
      },
    );
    this.registerSessionTools();
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
      const registered = this.server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: inputShape(tool.input),
          annotations: { readOnlyHint: tool.kind === "read", destructiveHint: false, idempotentHint: tool.kind === "read", openWorldHint: false },
        },
        async (args: unknown) => {
          try {
            return text(await this.backend().request("call", { tool: tool.name, args }));
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
