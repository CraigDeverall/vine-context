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
  /** False once the host has shown it can't pass this view's tool calls to the server. */
  canCall: boolean;
  /**
   * Do something with a tool: call it directly, or, where the host can't pass
   * tool calls on, ask the agent to (`ask` is what the person would have typed).
   * Resolves "called" or "asked".
   */
  run(tool: string, args: Record<string, unknown>, ask: string): Promise<"called" | "asked">;
  /** Ask the agent to do something, as if the person had typed it. */
  say(text: string): Promise<void>;
}

function applyContext(ctx: McpUiHostContext | undefined) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

/** The host can't pass a view's tool calls on to the server (some hosts show views but don't relay their calls). */
export class NoToolCalls extends Error {}

const NO_RELAY = /IPC not available|-32601|method not found|not supported|serverTools/i;

/** What the person would type to have the agent run a tool for them. */
export const asks = (tool: string, args: Record<string, unknown>): string =>
  `Please run the p2p-context-graph tool ${tool}${Object.keys(args).length ? ` with ${JSON.stringify(args)}` : ""} (from the view, which can't run tools in this app).`;

export function useBridge(): Bridge | { error: string } | undefined {
  const [state, setState] = useState<{ app: App; input?: Record<string, unknown>; data?: unknown; failed?: string } | { error: string }>();
  const [canCall, setCanCall] = useState(true);

  useEffect(() => {
    const app = new App({ name: "p2p-context-graph", version: "1" }, { availableDisplayModes: ["inline", "fullscreen", "pip"] }, { autoResize: true });
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
      .then(() => {
        applyContext(app.getHostContext());
        if (!app.getHostCapabilities()?.serverTools) setCanCall(false);
      })
      .catch((e: Error) => setState({ error: `Couldn't connect to the host: ${e.message}` }));
  }, []);

  if (!state || "error" in state) return state;
  const { app } = state;
  const say = async (text: string) => {
    await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
  };
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    if (!canCall) throw new NoToolCalls(`This app can't run ${tool} from here.`);
    let r: CallResult;
    try {
      r = (await app.callServerTool({ name: tool, arguments: args })) as CallResult;
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (NO_RELAY.test(msg)) {
        setCanCall(false);
        throw new NoToolCalls(`This app can't run ${tool} from here (${msg}).`);
      }
      throw e;
    }
    const d = resultData(r);
    if (r.isError) throw new Error(typeof d === "string" ? d : JSON.stringify(d));
    return d as any;
  };
  return {
    app,
    input: state.input,
    data: state.data,
    failed: state.failed,
    canCall,
    call,
    say,
    async run(tool, args, ask) {
      try {
        await call(tool, args);
        return "called";
      } catch (e) {
        if (!(e instanceof NoToolCalls)) throw e;
        await say(ask);
        return "asked";
      }
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
