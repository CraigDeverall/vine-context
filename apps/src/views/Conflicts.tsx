// Pairs of items that contradict each other, side by side. Works for any tool
// whose rows hold two items (objects) and some details about the pair.

import { useEffect, useState } from "react";
import { when, type Bridge } from "../bridge";

interface Data {
  tool: string;
  title: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>[] | Record<string, unknown>;
  where: string;
}
type Item = Record<string, unknown>;

const isItem = (v: unknown): v is Item => !!v && typeof v === "object" && !Array.isArray(v);
const label = (i: Item) => String(i.text ?? i.title ?? i.name ?? i.id ?? "");

function split(row: Record<string, unknown>) {
  const entries = Object.entries(row);
  const items = entries.filter(([, v]) => isItem(v)) as [string, Item][];
  const details = entries.filter(([, v]) => !isItem(v));
  return { a: items[0], b: items[1], details };
}

function Side({ item }: { item: [string, Item] | undefined }) {
  if (!item) return <div className="side-item faint">—</div>;
  const [, i] = item;
  return (
    <div className="side-item">
      <p>{label(i)}</p>
      <p className="faint">
        {typeof i.id === "string" && <code>{i.id}</code>} {typeof i.recorded_by === "string" && <>· {i.recorded_by}</>}{" "}
        {typeof i.recorded_at === "string" && <>· {when(i.recorded_at)}</>}
      </p>
    </div>
  );
}

export function Conflicts({ b }: { b: Bridge }) {
  const [data, setData] = useState(b.data as Data | undefined);
  const [error, setError] = useState<string>();
  const [asked, setAsked] = useState<number>();
  useEffect(() => setData(b.data as Data | undefined), [b.data]);
  if (!data) return <p className="faint">Waiting for the result…</p>;
  const rows = Array.isArray(data.result) ? data.result : [data.result];

  const refresh = async () => {
    try {
      const r = await b.call<Data>(data.tool, data.input);
      setData(r);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const settle = async (i: number, a?: Item, c?: Item) => {
    setAsked(i);
    try {
      await b.say(
        `Help me settle this conflict: "${a ? label(a) : "?"}" (${String(a?.id ?? "")}) versus "${c ? label(c) : "?"}" (${String(c?.id ?? "")}). ` +
          "Look at the evidence for each, tell me which is better supported, and when I decide, record a claim that replaces the wrong one.",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <div className="head">
        <h1>
          {rows.length === 0 ? "No conflicts" : `${rows.length} conflict${rows.length === 1 ? "" : "s"}`} <span className="muted">in {data.where}</span>
        </h1>
        <button onClick={refresh}>Refresh</button>
      </div>
      {rows.length === 0 && <p className="empty">Nothing contradicts anything else right now.</p>}
      <div className="list">
        {rows.map((row, i) => {
          const { a, b: c, details } = split(row);
          return (
            <div key={i} className="card">
              <div className="pair">
                <Side item={a} />
                <div className="vs">{c ? "vs" : ""}</div>
                <Side item={c} />
              </div>
              <div className="spread" style={{ marginTop: 6 }}>
                <span className="faint">
                  {details.map(([k, v]) => `${k.replace(/_/g, " ")}: ${typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? when(v) : String(v)}`).join(" · ")}
                </span>
                <button className="link" disabled={asked === i} onClick={() => settle(i, a?.[1], c?.[1])}>
                  {asked === i ? "Asked your agent" : "Ask my agent to help settle it"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {error && <p className="notice bad">{error}</p>}
    </div>
  );
}
