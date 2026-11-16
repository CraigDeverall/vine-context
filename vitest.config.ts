import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests never touch the real data folder, even where a test forgets to pass one.
const P2PCG_DATA_DIR = mkdtempSync(join(tmpdir(), "p2pcg-test-data-"));

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, globalSetup: ["test/global-setup.ts"], env: { P2PCG_NO_OPEN: "1", P2PCG_AUTO_SHARE: "off", P2PCG_DATA_DIR } },
});
