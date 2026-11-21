// The context model: a folder that defines a graph's shape, its tools and the
// instructions agents follow. p2p-context-graph ships one, Claims and
// Questions (models/temporal-claims), and every graph uses it.
//
// Read tools are Cypher in tools.yaml. Write tools in tools.yaml only check
// the input against the graph (their steps return `_error`); the write itself
// becomes a signed change (`apply` names its kind), applied by src/core/graph.ts
// the same way on every member's machine.
//
//   model.yaml        nodes, relationships, the searchable set
//   tools.yaml        named operations: input schema, derived params, Cypher steps
//   instructions.md   what to record and how to query, for the agent
//   migrations/*.cypher  optional, applied once each, in name order

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { packageRoot } from "./package-root.js";

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a Cypher identifier");
const toolName = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, "must be snake_case, up to 48 characters");

const PropertySpec = z.object({
  type: z.enum(["string", "integer", "number", "boolean", "date", "datetime", "id", "list"]),
  description: z.string().optional(),
  required: z.boolean().default(false),
});

const NodeSpec = z.object({
  description: z.string(),
  key: identifier.optional(),
  /** The property shown as the node's label in views. Default: the search text, else the key. */
  title: identifier.optional(),
  properties: z.record(identifier, PropertySpec).default({}),
});

const RelSpec = z.object({
  description: z.string(),
  from: z.array(identifier).min(1),
  to: z.array(identifier).min(1),
});

export const ModelSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.number().int().positive(),
    title: z.string(),
    description: z.string(),
    nodes: z.record(identifier, NodeSpec),
    relationships: z.record(identifier, RelSpec).default({}),
    search: z
      .object({
        labels: z.array(identifier).min(1),
        text: identifier,
      })
      .optional(),
    /**
     * Which properties hold time, so views can show the graph as it stood at
     * any moment. `recorded` is on nodes and relationships; `ended`, if set, is
     * when a node stopped being current.
     */
    time: z.object({ recorded: identifier, ended: identifier.optional() }).optional(),
  })
  .superRefine((m, ctx) => {
    const labels = new Set(Object.keys(m.nodes));
    for (const [type, rel] of Object.entries(m.relationships))
      for (const l of [...rel.from, ...rel.to])
        if (!labels.has(l)) ctx.addIssue({ code: "custom", path: ["relationships", type], message: `unknown node label ${l}` });
    for (const l of m.search?.labels ?? [])
      if (!labels.has(l)) ctx.addIssue({ code: "custom", path: ["search", "labels"], message: `unknown node label ${l}` });
    for (const [label, node] of Object.entries(m.nodes))
      for (const p of [node.key, node.title])
        if (p && !(p in node.properties)) ctx.addIssue({ code: "custom", path: ["nodes", label], message: `${p} is not one of its properties` });
  });

type InputType = z.infer<typeof InputBase>["type"];
const InputBase = z.object({
  type: z.enum(["string", "integer", "number", "boolean", "date", "datetime", "id", "enum", "array"]),
  description: z.string(),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  values: z.array(z.string()).optional(),
  items: z.enum(["string", "integer", "number", "boolean", "date", "datetime", "id"]).optional(),
  max_length: z.number().int().positive().optional(),
  max: z.number().optional(),
  min: z.number().optional(),
});
const InputSpec = InputBase.superRefine((s, ctx) => {
  if (s.type === "enum" && !s.values?.length) ctx.addIssue({ code: "custom", message: "enum needs values" });
  if (s.type === "array" && !s.items) ctx.addIssue({ code: "custom", message: "array needs items" });
});

/** Parameters the server computes. Callers can never set these. */
const Derive = z.union([
  z.object({ embed: identifier }).strict(), // a vector of an input's text
  z.object({ terms: identifier }).strict(), // an input's text as plain search words
  z.object({ new_id: z.string().regex(/^[a-z]{1,8}$/) }).strict(), // a fresh id with this prefix
]);

const Step = z.object({
  cypher: z.string().min(1),
  /** Key for this step's rows in the result. Unnamed steps return nothing, except the last. */
  name: identifier.optional(),
  single: z.boolean().default(false),
});

export const ToolSchema = z.object({
  name: toolName,
  title: z.string().optional(),
  description: z.string().min(10),
  kind: z.enum(["read", "write"]),
  role: z.enum(["reader", "contributor", "admin"]).optional(),
  input: z.record(identifier, InputSpec).default({}),
  derive: z.record(identifier, Derive).default({}),
  steps: z.array(Step).min(1),
  /** A built-in view that shows this tool's result: receipt (for writes) or conflicts (pairs of items). */
  view: z.enum(["receipt", "conflicts"]).optional(),
  /** For write tools: the kind of change it makes. Its steps only check the input. */
  apply: z.enum(["claim", "question", "reply", "link", "withdraw"]).optional(),
  /** How to undo a write from its receipt: call `tool` with { [arg]: result[field] }. */
  undo: z.object({ tool: toolName, arg: identifier.default("id"), field: identifier.default("id") }).optional(),
});

/** Parameter names the server sets on every call. */
export const SERVER_PARAMS = ["now", "by", "key", "role"] as const;

