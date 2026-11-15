// Checking a model pack: its files against the pack format, then a trial run
// on a scratch graph. Opening the graph applies the model's constraints,
// indexes and migrations; then every tool runs once with sample input, writes
// first so the reads have something to find. A tool whose own checks refuse
// the sample (an `_error` row) still ran its Cypher, so that counts as working.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Graph, QueryError, ToolError } from "./graph.js";
import { HashEmbedder } from "./embed.js";
import { loadPack, PackError, type InputSpecT, type ToolSpec } from "./pack.js";

export interface ToolCheck {
  tool: string;
  kind: "read" | "write";
  outcome: "ran" | "refused-sample" | "failed";
  message?: string;
}

export interface ValidationReport {
  ok: boolean;
  dir: string;
  /** Problems with the pack's files, if any; then no trial run happens. */
  errors: string[];
  model?: { name: string; version: number; title: string; nodes: string[]; relationships: string[] };
  tools: ToolCheck[];
}

const ID_LIKE = /^[a-z]{1,8}_[a-z0-9]{8}$/;

function collectIds(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    if (ID_LIKE.test(value) && !into.includes(value)) into.push(value);
  } else if (Array.isArray(value)) value.forEach((v) => collectIds(v, into));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectIds(v, into));
}

function sample(name: string, spec: InputSpecT, ids: string[], nth: number): unknown {
  if (spec.default !== undefined) return spec.default;
  switch (spec.type) {
    case "string":
      return `Sample ${name.replace(/_/g, " ")} for checking the pack`.slice(0, spec.max_length ?? 200);
    case "id":
      return ids.length ? ids[nth % ids.length] : "x_missing0";
    case "integer":
    case "number":
      return Math.min(Math.max(1, spec.min ?? 1), spec.max ?? 1);
    case "boolean":
      return false;
    case "date":
      return "2026-01-01";
    case "datetime":
      return new Date().toISOString();
    case "enum":
      return spec.values![0];
    case "array":
      return spec.items === "id" && ids.length ? [ids[nth % ids.length]] : [];
  }
}

function sampleArgs(tool: ToolSpec, ids: string[], offset: number): Record<string, unknown> {
  // Successive id inputs get different ids (newest first), so a link isn't to itself.
  const newest = [...ids].reverse();
  let nth = offset;
  return Object.fromEntries(Object.entries(tool.input).map(([n, s]) => [n, sample(n, s, newest, s.type === "id" || s.items === "id" ? nth++ : 0)]));
}

export async function validatePack(dir: string): Promise<ValidationReport> {
  let pack;
  try {
    pack = loadPack(dir);
  } catch (e) {
    return { ok: false, dir, errors: [(e as Error).message], tools: [] };
  }
  const report: ValidationReport = {
    ok: true,
    dir: pack.dir,
    errors: [],
    model: {
      name: pack.model.name,
      version: pack.model.version,
      title: pack.model.title,
      nodes: Object.keys(pack.model.nodes),
      relationships: Object.keys(pack.model.relationships),
    },
    tools: [],
  };
  const scratch = mkdtempSync(join(tmpdir(), "p2pcg-validate-"));
  try {
    let graph: Graph;
    try {
      graph = await Graph.open({ name: "validate", dataDir: scratch, model: pack.dir, embedder: new HashEmbedder() });
    } catch (e) {
      report.ok = false;
      report.errors.push(`Applying the model failed: ${(e as Error).message}`);
      return report;
    }
    const ids: string[] = [];
    const order = [...graph.tools.filter((t) => t.kind === "write"), ...graph.tools.filter((t) => t.kind === "read")];
    // Two rounds of writes, so tools that link two items have two to link.
    const runs = [...order.filter((t) => t.kind === "write"), ...order];
    const seen = new Map<string, ToolCheck>();
    for (const tool of runs) {
      let check!: ToolCheck;
      // A refused sample is tried again with other ids, in case it needs a different kind of item.
      const tries = Object.values(tool.input).some((s) => s.type === "id" || s.items === "id") ? Math.min(Math.max(ids.length, 1), 4) : 1;
      for (let offset = 0; offset < tries; offset++) {
        try {
          const result = await graph.call(tool.name, sampleArgs(tool, ids, offset), { id: "validator", role: "admin" });
          collectIds(result, ids);
          check = { tool: tool.name, kind: tool.kind, outcome: "ran" };
          break;
        } catch (e) {
          const failed = e instanceof QueryError || !(e instanceof ToolError);
          check = { tool: tool.name, kind: tool.kind, outcome: failed ? "failed" : "refused-sample", message: (e as Error).message };
          if (failed) break;
        }
      }
      // Keep the best outcome across rounds.
      const prev = seen.get(tool.name);
      const rank = { failed: 0, "refused-sample": 1, ran: 2 } as const;
      if (!prev || rank[check.outcome] > rank[prev.outcome]) seen.set(tool.name, check);
    }
    report.tools = order.map((t) => seen.get(t.name)!);
    report.ok = report.tools.every((t) => t.outcome !== "failed");
    return report;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function formatReport(r: ValidationReport): string {
  if (r.errors.length && !r.model) return r.errors.join("\n");
  const lines = [
    `${r.ok ? "ok  " : "FAIL"}  ${r.model!.name} v${r.model!.version} (${r.model!.title}): ${r.model!.nodes.length} node types, ${r.tools.length} tools`,
    ...r.errors.map((e) => `      ${e}`),
    ...r.tools.map((t) => `      ${t.outcome === "failed" ? "FAIL" : t.outcome === "ran" ? "ran " : "ran*"} ${t.tool} (${t.kind})${t.message ? `: ${t.message.split("\n")[0]}` : ""}`),
  ];
  if (r.tools.some((t) => t.outcome === "refused-sample")) lines.push("      * its own checks refused the sample input: the Cypher up to that check ran, the rest did not");
  return lines.join("\n");
}

export { PackError };
