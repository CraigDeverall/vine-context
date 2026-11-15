import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The source (src/cli) and the bundle (dist) sit at different depths, so walk
// up to the package's own package.json.
function readPackage(): { name: string; version: string } {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = join(dir, "package.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    const parent = dirname(dir);
    if (parent === dir) throw new Error("package.json not found");
    dir = parent;
  }
}

const pkg = readPackage();

const [command] = process.argv.slice(2);

switch (command) {
  case "--version":
  case "-v":
    console.log(pkg.version);
    break;
  default:
    console.log(`p2pcg ${pkg.version}

Usage: p2pcg <command>

Commands (planned):
  mcp            Run the MCP server (stdio)
  host           Host a context graph and print a join link
  join <link>    Join a shared context graph
  model ...      Validate, install and list model packs`);
}
