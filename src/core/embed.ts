// Text embedders for the model's vector index.
//
// Every machine embeds its own copy of a graph from the text, so vectors never
// travel between peers and two members may use different embedders. The graph
// records which one made its vectors; opening it with another rebuilds them.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { packageRoot } from "./package-root.js";

// Words too common to help a search. Without this, "when is the release?"
// matches every text that contains "is" or "the".
const STOP_WORDS = new Set(
  (
    "a an and are as at be but by did do does for from had has have how in is it its of on or " +
    "that the their this to was were what when where which who whom why will with"
  ).split(" "),
);

/** The lower-case words of a text, without the common ones. Falls back to all words. */
export function contentWords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const kept = words.filter((w) => !STOP_WORDS.has(w));
  return kept.length ? kept : words;
}

export interface Embedder {
  readonly name: string;
  readonly dim: number;
  /** A unit-length vector, or null when the text has nothing to embed. */
  embed(text: string): number[] | null;
}

/**
 * Hashes words and three-letter fragments into a fixed-size vector. Needs no
 * model download and works offline, but matches shared words and fragments,
 * not meaning.
 */
export class HashEmbedder implements Embedder {
  readonly name = "hash-256";
  readonly dim = 256;

  embed(text: string): number[] | null {
    const vec = new Array<number>(this.dim).fill(0);
    for (const word of contentWords(text)) {
      this.add(vec, "w:" + word, 1.0);
      const padded = `^${word}$`;
      for (let i = 0; i < padded.length - 2; i++) this.add(vec, "t:" + padded.slice(i, i + 3), 0.3);
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) return null;
    return vec.map((v) => v / norm);
  }

  private add(vec: number[], feature: string, weight: number): void {
    const n = createHash("sha256").update(feature).digest().readBigUInt64BE(0);
    const sign = n & 1n ? 1.0 : -1.0;
    const i = Number((n >> 1n) % BigInt(this.dim));
    vec[i] = (vec[i] ?? 0) + sign * weight;
  }
}

interface ModelSpec {
  /** The name recorded in the graph. It changes whenever the vectors would. */
  name: string;
  dim: number;
  dir: string;
  file: string;
  pooling: "cls" | "mean";
}

/** The sentence models the native embedder can run, by the short name used in VINE_EMBEDDER. */
export const MODELS: Record<string, ModelSpec> = {
  "bge-small": { name: "bge-small-en-v1.5-int8", dim: 384, dir: "bge-small-en-v1.5", file: "model_quantized.onnx", pooling: "cls" },
  minilm: { name: "all-MiniLM-L6-v2-int8", dim: 384, dir: "all-MiniLM-L6-v2", file: "model_quantized.onnx", pooling: "mean" },
};

/** Texts longer than this many tokens are cut; claims and questions are far shorter. */
const MAX_TOKENS = 256;

interface NativeModel {
  embed(text: string): Float32Array;
}

/** The npm package that holds the prebuilt addon and model for this machine. */
export function platformPackage(): string {
  return `vine-context-embedder-${process.platform}-${process.arch}`;
}

/**
 * Where the native addon and its models are. In order: VINE_EMBEDDER_DIR, the
 * platform package if it is installed beside vine-context, then the folder
 * `npm run build:embedder` fills in a checkout.
 */
export function embedderDir(): string {
  if (process.env.VINE_EMBEDDER_DIR) return process.env.VINE_EMBEDDER_DIR;
  try {
    return dirname(createRequire(join(packageRoot(), "package.json")).resolve(`${platformPackage()}/package.json`));
  } catch {
    return join(packageRoot(), "native", "embedder", "dist");
  }
}

/**
 * A small sentence model run on the CPU by the Rust addon in native/embedder.
 * It matches meaning, not only shared words. Optional: it needs the addon
 * built for this machine and the model's files beside it.
 */
export class ModelEmbedder implements Embedder {
  readonly name: string;
  readonly dim: number;
  private model?: NativeModel;

  constructor(
    private readonly spec: ModelSpec,
    private readonly dir = embedderDir(),
  ) {
    this.name = spec.name;
    this.dim = spec.dim;
    const missing = [join(dir, "embedder.node"), join(dir, "models", spec.dir, spec.file), join(dir, "models", spec.dir, "tokenizer.json")].filter(
      (f) => !existsSync(f),
    );
    if (missing.length)
      throw new Error(
        `The '${spec.name}' embedder is not installed on this machine (missing ${missing[0]}). ` +
          `Install ${platformPackage()} beside vine-context, or build it with \`npm run build:embedder\` in a vine-context checkout, ` +
          "or unset VINE_EMBEDDER to use the built-in one.",
      );
  }

  embed(text: string): number[] | null {
    if (!contentWords(text).length) return null;
    // Loading takes a few hundred milliseconds, so it waits for the first text.
    this.model ??= this.load();
    return Array.from(this.model.embed(text));
  }

  private load(): NativeModel {
    const addon = createRequire(import.meta.url)(join(this.dir, "embedder.node")) as {
      Model: new (dir: string, file: string, pooling: string, maxTokens: number) => NativeModel;
    };
    return new addon.Model(join(this.dir, "models", this.spec.dir), this.spec.file, this.spec.pooling, MAX_TOKENS);
  }
}

/** The embedder named by VINE_EMBEDDER: `hash` (the default), or a model's short or recorded name. */
export function makeEmbedder(name = process.env.VINE_EMBEDDER): Embedder {
  if (!name || name === "hash" || name === "hash-256") return new HashEmbedder();
  const spec = MODELS[name] ?? Object.values(MODELS).find((m) => m.name === name);
  if (spec) return new ModelEmbedder(spec);
  throw new Error(`Unknown embedder '${name}'. Available: hash, ${Object.keys(MODELS).join(", ")}.`);
}
