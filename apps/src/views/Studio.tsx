// The model studio: the graph's model, the packs this machine has, your
// graphs, and checking and installing a new pack.

import { useEffect, useState } from "react";
import type { Bridge } from "../bridge";

interface Schema {
  nodes: { label: string; description: string; key: string | null; title: string | null; properties: { name: string; type: string; required: boolean; description: string | null }[] }[];
  relationships: { type: string; description: string; from: string[]; to: string[] }[];
}
interface StudioData {
  using: string;
  mode: "host" | "peer";
  can_manage: boolean;
  graph: string | null;
  model: { name: string; version: number; title: string; description: string; schema: Schema; tools: { name: string; title?: string; kind: string; role: string; description: string }[] } | null;
  guide: string | null;
  packs: { name: string; source: string; title?: string; description?: string; version?: number; tools?: number; error?: string }[];
  graphs: string[];
}
interface Report {
  ok: boolean;
  dir: string;
  errors: string[];
  model?: { name: string; version: number; title: string; nodes: string[]; relationships: string[] };
  tools: { tool: string; kind: string; outcome: "ran" | "refused-sample" | "failed"; message?: string }[];
}

type Tab = "model" | "packs" | "check";

export function Studio({ b }: { b: Bridge }) {
  const [d, setD] = useState(b.data as StudioData | undefined);
  const [tab, setTab] = useState<Tab>("model");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [path, setPath] = useState("");
  const [report, setReport] = useState<Report>();
  const [newGraph, setNewGraph] = useState<Record<string, string>>({});
  useEffect(() => setD(b.data as StudioData | undefined), [b.data]);

  const refresh = async () => setD(await b.call<StudioData>("model_studio"));
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!d) return <p className="faint">Loading…</p>;
  const m = d.model;

  return (
    <div>
      <div className="head">
        <h1>
          {m ? m.title : "No model"} <span className="muted">· {d.using}</span>
        </h1>
        {m && <span className="pill">{m.name} v{m.version}</span>}
      </div>
      <div className="tabs" role="tablist">
        {(["model", ...(d.can_manage ? ["packs", "check"] : [])] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === "model" ? "This model" : t === "packs" ? "Packs and graphs" : "Check a new pack"}
          </button>
        ))}
      </div>

      {tab === "model" && m && (
        <div>
          <p className="muted">{m.description}</p>
          <h2>Node types</h2>
          <div className="list">
            {m.schema.nodes.map((n) => (
              <div className="card" key={n.label}>
                <strong>{n.label}</strong> <span className="faint">{n.description}</span>
                <table style={{ marginTop: 6 }}>
                  <tbody>
                    {n.properties.map((p) => (
                      <tr key={p.name}>
                        <td>
                          <code>{p.name}</code>
                          {p.name === n.key && <span className="pill" style={{ marginLeft: 6 }}>key</span>}
                        </td>
                        <td className="faint">
                          {p.type}
                          {p.required ? ", required" : ""}
                        </td>
                        <td className="muted">{p.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          <h2>Relationships</h2>
          <table>
            <tbody>
              {m.schema.relationships.map((r) => (
                <tr key={r.type}>
                  <td>
                    <code>
                      ({r.from.join("|")})-[{r.type}]→({r.to.join("|")})
                    </code>
                  </td>
                  <td className="muted">{r.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>Tools</h2>
          <table>
            <tbody>
              {m.tools.map((t) => (
                <tr key={t.name}>
                  <td>
                    <code>{t.name}</code>
                  </td>
                  <td>
                    <span className={`pill ${t.kind === "write" ? "warn" : ""}`}>{t.kind}</span>
                  </td>
                  <td className="faint">{t.role}+</td>
                  <td className="muted">{t.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "packs" && (
        <div>
          <h2>Model packs</h2>
          <div className="list">
            {d.packs.map((p) => (
              <div className="card" key={p.name}>
                <div className="spread">
                  <div className="grow">
                    <strong>{p.title ?? p.name}</strong> <span className="faint">{p.name} · {p.source}{p.version ? ` · v${p.version}` : ""}{p.tools ? ` · ${p.tools} tools` : ""}</span>
                    {p.description && <p className="muted">{p.description}</p>}
                    {p.error && <p className="notice bad">{p.error}</p>}
                  </div>
                  {!p.error && (
                    <div className="row">
                      <input
                        placeholder="new graph name"
                        value={newGraph[p.name] ?? ""}
                        onChange={(e) => setNewGraph({ ...newGraph, [p.name]: e.target.value.toLowerCase() })}
                        aria-label={`Name for a new ${p.name} graph`}
                        style={{ width: 150 }}
                      />
                      <button
                        disabled={busy || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(newGraph[p.name] ?? "")}
                        onClick={() =>
                          act(async () => {
                            await b.call("use_graph", { name: newGraph[p.name], model: p.name });
                            await refresh();
                            setNote(`This session now uses the graph '${newGraph[p.name]}'.`);
                          })
                        }
                      >
                        Start a graph
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <h2>Your graphs</h2>
          {d.graphs.length === 0 ? (
            <p className="empty">No graphs yet.</p>
          ) : (
            <table>
              <tbody>
                {d.graphs.map((g) => (
                  <tr key={g}>
                    <td>
                      <code>{g}</code>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {g === d.graph ? (
                        <span className="pill ok">in use</span>
                      ) : (
                        <button
                          disabled={busy}
                          onClick={() =>
                            act(async () => {
                              await b.call("use_graph", { name: g });
                              await refresh();
                              setNote(`This session now uses the graph '${g}'.`);
                            })
                          }
                        >
                          Switch to it
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "check" && (
        <div>
          <p className="muted">
            Point at a pack folder (model.yaml, tools.yaml, instructions.md). Checking runs every tool once on a scratch graph. Ask your agent to help you write one: it
            knows the format.
          </p>
          <div className="row" style={{ marginTop: 8 }}>
            <input className="grow mono" placeholder="/path/to/my-pack" value={path} onChange={(e) => setPath(e.target.value)} aria-label="Pack folder" />
            <button disabled={busy || !path} onClick={() => act(async () => setReport(await b.call<Report>("validate_model", { path })))}>
              Check
            </button>
            <button
              className="primary"
              disabled={busy || !report?.ok}
              onClick={() =>
                act(async () => {
                  const r = await b.call<{ installed: string }>("install_model", { path });
                  await refresh();
                  setNote(`Installed '${r.installed}'. Start a graph with it under Packs and graphs.`);
                })
              }
            >
              Install
            </button>
          </div>
          {report && (
            <div className="card" style={{ marginTop: 10 }}>
              <div className="row">
                <span className={`pill ${report.ok ? "ok" : "bad"}`}>{report.ok ? "passes" : "fails"}</span>
                {report.model && (
                  <strong>
                    {report.model.title} <span className="faint">{report.model.name} v{report.model.version}</span>
                  </strong>
                )}
              </div>
              {report.errors.map((e, i) => (
                <pre key={i} className="notice bad mono" style={{ whiteSpace: "pre-wrap" }}>
                  {e}
                </pre>
              ))}
              {report.tools.length > 0 && (
                <table style={{ marginTop: 6 }}>
                  <tbody>
                    {report.tools.map((t) => (
                      <tr key={t.tool}>
                        <td>
                          <code>{t.tool}</code>
                        </td>
                        <td>
                          <span className={`pill ${t.outcome === "failed" ? "bad" : t.outcome === "ran" ? "ok" : "warn"}`}>
                            {t.outcome === "refused-sample" ? "ran, sample refused" : t.outcome}
                          </span>
                        </td>
                        <td className="muted">{t.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}
      {note && <p className="notice ok">{note}</p>}
      {error && <p className="notice bad">{error}</p>}
    </div>
  );
}
