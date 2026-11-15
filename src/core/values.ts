// Turns Relate result values into plain JSON for tool results.

import type { RelateModule } from "./relate.js";

type Int = number | bigint;
const pad = (n: Int, w = 2) => String(Math.abs(Number(n))).padStart(w, "0");
function offset(i: Int): string {
  const s = Number(i);
  if (s === 0) return "Z";
  const a = Math.abs(s);
  return `${s < 0 ? "-" : "+"}${pad(Math.floor(a / 3600))}:${pad(Math.floor((a % 3600) / 60))}`;
}
const fraction = (ns: Int) => (Number(ns) ? "." + String(ns).padStart(9, "0").replace(/0+$/, "") : "");

/** Property names never returned to agents: vectors are large and meaningless to read. */
const HIDDEN = new Set(["embedding"]);

export function toJson(value: unknown, R: RelateModule): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => toJson(v, R));
  if (value instanceof R.CypherDate) return `${value.year}-${pad(value.month)}-${pad(value.day)}`;
  if (value instanceof R.CypherDateTime)
    return `${value.year}-${pad(value.month)}-${pad(value.day)}T${pad(value.hour)}:${pad(value.minute)}:${pad(value.second)}${fraction(value.nanosecond)}${offset(value.offsetSeconds)}`;
  if (value instanceof R.CypherLocalDateTime)
    return `${value.year}-${pad(value.month)}-${pad(value.day)}T${pad(value.hour)}:${pad(value.minute)}:${pad(value.second)}${fraction(value.nanosecond)}`;
  if (value instanceof R.CypherFloat) return value.value;
  if (value instanceof R.CypherVector) return "[vector]";
  const v = value as Record<string, unknown>;
  if (v.kind === "node") return { labels: v.labels, ...(toJson(v.properties, R) as object) };
  if (v.kind === "relationship") return { type: v.type, ...(toJson(v.properties, R) as object) };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (!HIDDEN.has(k)) out[k] = toJson(x, R);
  return out;
}
