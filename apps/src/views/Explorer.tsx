// The graph explorer: the graph as it stood at a moment, as a node-link
// picture. Works for any model: labels and relationship types come from the
// snapshot's schema. Node colour is the label (fixed categorical order);
// relationship type is a dash pattern plus the legend, never colour alone.

import { useEffect, useMemo, useRef, useState } from "react";
import { when, type Bridge } from "../bridge";

interface SNode {
  id: string;
  key: string;
  label: string;
  title: string;
  ended: boolean;
  props: Record<string, unknown>;
}
interface SEdge {
  type: string;
  source: string;
  target: string;
  props: Record<string, unknown>;
}
interface Snapshot {
  graph: string;
  at: string;
  where: string;
  schema: { nodes: { label: string }[]; relationships: { type: string; description: string }[]; time: { recorded: string; ended?: string } | null };
  nodes: SNode[];
  edges: SEdge[];
  truncated: boolean;
}

// Validated categorical palette (light / dark), assigned to labels in model order.
const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9", "#e66767"];
const DASHES = ["", "6 4", "2 3", "10 3 2 3", "1 5", "12 6"];

function useDark() {
  const q = () =>
    document.documentElement.getAttribute("data-theme") === "dark" ||
    (document.documentElement.getAttribute("data-theme") !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  const [dark, setDark] = useState(q);
  useEffect(() => {
    const m = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setDark(q());
    m.addEventListener("change", on);
    const obs = new MutationObserver(on);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      m.removeEventListener("change", on);
      obs.disconnect();
    };
  }, []);
  return dark;
}

type Pos = Map<string, { x: number; y: number }>;

/** A small force layout: repulsion, springs on links, a pull to the centre. */
export function layout(nodes: SNode[], edges: SEdge[], prev: Pos, w: number, h: number): Pos {
  const pos: Pos = new Map();
  const labels = [...new Set(nodes.map((n) => n.label))];
  nodes.forEach((n, i) => {
    const p = prev.get(n.id);
    if (p) pos.set(n.id, { ...p });
    else {
      const a = (labels.indexOf(n.label) / Math.max(labels.length, 1)) * Math.PI * 2 + i * 0.37;
      const r = 60 + (i % 7) * 18;
      pos.set(n.id, { x: w / 2 + Math.cos(a) * r, y: h / 2 + Math.sin(a) * r });
    }
  });
  const ids = nodes.map((n) => n.id);
  const links = edges.filter((e) => pos.has(e.source) && pos.has(e.target));
  const k = Math.sqrt((w * h) / Math.max(nodes.length, 1)) * 0.6;
  const cutoff = (2.5 * k) ** 2;
  const fresh = nodes.some((n) => !prev.has(n.id));
  const rounds = fresh ? 260 : 60;
  for (let it = 0; it < rounds; it++) {
    const t = 1 - it / rounds;
    const disp = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i])!;
        const b = pos.get(ids[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const d2 = Math.max(dx * dx + dy * dy, 1);
        if (d2 > cutoff) continue; // far-apart nodes don't push: unlinked ones stay near the rest
        const f = (k * k) / d2;
        dx *= f;
        dy *= f;
        disp.get(ids[i])!.x += dx;
        disp.get(ids[i])!.y += dy;
        disp.get(ids[j])!.x -= dx;
        disp.get(ids[j])!.y -= dy;
      }
    for (const e of links) {
      const a = pos.get(e.source)!;
      const b = pos.get(e.target)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.1);
      const f = (d - k) / d / 2;
      disp.get(e.source)!.x -= dx * f;
      disp.get(e.source)!.y -= dy * f;
      disp.get(e.target)!.x += dx * f;
      disp.get(e.target)!.y += dy * f;
    }
    for (const id of ids) {
      const p = pos.get(id)!;
      const d = disp.get(id)!;
      d.x += (w / 2 - p.x) * 0.03;
      d.y += (h / 2 - p.y) * 0.03;
      const len = Math.max(Math.sqrt(d.x * d.x + d.y * d.y), 0.01);
      const step = Math.min(len, 12 * t + 0.5);
      p.x += (d.x / len) * step;
      p.y += (d.y / len) * step;
    }
  }
  // Fit the result to the view, keeping its proportions.
  const ps = [...pos.values()];
  if (ps.length) {
    const minX = Math.min(...ps.map((p) => p.x));
    const maxX = Math.max(...ps.map((p) => p.x));
    const minY = Math.min(...ps.map((p) => p.y));
    const maxY = Math.max(...ps.map((p) => p.y));
    const mx = 120; // room for labels to the right
    const my = 36; // and above the zoom buttons
    const s = Math.min((w - 2 * mx) / Math.max(maxX - minX, 1), (h - 2 * my) / Math.max(maxY - minY, 1), 1.5);
    const ox = (w - (maxX - minX) * s) / 2;
    const oy = (h - (maxY - minY) * s) / 2;
    for (const p of ps) {
      p.x = ox + (p.x - minX) * s;
      p.y = oy + (p.y - minY) * s;
    }
  }
  return pos;
}

