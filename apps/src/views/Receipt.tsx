// What the agent just wrote, with undo where the model allows it.

import { useState } from "react";
import type { Bridge } from "../bridge";
import type { Panel } from "../panel";

interface ReceiptData {
  tool: string;
  title: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  undo: { tool: string; arg: string; field: string } | null;
  where: string;
}

const show = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : typeof v === "object" && v ? JSON.stringify(v) : String(v));

export function Receipt({ b, open }: { b: Bridge; open?: (p: Panel) => void }) {
  const d = b.data as ReceiptData | undefined;
  const [undone, setUndone] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!d) return <p className="faint">Waiting for the result…</p>;

  const input = Object.entries(d.input ?? {}).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0));
  const main = input.find(([k]) => k === "text");
  const rest = input.filter(([k]) => k !== "text");
  const target = d.undo && d.result ? d.result[d.undo.field] : undefined;

  const undo = async () => {
    if (!d.undo || target === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await b.call(d.undo.tool, { [d.undo.arg]: target });
      setUndone(`Undone with ${d.undo.tool}. It stays in the graph's history.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="spread">
        <div className="row">
          <span className={`pill ${undone ? "" : "ok"}`}>{undone ? "undone" : "recorded"}</span>
          <strong>{d.title}</strong>
          {d.result && typeof d.result.id === "string" && <code className="faint">{d.result.id}</code>}
        </div>
        {d.undo && target !== undefined && !undone && (
          <button disabled={busy} onClick={undo}>
            Undo
          </button>
        )}
      </div>
      {main && <p style={{ margin: "8px 0", fontSize: 15 }} className={undone ? "ended" : ""}>{show(main[1])}</p>}
      {rest.length > 0 && (
        <dl className="kv" style={{ marginTop: 6 }}>
          {rest.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k.replace(/_/g, " ")}</dt>
              <dd>{show(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="spread" style={{ marginTop: 6 }}>
        <p className="faint" style={{ margin: 0 }}>In {d.where}</p>
        {open && (
          <div className="row">
            <button className="link" onClick={() => open("explorer")}>
              Explore graph
            </button>
            <button className="link" onClick={() => open("console")}>
              Console
            </button>
          </div>
        )}
      </div>
      {undone && <p className="notice">{undone}</p>}
      {error && <p className="notice bad">{error}</p>}
    </div>
  );
}
