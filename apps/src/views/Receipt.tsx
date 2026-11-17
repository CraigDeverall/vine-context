// What the agent just wrote. For a few seconds it is still only on this
// machine: Undo removes it without trace. After that it has been sent to the
// other members, and the button becomes Withdraw (it stays in the history).

import { useEffect, useState } from "react";
import type { Bridge } from "../bridge";
import type { Panel } from "../panel";

interface ReceiptData {
  tool: string;
  title: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  undo: { take_back: boolean; withdraw: boolean } | null;
  where: string;
}

const show = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : typeof v === "object" && v ? JSON.stringify(v) : String(v));

export function Receipt({ b, open }: { b: Bridge; open?: (p: Panel) => void }) {
  const d = b.data as ReceiptData | undefined;
  const [undone, setUndone] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const sharedAt = typeof d?.result?.shared_at === "string" ? Date.parse(d.result.shared_at) : 0;
  useEffect(() => {
    if (!sharedAt || sharedAt <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [sharedAt]);
  if (!d) return <p className="faint">Waiting for the result…</p>;

  const input = Object.entries(d.input ?? {}).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0));
  const main = input.find(([k]) => k === "text");
  const rest = input.filter(([k]) => k !== "text");
  const change = typeof d.result?.change === "string" ? d.result.change : undefined;
  const item = typeof d.result?.id === "string" ? d.result.id : undefined;
  const left = Math.ceil((sharedAt - now) / 1000);
  const held = Boolean(d.undo?.take_back && change && left > 0);
  const canWithdraw = Boolean(d.undo?.withdraw && item && !held && (d.tool === "add_claim" || d.tool === "ask_question"));

  const run = async (tool: string, args: Record<string, unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await b.call(tool, args);
      setUndone(done);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const undo = () => run("take_back", { id: change }, "Taken back. It never left this machine.");
  const withdraw = () => run("withdraw", { id: item }, "Withdrawn. The other members have it, so it stays in the graph's history.");

  return (
    <div className="card">
      <div className="spread">
        <div className="row">
          <span className={`pill ${undone ? "" : held ? "warn" : "ok"}`}>{undone ? "undone" : held ? "on this machine" : "shared"}</span>
          <strong>{d.title}</strong>
          {d.result && typeof d.result.id === "string" && <code className="faint">{d.result.id}</code>}
        </div>
        {!undone && held && (
          <button disabled={busy} onClick={undo} title="It is still only on this machine: Undo removes it without trace">
            Undo ({left}s)
          </button>
        )}
        {!undone && canWithdraw && (
          <button disabled={busy} onClick={withdraw} title="Already sent to the other members: withdrawing keeps it in the history">
            Withdraw
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
