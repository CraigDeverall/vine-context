// The views' side of MCP Apps: one App connection to the host, the tool
// result that opened the view, and calls back to the server's tools.

import { App, applyDocumentTheme, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useEffect, useState } from "react";

type CallResult = { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };

/** A tool result's data: its structured content, else its text parsed as JSON, else the text. */
export function resultData(r: CallResult): unknown {
  if (r.structuredContent !== undefined) return r.structuredContent;
  const t = r.content?.find((c) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export interface Bridge {
  app: App;
  /** The arguments of the tool call this view belongs to. */
  input: Record<string, unknown> | undefined;
  /** The result data of that call, once it arrives. */
  data: unknown;
  /** True when the host has said the tool call failed. */
  failed: string | undefined;
  call<T = any>(tool: string, args?: Record<string, unknown>): Promise<T>;
  /** Ask the agent to do something, as if the person had typed it. */
  say(text: string): Promise<void>;
}

function applyContext(ctx: McpUiHostContext | undefined) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

export function useBridge(): Bridge | { error: string } | undefined {
  const [state, setState] = useState<{ app: App; input?: Record<string, unknown>; data?: unknown; failed?: string } | { error: string }>();

  useEffect(() => {
    const app = new App({ name: "p2p-context-graph", version: "1" }, {}, { autoResize: true });
    app.ontoolinput = (p) => setState((s) => (s && "app" in s ? { ...s, input: p.arguments } : s));
    app.ontoolresult = (r) =>
      setState((s) => {
        if (!s || !("app" in s)) return s;
        const res = r as CallResult;
        if (res.isError) return { ...s, failed: String(resultData(res)) };
        return { ...s, data: resultData(res), failed: undefined };
      });
    app.onhostcontextchanged = (ctx) => applyContext(ctx as McpUiHostContext);
    setState({ app });
    app
      .connect()
      .then(() => applyContext(app.getHostContext()))
      .catch((e: Error) => setState({ error: `Couldn't connect to the host: ${e.message}` }));
  }, []);

  if (!state || "error" in state) return state;
  const { app } = state;
  return {
    app,
    input: state.input,
    data: state.data,
    failed: state.failed,
    async call(tool, args = {}) {
      const r = (await app.callServerTool({ name: tool, arguments: args })) as CallResult;
      const d = resultData(r);
      if (r.isError) throw new Error(typeof d === "string" ? d : JSON.stringify(d));
      return d as any;
    },
    async say(text) {
      await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
    },
  };
}

/** Refresh `load` every `ms` while the page is visible. */
export function usePoll(load: () => void, ms: number, deps: unknown[]) {
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export const when = (iso: unknown): string => {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const secs = (Date.now() - d.getTime()) / 1000;
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
