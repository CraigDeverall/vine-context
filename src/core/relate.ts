// Loads @relate/relate with the preview features we need.
//
// COMBINE (hybrid vector + full-text search) is behind a preview gate in
// Relate 1.0, and the gate is read when the native library loads. So nothing
// may import "@relate/relate" statically: use loadRelate().

export type RelateModule = Awaited<typeof import("@relate/relate")>;

let loaded: Promise<RelateModule> | undefined;

export function loadRelate(): Promise<RelateModule> {
  if (!loaded) {
    const previews = new Set((process.env.RELATE_PREVIEW ?? "").split(",").filter(Boolean));
    previews.add("hybrid-search");
    process.env.RELATE_PREVIEW = [...previews].sort().join(",");
    loaded = import("@relate/relate");
  }
  return loaded;
}

export type { Connection, Database } from "@relate/relate";
