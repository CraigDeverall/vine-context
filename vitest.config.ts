import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests never touch the real data folder, even where a test forgets to pass one.
const VINE_DATA_DIR = mkdtempSync(join(tmpdir(), "vine-test-data-"));

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, globalSetup: ["test/global-setup.ts"], env: { VINE_NO_OPEN: "1", VINE_AUTO_SHARE: "off", VINE_DATA_DIR } },
});
