import { Alert } from "@squonk/ui/alert";
import { Button } from "@squonk/ui/button";
import { HStack } from "@squonk/ui/hstack";
import { Presentation } from "@squonk/ui/presentation";
import { Spinner } from "@squonk/ui/spinner";
import { Text } from "@squonk/ui/text";
import { VStack } from "@squonk/ui/vstack";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NoToolCalls, asks, useBridge, type Bridge } from "./bridge";
import { LinkButton } from "./linkbutton";
import type { Panel } from "./panel";
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
      setPanel({ view, data: await b.call("open_view", { view }) });
      await setMode(["fullscreen", "pip"]);
    } catch (e) {
      if (!(e instanceof NoToolCalls)) return setError((e as Error).message);
      await b.say(asks("open_view", { view }));
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
  // ui://vine/view serves open_view, which shows any of three views: which one comes with the call (its result, else its input).
  let name = window.__VINE_VIEW__ ?? "";
  if (name === "view") {
    const data = b.data as { view?: string; url?: string } | undefined;
    if (data?.view === "browser" && data.url)
      return (
        <Alert tone="info" variant="tinted" title="The views are open in your browser">
          <LinkButton onClick={() => void b.app.openLink({ url: data.url! }).catch(() => undefined)}>Open them again</LinkButton>. The link works on this machine only, and acts as you: don't share it.
        </Alert>
      );
    name = data?.view ?? (b.input ? String(b.input.view ?? "contexts") : "");
    if (!name)
      return (
        <HStack gap="xs" align="center">
          <Spinner label="Opening" />
          <Text tone="muted">Opening…</Text>
        </HStack>
      );
  }
  const View = VIEWS[name];
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
    <Presentation register="compact">
      <Root />
    </Presentation>
  </VineTheme>,
);
