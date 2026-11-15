import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The source (src/…) and the bundle (dist/) sit at different depths, so walk
// up to this package's own package.json.
let root: string | undefined;

export function packageRoot(): string {
  if (root) return root;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = join(dir, "package.json");
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name === "p2p-context-graph") return (root = dir);
    const parent = dirname(dir);
    if (parent === dir) throw new Error("p2p-context-graph's package.json not found");
    dir = parent;
  }
}

export function packageInfo(): { name: string; version: string } {
  return JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8"));
}
