// Text embedders for the model's vector index.
//
// Only the host embeds: it is the single writer, so every vector in a graph
// comes from the same embedder. The graph records which one, and refuses to
// open with a different one.

import { createHash } from "node:crypto";

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

export function makeEmbedder(name = process.env.VINE_EMBEDDER): Embedder {
  if (!name || name === "hash" || name === "hash-256") return new HashEmbedder();
  throw new Error(`Unknown embedder '${name}'. Available: hash.`);
}