/** Tool names the server provides itself. */
export const RESERVED_TOOL_NAMES = [
  "context_info",
  "context_activity",
  "model_guide",
  "describe_context",
  "set_my_name",
  "share_context",
  "stop_sharing",
  "start_sharing",
  "sharing_status",
  "revoke_invite",
  "set_peer_role",
  "remove_peer",
  "join_context",
  "use_context",
  "add_context",
  "remove_context",
  "link_folder",
  "take_back",
  "open_console",
  "explore_context",
  "browser_view",
] as const;

export const ToolsFileSchema = z.object({
  fragments: z.record(identifier, z.string()).default({}),
  tools: z.array(ToolSchema).min(1),
});

export type Model = z.infer<typeof ModelSchema>;
export type ToolSpec = z.infer<typeof ToolSchema> & { role: "reader" | "contributor" | "admin" };
export type InputSpecT = z.infer<typeof InputSpec>;

export interface Pack {
  dir: string;
  model: Model;
  tools: ToolSpec[];
  instructions: string;
  migrations: { name: string; cypher: string }[];
}

export class PackError extends Error {}

/** Expands {{fragment arg1 arg2}}: the fragment's text with %1, %2 … replaced by the arguments. */
export function expandFragments(text: string, fragments: Record<string, string>, depth = 0): string {
  if (depth > 5) throw new PackError("fragments nest more than 5 deep");
  return text.replace(/\{\{\s*([A-Za-z_]\w*)((?:\s+[A-Za-z_$][\w.$]*)*)\s*\}\}/g, (_, name: string, args: string) => {
    const body = fragments[name];
    if (body === undefined) throw new PackError(`unknown fragment {{${name}}}`);
    const list = args.trim() ? args.trim().split(/\s+/) : [];
    const filled = body.replace(/%(\d)/g, (m, i: string) => list[Number(i) - 1] ?? m);
    return `(${expandFragments(filled, fragments, depth + 1).trim()})`;
  });
}

function readYaml(file: string): unknown {
  try {
    return parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    throw new PackError(`${file}: ${(e as Error).message}`);
  }
}

function formatIssues(file: string, error: z.ZodError): string {
  return `${file}:\n` + error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

export function loadPack(dir: string): Pack {
  const abs = resolve(dir);
  if (!existsSync(join(abs, "model.yaml"))) throw new PackError(`${abs} has no model.yaml`);
  const modelResult = ModelSchema.safeParse(readYaml(join(abs, "model.yaml")));
  if (!modelResult.success) throw new PackError(formatIssues("model.yaml", modelResult.error));
  const toolsResult = ToolsFileSchema.safeParse(readYaml(join(abs, "tools.yaml")));
  if (!toolsResult.success) throw new PackError(formatIssues("tools.yaml", toolsResult.error));
  const { fragments, tools } = toolsResult.data;

  const seen = new Set<string>();
  const problems: string[] = [];
  const expanded: ToolSpec[] = tools.map((t) => {
    if (seen.has(t.name)) problems.push(`tool ${t.name} is defined twice`);
    if ((RESERVED_TOOL_NAMES as readonly string[]).includes(t.name)) problems.push(`${t.name} is a built-in tool name`);
    seen.add(t.name);
    for (const p of Object.keys(t.derive)) {
      if (p in t.input) problems.push(`${t.name}: derived parameter ${p} is also an input`);
      const d = t.derive[p]!;
      const source = "embed" in d ? d.embed : "terms" in d ? d.terms : undefined;
      if (source && !(source in t.input)) problems.push(`${t.name}: ${p} derives from unknown input ${source}`);
      if ("embed" in d && !modelResult.data.search) problems.push(`${t.name}: embeds text but model.yaml has no search section`);
    }
    for (const p of SERVER_PARAMS)
      if (p in t.input || p in t.derive) problems.push(`${t.name}: ${p} is set by the server and cannot be an input`);
    let steps = t.steps;
    try {
      steps = t.steps.map((s) => ({ ...s, cypher: expandFragments(s.cypher, fragments) }));
    } catch (e) {
      problems.push(`${t.name}: ${(e as Error).message}`);
    }
    return { ...t, steps, role: t.role ?? (t.kind === "read" ? "reader" : "contributor") };
  });
  for (const t of expanded) {
    if (t.kind === "write" && !t.apply) problems.push(`${t.name}: write tools name the change they make (apply)`);
    if (t.undo && !seen.has(t.undo.tool)) problems.push(`${t.name}: undo tool ${t.undo.tool} is not defined`);
    if (t.undo && t.kind !== "write") problems.push(`${t.name}: only write tools can be undone`);
  }
  if (problems.length) throw new PackError("tools.yaml:\n" + problems.map((p) => `  - ${p}`).join("\n"));

  const instructionsFile = join(abs, "instructions.md");
  const instructions = existsSync(instructionsFile) ? readFileSync(instructionsFile, "utf8") : "";
  const migDir = join(abs, "migrations");
  const migrations = existsSync(migDir)
    ? readdirSync(migDir)
        .filter((f) => f.endsWith(".cypher"))
        .sort()
        .map((name) => ({ name, cypher: readFileSync(join(migDir, name), "utf8") }))
    : [];
  return { dir: abs, model: modelResult.data, tools: expanded, instructions, migrations };
}

/** The packs that ship with p2p-context-graph. */
export function builtinPacksDir(): string {
  return join(packageRoot(), "models");
}

let claims: Pack | undefined;
/** The one model every graph uses: Claims and Questions. */
export function claimsPack(): Pack {
  return (claims ??= loadPack(join(builtinPacksDir(), "temporal-claims")));
}

export type { InputType };
