// The localhost host page for `vine ui`: for agents that can't show MCP
// Apps, the same views in a browser tab. It is a minimal MCP Apps host: an MCP
// client (over Streamable HTTP, to this machine's vine) and an AppBridge per
// view, in a sandboxed iframe.

import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Alert } from "@squonk/ui/alert";
import { Container } from "@squonk/ui/container";
import { Tabs } from "@squonk/ui/tabs";
import { Textarea } from "@squonk/ui/textarea";
import { VStack } from "@squonk/ui/vstack";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Brand } from "./brand";
import { VineTheme } from "./theme";

/** One tab: a tool that shows a view, and the arguments to call it with. */
interface AppTool {
  key: string;
  name: string;
  args: Record<string, unknown>;
  title: string;
  uri: string;
}

/** open_view shows any of these, so it is a tab for each. */
const OPEN_VIEWS = [
  ["contexts", "Contexts"],
  ["console", "Console"],
  ["explorer", "Explorer"],
] as const;

// The token comes in the URL fragment, so it never reaches a server log or a Referer header.
const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";

async function connect(): Promise<Client> {
  const client = new Client({ name: "vine-ui", version: "1" });
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
    .flatMap((t) => {
      const uri = (t._meta as any).ui.resourceUri as string;
      if (t.name === "open_view") return OPEN_VIEWS.map(([view, title]) => ({ key: view, name: t.name, args: { view }, title, uri }));
      return [{ key: t.name, name: t.name, args: {}, title: t.title ?? t.name, uri }];
    });
}

function View({ client, tool: { name, args, title, uri }, onMessage }: { client: Client; tool: AppTool; onMessage: (text: string) => void }) {
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
        { name: "vine ui", version: "1" },
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
        await bridge!.sendToolInput({ arguments: args });
        const result = await client.callTool({ name: name, arguments: args });
        if (!cancelled) await bridge!.sendToolResult(result as never);
      };
      // Listen before the view loads, so its first message (ui/initialize) can't be missed.
      await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
      // The view gets an opaque origin: scripts only, no access to this page.
      iframe.srcdoc = html;
    })().catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
      void bridge?.close();
    };
  }, [client, name, args, uri, onMessage]);

  return (
    <>
      {error && <Alert tone="error">{error}</Alert>}
      <iframe ref={frame} title={title} sandbox="allow-scripts" style={{ width: "100%", height, border: 0, display: "block" }} />
    </>
  );
}

function Shell() {
  const [client, setClient] = useState<Client>();
  const [tools, setTools] = useState<AppTool[]>([]);
  const [active, setActive] = useState<string>(new URLSearchParams(location.search).get("view") ?? "console");
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [gen, setGen] = useState(0);

  useEffect(() => {
    connect()
      .then(async (c) => {
        setClient(c);
        setTools(await appTools(c));
      })
      .catch((e: Error) => setError(`Can't reach vine: ${e.message}. Is \`vine ui\` still running?`));
  }, []);

  const pick = async (key: string) => {
    setActive(key);
    setGen((g) => g + 1);
    if (client) setTools(await appTools(client)); // the model's tools change after use_context or a role change
    history.replaceState(null, "", `?view=${key}${location.hash}`);
  };

  const tool = tools.find((t) => t.key === active) ?? tools[0];
  const label = (t: AppTool) => t.title.replace(/^Open the /, "").replace(/^./, (c) => c.toUpperCase());
  return (
    <Container size="desktop">
      <VStack gap="md" style={{ paddingBlock: "var(--squonk-spacing-md)" }}>
        <Brand />
        {message && (
          <Alert tone="info" variant="tinted" title="Paste this to your agent" onDismiss={() => setMessage(undefined)}>
            <Textarea
              label="Message for your agent"
              readOnly
              value={message}
              fullWidth
              autoResize
              onFocus={(e: React.FocusEvent<HTMLTextAreaElement>) => e.currentTarget.select()}
            />
          </Alert>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        {tools.length > 0 && (
          <Tabs
            listLabel="Views"
            value={tool?.key}
            onValueChange={pick}
            items={tools.map((t) => ({
              value: t.key,
              label: label(t),
              content: client && tool?.key === t.key ? <View key={`${t.key}:${gen}`} client={client} tool={t} onMessage={setMessage} /> : null,
            }))}
          />
        )}
      </VStack>
    </Container>
  );
}

createRoot(document.getElementById("root")!).render(
  <VineTheme>
    <Shell />
  </VineTheme>,
);
