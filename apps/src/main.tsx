import { createRoot } from "react-dom/client";
import { useBridge, type Bridge } from "./bridge";
import "./styles.css";
import { Conflicts } from "./views/Conflicts";
import { Console } from "./views/Console";
import { Explorer } from "./views/Explorer";
import { Receipt } from "./views/Receipt";
import { Studio } from "./views/Studio";

declare global {
  interface Window {
    __P2PCG_VIEW__?: string;
  }
}

const VIEWS: Record<string, (p: { b: Bridge }) => React.ReactNode> = {
  console: Console,
  explorer: Explorer,
  studio: Studio,
  receipt: Receipt,
  conflicts: Conflicts,
};

function Root() {
  const b = useBridge();
  if (!b) return <p className="faint">Connecting…</p>;
  if ("error" in b) return <p className="notice bad">{b.error}</p>;
  if (b.failed) return <p className="notice bad">{b.failed}</p>;
  const View = VIEWS[window.__P2PCG_VIEW__ ?? ""];
  if (!View) return <p className="notice bad">Unknown view.</p>;
  return <View b={b} />;
}

createRoot(document.getElementById("root")!).render(<Root />);
