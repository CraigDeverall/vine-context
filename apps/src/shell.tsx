// The localhost host page for `p2pcg ui`: for agents that can't show MCP
// Apps, the same views in a browser tab. It is a minimal MCP Apps host: an MCP
// client (over Streamable HTTP, to this machine's p2pcg) and an AppBridge per
// view, in a sandboxed iframe.

import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface AppTool {
  name: string;
  title: string;
  uri: string;
}

// The token comes in the URL fragment, so it never reaches a server log or a Referer header.
const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";

async function connect(): Promise<Client> {
  const client = new Client({ name: "p2pcg-ui", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", location.origin), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

/** Tools that show a view and need no input: the shell's tabs. */
async function appTools(client: Client): Promise<AppTool[]> {
  const { tools } = await client.listTools();
  return tools
    .filter((t) => typeof (t._meta as any)?.ui?.resourceUri === "string" && !(t.inputSchema.required ?? []).length)
    .map((t) => ({ name: t.name, title: t.title ?? t.name, uri: (t._meta as any).ui.resourceUri as string }));
}

function View({ client, tool: { name, title, uri }, onMessage }: { client: Client; tool: AppTool; onMessage: (text: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let bridge: AppBridge | undefined;
    let cancelled = false;
    (async () => {
      const res = await client.readResource({ uri: uri });
      const html = (res.contents[0] as { text?: string }).text ?? "";
      const iframe = frame.current!;
      const theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      bridge = new AppBridge(
        client,
        { name: "p2pcg ui", version: "1" },
        { openLinks: {}, serverTools: {}, logging: {} },
        { hostContext: { theme, platform: "web", displayMode: "inline" } as never },
      );
      bridge.onsizechange = ({ height: h }) => h && setHeight(Math.min(Math.max(h + 4, 200), 4000));
      bridge.onmessage = async (p) => {
        const text = p.content.map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
        onMessage(text);
        return {};
      };
      bridge.onopenlink = async ({ url }) => {
        if (/^https?:/.test(url)) window.open(url, "_blank", "noopener");
        return {};
      };
      bridge.oninitialized = async () => {
        await bridge!.sendToolInput({ arguments: {} });
        const result = await client.callTool({ name: name, arguments: {} });
        if (!cancelled) await bridge!.sendToolResult(result as never);
      };
      // The view gets an opaque origin: scripts only, no access to this page.
      iframe.srcdoc = html;
      await new Promise((r) => iframe.addEventListener("load", r, { once: true }));
      await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
    })().catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      void bridge?.close();
    };
  }, [client, name, uri, onMessage]);

  return (
    <>
      {error && <p className="notice bad">{error}</p>}
      <iframe ref={frame} title={title} sandbox="allow-scripts" style={{ width: "100%", height, border: 0, display: "block" }} />
    </>
  );
}

function Shell() {
  const [client, setClient] = useState<Client>();
  const [tools, setTools] = useState<AppTool[]>([]);
  const [active, setActive] = useState<string>(new URLSearchParams(location.search).get("view") ?? "open_console");
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [gen, setGen] = useState(0);

  useEffect(() => {
    connect()
      .then(async (c) => {
        setClient(c);
        setTools(await appTools(c));
      })
      .catch((e: Error) => setError(`Can't reach p2pcg: ${e.message}. Is \`p2pcg ui\` still running?`));
  }, []);

  const pick = async (name: string) => {
    setActive(name);
    setGen((g) => g + 1);
    if (client) setTools(await appTools(client)); // the model's tools change after use_graph or a role change
    history.replaceState(null, "", `?view=${name}${location.hash}`);
  };

  const tool = tools.find((t) => t.name === active) ?? tools[0];
  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <div className="head">
        <h1>p2p-context-graph</h1>
        <div className="tabs" role="tablist" style={{ margin: 0, border: 0 }}>
          {tools.map((t) => (
            <button key={t.name} role="tab" aria-selected={tool?.name === t.name} onClick={() => pick(t.name)}>
              {t.title.replace(/^Open the /, "").replace(/^./, (c) => c.toUpperCase())}
            </button>
          ))}
        </div>
      </div>
      {message && (
        <div className="notice" style={{ margin: "8px 0" }}>
          <div className="spread">
            <strong>Paste this to your agent</strong>
            <button className="link" onClick={() => setMessage(undefined)}>
              Dismiss
            </button>
          </div>
          <textarea readOnly value={message} style={{ width: "100%", minHeight: 60, marginTop: 6, font: "inherit" }} onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}
      {error && <p className="notice bad">{error}</p>}
      {client && tool && <View key={`${tool.name}:${gen}`} client={client} tool={tool} onMessage={setMessage} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Shell />);
