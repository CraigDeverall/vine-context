// The MCP server: the model pack's tools, plus two built-in ones.
//
// In M1 the server owns the graph directly (single player). In M2 the same
// server either hosts the graph or forwards calls to a host over P2P; the tool
// list and instructions come from the model either way.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Graph, ToolError, inputShape, type Caller } from "../core/graph.js";
import { packageInfo } from "../core/package-root.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }],
});
const failure = (message: string) => ({ ...text(message), isError: true });

export function createMcpServer(graph: Graph, caller: Caller): McpServer {
  const { model } = graph;
  const server = new McpServer(
    { name: "p2p-context-graph", version: packageInfo().version },
    {
      instructions:
        `This server holds a shared context graph, '${graph.name}', using the model '${model.name}' (${model.title}): ` +
        `${model.description} Call model_guide once before you first write to it, and follow it.`,
    },
  );

  for (const tool of graph.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: inputShape(tool),
        annotations: {
          readOnlyHint: tool.kind === "read",
          destructiveHint: false,
          idempotentHint: tool.kind === "read",
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        try {
          return text(await graph.call(tool.name, args, caller));
        } catch (e) {
          if (e instanceof ToolError) return failure(e.message);
          throw e;
        }
      },
    );
  }

  server.registerTool(
    "graph_info",
    {
      title: "Graph info",
      description: "Which graph and model this is, how many of each node it holds, and the tools available.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => text(await graph.info()),
  );

  server.registerTool(
    "model_guide",
    {
      title: "Model guide",
      description: "How to use this graph's model: what to record, when, and how to query it. Read it before writing.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const shape = [
        `# Model: ${model.title} (${model.name} v${model.version})`,
        "",
        model.description,
        "",
        "## Nodes",
        ...Object.entries(model.nodes).map(([l, n]) => `- **${l}**: ${n.description}`),
        "",
        "## Relationships",
        ...Object.entries(model.relationships).map(
          ([t, r]) => `- **${t}** (${r.from.join("|")} → ${r.to.join("|")}): ${r.description}`,
        ),
      ].join("\n");
      return text(`${shape}\n\n${graph.pack.instructions}`.trim());
    },
  );

  return server;
}
