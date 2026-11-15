// The MCP App views are served from dist/apps; build them once per test run.
import { execFileSync } from "node:child_process";

export default function setup() {
  execFileSync(process.execPath, ["scripts/build-apps.mjs"], { stdio: "ignore" });
}