const short = (s: string, n = 28) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function Explorer({ b }: { b: Bridge }) {
  const [snap, setSnap] = useState(b.data as Snapshot | undefined);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string>();
  const [hover, setHover] = useState<{ id: string; x: number; y: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [view, setView] = useState({ x: 0, y: 0, s: 1 });
  const [range, setRange] = useState<{ min: number; max: number }>();
  const [at, setAt] = useState<number>();
  const prev = useRef<Pos>(new Map());
  const drag = useRef<{ x: number; y: number; vx: number; vy: number }>(undefined);
  const dark = useDark();
  const W = 640;
  const H = 420;

  useEffect(() => {
    if (b.data) setSnap(b.data as Snapshot);
  }, [b.data]);

  // The time range: the history in the latest "now" snapshot, from its first
  // event to its last (so old data isn't squeezed into a corner of the slider).
  useEffect(() => {
    if (!snap || at) return;
    const t = snap.schema.time;
    const times = t
      ? snap.nodes.flatMap((n) => [n.props[t.recorded], t.ended ? n.props[t.ended] : undefined]).map((v) => Date.parse(String(v ?? ""))).filter((v) => !Number.isNaN(v))
      : [];
    if (times.length) setRange({ min: Math.min(...times), max: Math.max(...times) });
  }, [snap, at]);

  const palette = dark ? SERIES_DARK : SERIES_LIGHT;
  const labelColor = useMemo(() => {
    const m = new Map<string, string>();
    snap?.schema.nodes.forEach((n, i) => m.set(n.label, palette[i] ?? "var(--fg3)")); // a 9th label would be grey, not a new hue
    return m;
  }, [snap, palette]);
  const dashOf = useMemo(() => {
    const m = new Map<string, string>();
    snap?.schema.relationships.forEach((r, i) => m.set(r.type, DASHES[i % DASHES.length]!));
    return m;
  }, [snap]);

  const pos = useMemo(() => {
    if (!snap) return new Map() as Pos;
    const p = layout(snap.nodes, snap.edges, prev.current, W, H);
    prev.current = p;
    return p;
  }, [snap]);

  const q = filter.trim().toLowerCase();
  const matches = (n: SNode) => !q || n.title.toLowerCase().includes(q) || n.key.toLowerCase().includes(q);
  const sel = snap?.nodes.find((n) => n.id === selected);
  const neighbours = useMemo(() => {
    const s = new Set<string>();
    if (!snap || !selected) return s;
    for (const e of snap.edges) {
      if (e.source === selected) s.add(e.target);
      if (e.target === selected) s.add(e.source);
    }
    return s;
  }, [snap, selected]);

  const load = async (when?: number) => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await b.call<Snapshot>("explore_context", when ? { at: new Date(when).toISOString() } : {});
      setSnap(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!snap) return <p className="faint">Loading the graph…</p>;
  const nodeById = new Map(snap.nodes.map((n) => [n.id, n]));
  const listed = snap.nodes.filter(matches);
  const hovered = hover && nodeById.get(hover.id);

  return (
    <div>
      <div className="head">
        <h1>
          {snap.where} <span className="muted">· {snap.nodes.length} items, {snap.edges.length} links</span>
        </h1>
        <div className="row">
          <input placeholder="Filter items" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter items" style={{ width: 170 }} />
          <button disabled={busy} onClick={() => (setAt(undefined), load())}>
            Now
          </button>
        </div>
      </div>

      {range && range.max > range.min && (
        <div className="timebar">
          <span className="faint">As of</span>
          <input
            type="range"
            min={range.min}
            max={range.max}
            step={Math.max(1, Math.round((range.max - range.min) / 200))}
            value={at ?? range.max}
            onChange={(e) => setAt(Number(e.target.value))}
            onPointerUp={() => at && load(at)}
            onKeyUp={() => at && load(at)}
            aria-label="Show the graph as it stood at this time"
          />
          <span className="mono" style={{ minWidth: 150, textAlign: "right" }}>
            {at ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "now"}
          </span>
        </div>
      )}

      <div className="explorer">
        <div>
          <div className="canvas">
            {snap.nodes.length === 0 ? (
              <p className="empty" style={{ padding: 16 }}>
                Nothing in the graph {at ? "at that time" : "yet"}.
              </p>
            ) : (
              <svg
                viewBox={`0 0 ${W} ${H}`}
                role="img"
                aria-label={`Graph of ${snap.nodes.length} items and ${snap.edges.length} links`}
                onPointerDown={(e) => {
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
                }}
                onPointerMove={(e) => {
                  if (!drag.current) return;
                  const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                  const f = W / r.width;
                  setView({ ...view, x: drag.current.vx + (e.clientX - drag.current.x) * f, y: drag.current.vy + (e.clientY - drag.current.y) * f });
                }}
                onPointerUp={() => (drag.current = undefined)}
                onWheel={(e) => setView({ ...view, s: Math.min(4, Math.max(0.3, view.s * (e.deltaY > 0 ? 0.9 : 1.1))) })}
              >
                <defs>
                  <marker id="arrow" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--fg3)" />
                  </marker>
                </defs>
                <g transform={`translate(${view.x + (W / 2) * (1 - view.s)} ${view.y + (H / 2) * (1 - view.s)}) scale(${view.s})`}>
                  {snap.edges.map((e, i) => {
                    const a = pos.get(e.source);
                    const c = pos.get(e.target);
                    if (!a || !c) return null;
                    const lit = selected && (e.source === selected || e.target === selected);
                    const dim = (selected && !lit) || (q && !(matches(nodeById.get(e.source)!) || matches(nodeById.get(e.target)!)));
                    return (
                      <line
                        key={i}
                        x1={a.x}
                        y1={a.y}
                        x2={c.x}
                        y2={c.y}
                        stroke={lit ? "var(--fg)" : "var(--fg3)"}
                        strokeWidth={lit ? 2 : 1.25}
                        strokeDasharray={dashOf.get(e.type)}
                        opacity={dim ? 0.15 : 0.85}
                        markerEnd="url(#arrow)"
                      >
                        <title>{e.type}</title>
                      </line>
                    );
                  })}
                  {snap.nodes.map((n) => {
                    const p = pos.get(n.id)!;
                    const dim = (q && !matches(n)) || (selected && n.id !== selected && !neighbours.has(n.id));
                    const isSel = n.id === selected;
                    return (
                      <g
                        key={n.id}
                        transform={`translate(${p.x} ${p.y})`}
                        opacity={dim ? 0.2 : 1}
                        style={{ cursor: "pointer" }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => setSelected(isSel ? undefined : n.id)}
                        onPointerEnter={() => setHover({ id: n.id, x: p.x, y: p.y })}
                        onPointerLeave={() => setHover(undefined)}
                      >
                        {/* Hit target bigger than the mark. */}
                        <circle r={14} fill="transparent" />
                        <circle
                          r={isSel ? 9 : 7}
                          fill={n.ended ? "var(--bg2)" : labelColor.get(n.label)}
                          stroke={n.ended ? labelColor.get(n.label) : "var(--bg2)"}
                          strokeWidth={2}
                          strokeDasharray={n.ended ? "2 2" : undefined}
                        />
                        {(isSel || neighbours.has(n.id) || (q && matches(n)) || snap.nodes.length <= 24) && (
                          <text
                            x={11}
                            y={4}
                            fontSize={11}
                            fill="var(--fg2)"
                            stroke="var(--bg2)"
                            strokeWidth={3}
                            paintOrder="stroke"
                            style={{ pointerEvents: "none" }}
                            className={n.ended ? "ended" : ""}
                          >
                            {short(n.title, isSel ? 48 : 22)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
                {hovered && hover && (
                  <foreignObject
                    x={Math.min(view.x + (W / 2) * (1 - view.s) + hover.x * view.s + 12, W - 250)}
                    y={Math.max(view.y + (H / 2) * (1 - view.s) + hover.y * view.s - 10, 4)}
                    width={240}
                    height={120}
                    style={{ pointerEvents: "none" }}
                  >
                    <div className="card" style={{ fontSize: 12, padding: "6px 8px", boxShadow: "0 2px 8px rgba(0,0,0,.15)" }}>
                      <div className="row">
                        <span className="swatch" style={{ background: labelColor.get(hovered.label) }} />
                        <strong>{hovered.label}</strong>
                        {hovered.ended && <span className="pill">ended</span>}
                      </div>
                      <div>{short(hovered.title, 110)}</div>
                    </div>
                  </foreignObject>
                )}
              </svg>
            )}
            <div className="zoom">
              <button aria-label="Zoom in" onClick={() => setView({ ...view, s: Math.min(4, view.s * 1.25) })}>
                +
              </button>
              <button aria-label="Zoom out" onClick={() => setView({ ...view, s: Math.max(0.3, view.s / 1.25) })}>
                −
              </button>
              <button aria-label="Reset view" onClick={() => setView({ x: 0, y: 0, s: 1 })}>
                ⤾
              </button>
            </div>
          </div>
          <div className="legend">
            {snap.schema.nodes.map((n) => (
              <span key={n.label}>
                <span className="swatch" style={{ background: labelColor.get(n.label) }} />
                {n.label}
              </span>
            ))}
            {snap.schema.relationships.map((r) => (
              <span key={r.type} title={r.description}>
                <svg width="18" height="6" aria-hidden>
                  <line x1="0" y1="3" x2="18" y2="3" stroke="var(--fg3)" strokeWidth="2" strokeDasharray={dashOf.get(r.type)} />
                </svg>
                {r.type}
              </span>
            ))}
            {snap.schema.time?.ended && (
              <span>
                <span className="swatch" style={{ border: "1.5px dashed var(--fg3)" }} /> ended
              </span>
            )}
          </div>
          {snap.truncated && <p className="faint">Showing the most recent items only.</p>}
        </div>

        <div className="side">
          {sel ? (
            <div className="card">
              <div className="spread">
                <div className="row">
                  <span className="swatch" style={{ background: labelColor.get(sel.label) }} />
                  <strong>{sel.label}</strong>
                  {sel.ended && <span className="pill">ended</span>}
                </div>
                <button className="link" onClick={() => setSelected(undefined)}>
                  Close
                </button>
              </div>
              <p className={sel.ended ? "ended" : ""} style={{ margin: "6px 0" }}>
                {sel.title}
              </p>
              <dl className="kv">
                {Object.entries(sel.props)
                  .filter(([k, v]) => v !== null && v !== undefined && v !== "" && k !== "text")
                  .map(([k, v]) => (
                    <div key={k} style={{ display: "contents" }}>
                      <dt>{k.replace(/_/g, " ")}</dt>
                      <dd>{typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? when(v) : String(v)}</dd>
                    </div>
                  ))}
              </dl>
              <h2>Links</h2>
              <div className="list">
                {snap.edges
                  .filter((e) => e.source === sel.id || e.target === sel.id)
                  .map((e, i) => {
                    const out = e.source === sel.id;
                    const other = nodeById.get(out ? e.target : e.source);
                    return (
                      <button key={i} className="link" style={{ textAlign: "left", whiteSpace: "normal" }} onClick={() => other && setSelected(other.id)}>
                        <span className="faint">{out ? `${e.type} →` : `← ${e.type}`}</span> {other ? short(other.title, 60) : "?"}
                      </button>
                    );
                  })}
              </div>
            </div>
          ) : (
            <div className="card" style={{ maxHeight: 460, overflow: "auto" }}>
              <h2 style={{ marginTop: 0 }}>Items {q && <span className="faint">({listed.length})</span>}</h2>
              {listed.length === 0 && <p className="empty">No items match.</p>}
              <div className="list">
                {listed.slice(0, 100).map((n) => (
                  <button key={n.id} className="link" style={{ textAlign: "left", whiteSpace: "normal", color: "var(--fg)" }} onClick={() => setSelected(n.id)}>
                    <span className="swatch" style={{ background: labelColor.get(n.label), marginRight: 6 }} />
                    <span className={n.ended ? "ended" : ""}>{short(n.title, 80)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {error && <p className="notice bad">{error}</p>}
    </div>
  );
}
