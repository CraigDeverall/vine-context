import { Alert } from "@squonk/ui/alert";
import { Button } from "@squonk/ui/button";
import { HStack } from "@squonk/ui/hstack";
import { Spinner } from "@squonk/ui/spinner";
import { Text } from "@squonk/ui/text";
import { VStack } from "@squonk/ui/vstack";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NoToolCalls, asks, useBridge, type Bridge } from "./bridge";
import type { Panel } from "./panel";
import "./styles.css";
import { VineTheme } from "./theme";
import { Conflicts } from "./views/Conflicts";
import { Console } from "./views/Console";
import { Contexts } from "./views/Contexts";
import { Explorer } from "./views/Explorer";
import { Receipt } from "./views/Receipt";

declare global {
  interface Window {
    __VINE_VIEW__?: string;
  }
}

const VIEWS: Record<string, (p: { b: Bridge; open?: (p: Panel) => void }) => React.ReactNode> = {
  console: Console,
  contexts: Contexts,
  explorer: Explorer,
  receipt: Receipt,
  conflicts: Conflicts,
};

const PANEL_TOOL: Record<Panel, string> = { explorer: "explore_context", console: "open_console" };

function Root() {
  const b = useBridge();
  // A panel opened from another view (the receipt), shown in its place.
  const [panel, setPanel] = useState<{ view: Panel; data: unknown }>();
  const [error, setError] = useState<string>();
  if (!b)
    return (
      <HStack gap="xs" align="center">
        <Spinner label="Connecting" />
        <Text tone="muted">Connecting…</Text>
      </HStack>
    );
  if ("error" in b) return <Alert tone="error">{b.error}</Alert>;
  if (b.failed) return <Alert tone="error">{b.failed}</Alert>;

  // Larger display modes, best first: fullscreen is the side or full-window
  // panel in hosts that have one; pip floats. Inline hosts just swap in place.
  const setMode = async (want: ("fullscreen" | "pip" | "inline")[]) => {
    const ctx = b.app.getHostContext();
    const mode = want.find((m) => ctx?.availableDisplayModes?.includes(m));
    if (mode && ctx?.displayMode !== mode) await b.app.requestDisplayMode({ mode }).catch(() => undefined);
  };
  const open = async (view: Panel) => {
    setError(undefined);
    try {
      setPanel({ view, data: await b.call(PANEL_TOOL[view]) });
      await setMode(["fullscreen", "pip"]);
    } catch (e) {
      if (!(e instanceof NoToolCalls)) return setError((e as Error).message);
      await b.say(asks(PANEL_TOOL[view], {}));
    }
  };
  const back = async () => {
    setPanel(undefined);
    await setMode(["inline"]);
  };

  if (panel) {
    const View = VIEWS[panel.view];
    return (
      <VStack gap="sm">
        <HStack>
          <Button variant="ghost" onClick={back}>
            ← Back to what was written
          </Button>
        </HStack>
        <View b={{ ...b, data: panel.data }} />
      </VStack>
    );
  }
  const View = VIEWS[window.__VINE_VIEW__ ?? ""];
  if (!View) return <Alert tone="error">Unknown view.</Alert>;
  return (
    <VStack gap="sm">
      <View b={b} open={open} />
      {error && <Alert tone="error">{error}</Alert>}
    </VStack>
  );
}

createRoot(document.getElementById("root")!).render(
  <VineTheme>
    <Root />
  </VineTheme>,
);
