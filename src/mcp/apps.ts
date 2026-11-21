// MCP App views. All views are one React bundle, built to a single HTML file
// (dist/apps/views.html). Each view is its own ui:// resource: the same HTML,
// with the view's name filled in, so a host can show it next to the tool call
// that asked for it.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { packageRoot } from "../core/package-root.js";

/** The MCP Apps resource type (ext-apps RESOURCE_MIME_TYPE). */
export const APP_MIME = "text/html;profile=mcp-app";

export const VIEWS = {
  console: "Sharing console: join codes, everyone in the graph, who is online, and their roles",
  explorer: "Graph explorer: the graph as it stood at any moment, with search",
  receipt: "Receipt: what your agent just wrote, with Undo while it is still on this machine",
  conflicts: "Conflicts: items that contradict each other, side by side",
} as const;
export type ViewName = keyof typeof VIEWS;

export const viewUri = (v: ViewName) => `ui://vine/${v}`;

/** The built views file, or undefined if `npm run build` hasn't made it. */
export function viewsFile(): string | undefined {
  const f = join(packageRoot(), "dist", "apps", "views.html");
  return existsSync(f) ? f : undefined;
}

// Read once, and again whenever a rebuild changes the file.
let cached: { mtime: number; html: string } | undefined;
function viewsHtml(): string {
  const f = viewsFile();
  if (!f)
    return `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:16px">The views aren't built. Run <code>npm run build</code> in vine-context.</body>`;
  const mtime = statSync(f).mtimeMs;
  if (cached?.mtime !== mtime) cached = { mtime, html: readFileSync(f, "utf8") };
  return cached.html;
}

/** The HTML for one view. */
export function viewHtml(view: ViewName): string {
  // The view name is one of a fixed set, so it can go into the page as is.
  return viewsHtml().replace("<!--VINE_VIEW-->", `<script>window.__VINE_VIEW__=${JSON.stringify(view)}</script>`);
}

export function registerViews(server: McpServer): void {
  for (const [view, description] of Object.entries(VIEWS) as [ViewName, string][]) {
    const uri = viewUri(view);
    server.registerResource(`view-${view}`, uri, { title: description.split(":")[0], description, mimeType: APP_MIME }, async () => ({
      contents: [{ uri, mimeType: APP_MIME, text: viewHtml(view) }],
    }));
  }
}

/** Tool _meta that shows a view with the tool's result. */
export const uiMeta = (view: ViewName) => ({ ui: { resourceUri: viewUri(view) } });
